/**
 * Bear side — mandatory regression tests for the execution/state bugs found in the 2026-11-21 reviews.
 * Each test pins one real bug so it can't silently come back.
 */
jest.mock('../src/config/database', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('axios');
jest.mock('../src/services/brokerService', () => ({ sellMarket: jest.fn(), buyMarket: jest.fn() }));
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn(async () => {}) }));

const axios = require('axios');
const { query } = require('../src/config/database');
const broker = require('../src/services/brokerService');
const bear = require('../src/services/bearSideService');

const client = { headers: {} };
beforeEach(() => { jest.clearAllMocks(); query.mockImplementation(async () => ({ rows: [] })); });

describe('regression: regime', () => {
    const now = new Date('2026-11-24T16:00:00Z');
    test('bug 1 — BULL_MILD and BULL_STRONG close the bear book (plain BULL is never reported)', () => {
        for (const t of ['BULL_MILD', 'BULL_STRONG']) expect(bear.regimeDecision({ regimeType: t, lastBearAt: now, now })).toMatchObject({ hold: false, enter: false });
    });
    test('bug 4 — stale or fallback data never authorises entries', () => {
        expect(bear.regimeDecision({ regimeType: 'BEAR', stale: true, bearSince: new Date(now - 48 * 3600000), now }).enter).toBe(false);
        expect(bear.regimeStale({ regimeType: 'NEUTRAL', spyPrice: null }, now)).toBe(true);
        expect(bear.regimeStale({ regimeType: 'BEAR', spyPrice: 650, timestamp: new Date(now - 7 * 3600000).toISOString() }, now)).toBe(true);
    });
});

describe('regression: exits are confirmed by the broker, not by submitting an order', () => {
    test('bug 2 — a partially filled hedge sell stays pending_close, never closed', async () => {
        broker.sellMarket.mockResolvedValue({ orderId: 'h1', filledQty: 4, filledAvgPrice: 30, status: 'partially_filled' });
        const res = await bear._internal.closeHedge('u', { id: 7, symbol: 'SH', entry_price: 31, qty: 10 }, 'BULL_MILD: close', 30, 10);
        expect(res).toMatchObject({ pendingClose: true, filled: 4 });
        const sqls = query.mock.calls.map(c => c[0]);
        expect(sqls.some(q => /status = 'pending_close'/.test(q))).toBe(true);
        expect(sqls.some(q => /status = 'closed'/.test(q))).toBe(false);
    });
    test('bug 2 — an unfilled hedge sell (0 filled) is not closed either', async () => {
        broker.sellMarket.mockResolvedValue({ orderId: 'h2', filledQty: 0, status: 'accepted' });
        const res = await bear._internal.closeHedge('u', { id: 8, symbol: 'PSQ', entry_price: 20, qty: 5 }, 'stop', 19, 5);
        expect(res.pendingClose).toBe(true);
    });
    test('bug 2 — a fully filled hedge sell is closed', async () => {
        broker.sellMarket.mockResolvedValue({ orderId: 'h3', filledQty: 10, filledAvgPrice: 30, status: 'filled' });
        await bear._internal.closeHedge('u', { id: 9, symbol: 'SH', entry_price: 31, qty: 10 }, 'stop', 30, 10);
        expect(query.mock.calls.some(c => /status = 'closed'/.test(c[0]))).toBe(true);
    });

    test('bug 3 — spread close orders use the quantity the broker still holds', async () => {
        const posted = [];
        axios.get.mockImplementation(async url => {
            if (url.includes('/options/snapshots')) return { data: { snapshots: { L: { latestQuote: { bp: 5, ap: 5.2 } }, S: { latestQuote: { bp: 2, ap: 2.1 } } } } };
            if (url.endsWith('/v2/positions/S')) return { data: { qty: '-1' } };  // 2 of 3 already bought back
            if (url.endsWith('/v2/positions/L')) return { data: { qty: '3' } };
            if (url.includes('/v2/orders/')) return { data: { status: 'filled', filled_avg_price: '2.1' } };
            throw new Error('unexpected ' + url);
        });
        axios.post.mockImplementation(async (url, body) => { posted.push(body); return { data: { id: `o${posted.length}` } }; });
        await bear._internal.closeSpreadStep(client, 'u', { id: 3, symbol: 'SPY', long_contract: 'L', short_contract: 'S', qty: 3, entry_price: 7, meta: {} }, 'BULL_MILD: close');
        expect(posted[0]).toMatchObject({ symbol: 'S', qty: '1', side: 'buy', position_intent: 'buy_to_close' });
        expect(posted[1]).toMatchObject({ symbol: 'L', qty: '3', side: 'sell', position_intent: 'sell_to_close' });
    });
    test('bug 3 — unreadable broker position: no close order is sent blind', async () => {
        axios.get.mockImplementation(async url => {
            if (url.includes('/options/snapshots')) return { data: { snapshots: {} } };
            const e = new Error('timeout'); e.response = { status: 500 }; throw e;
        });
        await bear._internal.closeSpreadStep(client, 'u', { id: 4, symbol: 'QQQ', long_contract: 'L', short_contract: 'S', qty: 2, entry_price: 8, meta: {} }, 'stop');
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('a short entry cancelled after a PARTIAL fill is recorded and gets its buy-stop', async () => {
        const posted = [];
        axios.get.mockImplementation(async url => {
            if (url.includes('/v2/orders/e1')) return { data: { status: 'canceled', filled_qty: '7', filled_avg_price: '50' } };
            throw new Error('unexpected ' + url);
        });
        axios.post.mockImplementation(async (url, body) => { posted.push(body); return { data: { id: 's1' } }; });
        await bear._internal.manageShort(client, 'u', { id: 5, leg: 'short', symbol: 'XYZ', status: 'pending_open', entry_order_id: 'e1', qty: 10 }, 50, true, new Date());
        expect(posted[0]).toMatchObject({ symbol: 'XYZ', qty: '7', side: 'buy', type: 'stop', stop_price: '54', time_in_force: 'gtc' });
        expect(query.mock.calls.some(c => /status = 'not_filled'/.test(c[0]))).toBe(false);
    });
});

describe('kill switch + gap-stress limit', () => {
    test('unknown shorts at the broker are found (records are not the authority)', () => {
        const pos = [{ symbol: 'RDDT', qty: '-10', asset_class: 'us_equity' }, { symbol: 'AAPL', qty: '5', asset_class: 'us_equity' },
                     { symbol: 'SPY261231P00600000', qty: '-1', asset_class: 'us_option' }, { symbol: 'BX', qty: '-3', asset_class: 'us_equity' }];
        expect(bear.unknownShorts(pos, [{ leg: 'short', symbol: 'RDDT' }])).toEqual(['BX -3']);
    });
    test('position mismatch halts entries (critical), the halt is latching', async () => {
        axios.get.mockImplementation(async url => {
            if (url.includes('/v2/orders/st1')) return { data: { status: 'new' } };
            if (url.includes('/v2/assets/')) return { data: { shortable: true, easy_to_borrow: true } };
            if (url.includes('corporate-actions')) return { data: { corporate_actions: { cash_dividends: [] } } };
            throw new Error('unexpected ' + url);
        });
        query.mockImplementation(async sql => (/UPDATE bear_state SET halted_at/.test(sql) ? { rows: [{ user_id: 'u' }] } : { rows: [] }));
        await bear._internal.manageShort(client, 'u', { id: 6, leg: 'short', symbol: 'RDDT', status: 'open', qty: 10, entry_price: 80, stop_price: 86.4,
            stop_order_id: 'st1', opened_at: new Date() }, 80, true, new Date(), { RDDT: -6 });
        const halt = query.mock.calls.find(c => /UPDATE bear_state SET halted_at/.test(c[0]));
        expect(halt).toBeTruthy();
        expect(halt[0]).toMatch(/halted_at IS NULL/); // never overwritten / cleared by the bot
        expect(halt[1][2]).toMatch(/RDDT: record short 10, broker -6/);
    });
    test('gap stress is separate from stop risk: shorts +30%, hedges/spreads +5% market gap', () => {
        expect(bear.gapStressUsd({ shortsValue: 10000, hedgeValue: 8000, spreadDebit: 1500 })).toBe(3000 + 400 + 750);
        const f = { equity: 100000, shortsValue: 15000, hedgeValue: 0, spreadDebit: 0 }; // 4,500 already
        expect(bear._internal.gapFits(f, { shortsValue: 2000 })).toBe(true);   // 5,100 ≤ 6,000
        expect(bear._internal.gapFits(f, { shortsValue: 4000 })).toBe(false);  // 6,300 > 6,000
        expect(f.shortsValue).toBe(17000);                                        // only the fitting one booked
    });
});

describe('third review checks (2026-11-21)', () => {
    test('end to end: short 100 → 40 filled, 60 cancelled → recorded 40, stop for exactly 40, matches broker', async () => {
        const posted = [], updates = [];
        axios.get.mockImplementation(async url => {
            if (url.includes('/v2/orders/e100')) return { data: { status: 'canceled', qty: '100', filled_qty: '40', filled_avg_price: '25' } };
            throw new Error('unexpected ' + url);
        });
        axios.post.mockImplementation(async (url, body) => { posted.push(body); return { data: { id: 'stop40' } }; });
        query.mockImplementation(async (sql, params) => { updates.push({ sql, params }); return { rows: [] }; });
        const r = { id: 11, leg: 'short', symbol: 'ABC', status: 'pending_open', entry_order_id: 'e100', qty: 100 };
        await bear._internal.manageShort(client, 'u', r, 25, true, new Date());
        const open = updates.find(u => /SET status = 'open', qty = \$2/.test(u.sql));
        expect(open.params[1]).toBe(40);                                     // recorded qty = what filled
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({ symbol: 'ABC', qty: '40', side: 'buy', type: 'stop', stop_price: '27' });
        const stopRow = updates.find(u => /SET stop_price = \$2, stop_order_id = \$3/.test(u.sql));
        expect(stopRow.params).toEqual([11, 27, 'stop40']);
        // the recorded position now matches the broker's −40
        expect(bear.brokerMismatch({ leg: 'short', symbol: 'ABC', qty: open.params[1] }, { ABC: -40 })).toBeNull();
    });

    test('resume is refused while any problem remains', () => {
        const rows = [{ id: 1, leg: 'short', symbol: 'RDDT', status: 'open', qty: 10 }, { id: 2, leg: 'spread', symbol: 'SPY', status: 'open', qty: 1, long_contract: 'L', short_contract: 'S' }];
        const clean = { rows, positions: [{ symbol: 'RDDT', qty: '-10' }, { symbol: 'L', qty: '1', asset_class: 'us_option' }, { symbol: 'S', qty: '-1', asset_class: 'us_option' }],
                        stopStatus: { 1: 'new' }, equity: 100000, openRisk: 2000, gapStress: 3000 };
        expect(bear.resumeProblems(clean)).toEqual([]);
        expect(bear.resumeProblems({ ...clean, stopStatus: { 1: 'canceled' } })[0]).toMatch(/no live buy-stop/);
        expect(bear.resumeProblems({ ...clean, positions: [...clean.positions.slice(1), { symbol: 'RDDT', qty: '-6' }] })[0]).toMatch(/mismatch/);
        expect(bear.resumeProblems({ ...clean, positions: [...clean.positions, { symbol: 'BX', qty: '-3' }] })[0]).toMatch(/unknown short/);
        expect(bear.resumeProblems({ ...clean, openRisk: 6000 })[0]).toMatch(/stop-based risk/);
        expect(bear.resumeProblems({ ...clean, gapStress: 7000 })[0]).toMatch(/gap stress/);
        expect(bear.resumeProblems({ ...clean, equity: NaN })[0]).toMatch(/equity unreadable/);
    });

    test('resume: broker unreachable → refused, attempt logged with who; halt NOT cleared', async () => {
        const sqls = [];
        query.mockImplementation(async (sql, params) => {
            sqls.push({ sql, params });
            if (/SELECT halted_at, halt_reason FROM bear_state/.test(sql)) return { rows: [{ halted_at: new Date(), halt_reason: 'mismatch' }] };
            return { rows: [] };
        });
        require('../src/services/userDatabaseService').getUserAlpacaCredentials = jest.fn(async () => { throw new Error('broker down'); });
        const res = await bear.resumeBear('u', 'tester');
        expect(res).toMatchObject({ resumed: false, wasHalted: true });
        expect(res.problems[0]).toMatch(/could not reconcile/);
        const log = sqls.find(x => /INSERT INTO bear_resume_log/.test(x.sql));
        expect(log.params.slice(0, 3)).toEqual(['u', 'tester', false]);
        expect(sqls.some(x => /halted_at = NULL/.test(x.sql))).toBe(false);
    });

    test('a halt survives restarts: nothing but resumeBear ever clears halted_at', () => {
        const src = require('fs').readFileSync(require.resolve('../src/services/bearSideService'), 'utf8');
        const clears = src.split('\n').filter(l => /halted_at\s*=\s*NULL/.test(l));
        expect(clears).toHaveLength(1);
        expect(clears[0]).toMatch(/UPDATE bear_state SET halted_at = NULL, halt_reason = NULL WHERE user_id = \$1`, \[uid\]/);
    });
});

describe('costs in reported P&L (2026-11-21)', () => {
    test('a short owes dividends whose ex-date falls after the open day and on/before the close day', () => {
        const divs = [{ ex_date: '2026-11-25', rate: 0.5 }, { ex_date: '2026-11-24', rate: 0.3 }, { ex_date: '2026-12-10', rate: 0.4 }];
        // opened 11-24 (ex 11-24 already passed at the open → not owed), closed 11-25 (short at 11-24 close → owed)
        expect(bear.shortDividendsOwed(divs, { openedDay: '2026-11-24', closedDay: '2026-11-25', qty: 100 })).toEqual({ usd: 50, exDates: ['2026-11-25'] });
        expect(bear.shortDividendsOwed(divs, { openedDay: '2026-11-26', closedDay: '2026-12-01', qty: 100 }).usd).toBe(0);
    });
    test('leg metrics: dividends paid and annualised return on capital beside the T-bill rate', () => {
        const rows = [{ leg: 'short', status: 'closed', pnl: 100, qty: 100, entry_price: 50, risk_usd: 400,
                        opened_at: new Date('2026-11-01'), closed_at: new Date('2026-11-11'), meta: { dividendPaidUsd: 20 } }];
        const m = bear.legMetrics(rows, { riskFreePct: 4 }).short;
        expect(m.dividendsPaidUsd).toBe(20);
        expect(m.returnOnCapitalAnnualPct).toBe(r2(100 / (5000 * 10 / 365) * 100));
        expect(m.tbillAnnualPct).toBe(4);
    });
    const r2 = v => Math.round(v * 100) / 100;
});

describe('three P&L figures (2026-11-21)', () => {
    test('gross → adjusted → economic; borrow fees marked unavailable, not zero', () => {
        const rows = [{ leg: 'short', status: 'closed', pnl: 100, qty: 100, entry_price: 50, risk_usd: 400,
                        opened_at: new Date('2026-11-01'), closed_at: new Date('2026-11-11T00:00:00Z'), meta: { dividendPaidUsd: 20, slippagePct: 0.2 } }];
        const m = bear.legMetrics(rows).short;
        expect(m.slippageUsd).toBe(10);                    // 0.2% of $5,000
        expect(m.pnlGross).toBe(130);                      // 100 + 20 dividends + 10 slippage
        expect(m.pnlAdjusted).toBe(100);
        const capYears = 5000 * 10 / 365;
        expect(m.pnlEconomic.borrow0_5pct).toBe(Math.round((100 - capYears * 0.005) * 100) / 100);
        expect(m.pnlEconomic.borrow3pct).toBe(Math.round((100 - capYears * 0.03) * 100) / 100);
        expect(m.borrowFees).toMatch(/UNAVAILABLE/);
        expect(bear.legMetrics([{ ...rows[0], leg: 'hedge' }]).hedge.pnlEconomic).toBeNull();
    });
});
