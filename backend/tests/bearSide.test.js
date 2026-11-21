jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const bear = require('../src/services/bearSideService');
const { cashSecuredRoom } = require('../src/services/optionsIncomeService');
const { accountBreakdown } = require('../src/services/coreHoldingsService');

describe('regime gate', () => {
    const now = new Date('2026-11-20T16:00:00Z');
    test('BEAR: hold and enter', () => {
        expect(bear.regimeDecision({ regimeType: 'BEAR', bearSince: new Date(now - 20 * 3600000), now })).toMatchObject({ hold: true, enter: true });
    });
    test('PANIC: hold, but no new entries (snap-back risk)', () => {
        expect(bear.regimeDecision({ regimeType: 'PANIC', now })).toMatchObject({ hold: true, enter: false });
    });
    test('one calm reading does not flip the book', () => {
        const d = bear.regimeDecision({ regimeType: 'NEUTRAL', lastBearAt: new Date(now - 3 * 3600000), now, exitHours: 24 });
        expect(d).toMatchObject({ hold: true, enter: false });
    });
    test('not bear for longer than the exit window: close', () => {
        const d = bear.regimeDecision({ regimeType: 'BULL', lastBearAt: new Date(now - 25 * 3600000), now, exitHours: 24 });
        expect(d.hold).toBe(false);
    });
    test('never bear: nothing held', () => {
        expect(bear.regimeDecision({ regimeType: 'NEUTRAL', lastBearAt: null, now }).hold).toBe(false);
    });
});

describe('funding', () => {
    test('free cash excludes put collateral, short proceeds and the buffer', () => {
        const f = bear.fundingRoom({ cash: 30000, equity: 100000, putCollateral: 10000, shortProceeds: 5000, bufferPct: 5, capPct: 25 });
        expect(f.freeCash).toBe(10000);
        expect(f.capRoom).toBe(25000);
        expect(f.spendable).toBe(10000);
    });
    test('no free cash → nothing spendable unless margin is allowed', () => {
        const base = { cash: 16000, equity: 88000, putCollateral: 29800, bufferPct: 5, capPct: 25 };
        expect(bear.fundingRoom(base).spendable).toBe(0);
        expect(bear.fundingRoom({ ...base, margin: true }).spendable).toBe(22000);
    });
    test('gross cap limits even with margin', () => {
        expect(bear.fundingRoom({ cash: 0, equity: 100000, bearGross: 24000, margin: true, capPct: 25 }).spendable).toBe(1000);
    });
    test('sold puts: short-sale proceeds never secure a put', () => {
        expect(cashSecuredRoom({ cash: 20000, equity: 100000, reserved: 0, shortProceeds: 8000, bufferPct: 5 })).toBe(7000);
        expect(cashSecuredRoom({ cash: 20000, equity: 100000, reserved: 0, bufferPct: 5 })).toBe(15000);
    });
});

describe('short candidates', () => {
    const s = (symbol, o) => ({ symbol, c0: 50, c5: 52, c63: 70, sma50: 55, sma200: 60, dv: 1e8, ...o });
    test('downtrend only, weakest 3-month return first', () => {
        const out = bear.rankShortCandidates([
            s('AAA', { c63: 100 }),                 // −50%
            s('BBB', { c63: 60 }),                  // −17%
            s('UP', { sma50: 45, sma200: 40 }),     // above its averages — never short
            s('CHEAP', { c0: 10, c5: 11, c63: 30 }), // under $20
        ]);
        expect(out.map(x => x.symbol)).toEqual(['AAA', 'BBB']);
    });
    test('skips a stock already down >15% in 5 days (snap-back risk)', () => {
        const out = bear.rankShortCandidates([s('CRASH', { c5: 65 })]);
        expect(out).toEqual([]);
    });
    test('excludes held / protected symbols and keeps only the most liquid universe', () => {
        const out = bear.rankShortCandidates([s('HELD'), s('THIN', { dv: 1 }), s('OK')], { exclude: new Set(['HELD']), universe: 2 });
        expect(out.map(x => x.symbol)).toEqual(['OK']);
    });
});

describe('short exits', () => {
    const now = new Date('2026-11-20T16:00:00Z');
    const base = { entry: 100, stop: 108, openedAt: new Date(now - 2 * 86400000), now };
    test('take profit at −15%', () => expect(bear.shortPlan({ ...base, price: 84 }).reason).toMatch(/take profit/));
    test('time exit', () => expect(bear.shortPlan({ ...base, price: 99, openedAt: new Date(now - 22 * 86400000) }).reason).toMatch(/time exit/));
    test('regime exit', () => expect(bear.shortPlan({ ...base, price: 99, hold: false }).reason).toMatch(/regime/));
    test('stop trails down, never up', () => {
        expect(bear.shortPlan({ ...base, price: 90 }).newStop).toBe(97.2);
        expect(bear.shortPlan({ ...base, price: 101 }).newStop).toBeNull();
    });
});

describe('bear put spread', () => {
    const today = '2026-11-20';
    const q = (bp, ap) => ({ latestQuote: { bp, ap } });
    // SPY ~ 700: puts expiring 2026-12-31 (41 days)
    const snaps = {
        'SPY261231P00700000': q(17.0, 17.4),
        'SPY261231P00695000': q(15.0, 15.4),
        'SPY261231P00665000': q(8.0, 8.4),
        'SPY261231P00660000': q(7.0, 7.4),
        'SPY261231C00700000': q(15.0, 15.4), // a call — ignored
        'SPY261204P00700000': q(9.0, 9.4),   // 14 days — too short
    };
    test('buys the at-the-money put, sells ~5% lower, 30-50 days out', () => {
        const p = bear.chooseSpread(snaps, 700, today);
        expect(p.long.contract).toBe('SPY261231P00700000');
        expect(p.short.contract).toBe('SPY261231P00665000');
        expect(p.width).toBe(35);
        expect(p.debit).toBeCloseTo(9, 5);
        expect(p.limit).toBeGreaterThanOrEqual(9);
        expect(p.limit).toBeLessThanOrEqual(p.natural);
    });
    test('rejects a spread costing more than 45% of its width', () => {
        const pricey = { ...snaps, 'SPY261231P00665000': q(1.0, 1.2), 'SPY261231P00660000': q(0.9, 1.1) };
        expect(bear.chooseSpread(pricey, 700, today).none).toBe(true);
    });
    test('exits', () => {
        expect(bear.spreadPlan({ debit: 9, width: 35, value: 22.1, dte: 30 })).toMatch(/take profit/);
        expect(bear.spreadPlan({ debit: 9, width: 35, value: 4.4, dte: 30 })).toMatch(/stop/);
        expect(bear.spreadPlan({ debit: 9, width: 35, value: 10, dte: 7 })).toMatch(/expiry/);
        expect(bear.spreadPlan({ debit: 9, width: 35, value: 10, dte: 30, hold: false })).toMatch(/regime/);
        expect(bear.spreadPlan({ debit: 9, width: 35, value: 10, dte: 30 })).toBeNull();
    });
    test('parses option symbols', () => {
        expect(bear.parseOcc('QQQ261231P00600000')).toEqual({ underlying: 'QQQ', expiry: '2026-12-31', type: 'P', strike: 600 });
    });
});

describe('account breakdown with shorts', () => {
    test('a short is its own bucket and its proceeds are not free cash', () => {
        const b = accountBreakdown({
            positions: [{ symbol: 'SPY', qty: 1, marketValue: 700 }, { symbol: 'XYZ', qty: -10, marketValue: -500 }],
            coreSymbols: new Set(), equity: 1200, cash: 1000,
        });
        expect(b.shorts).toEqual({ usd: -500, pct: -41.7, count: 1 });
        expect(b.other.usd).toBe(0);
        expect(b.freeCashUsd).toBe(500);
    });
});

describe('safety pass (2026-11-20 review)', () => {
    const now = new Date('2026-11-23T16:00:00Z');
    test('BEAR must be confirmed before entries, and not while SPY bounces', () => {
        expect(bear.regimeDecision({ regimeType: 'BEAR', bearSince: new Date(now - 2 * 3600000), now }).enter).toBe(false);
        expect(bear.regimeDecision({ regimeType: 'BEAR', bearSince: new Date(now - 20 * 3600000), now, recovering: true }).enter).toBe(false);
        expect(bear.regimeDecision({ regimeType: 'BEAR', bearSince: new Date(now - 20 * 3600000), now }).enter).toBe(true);
    });
    test('BULL closes at once; PANIC never starts the exit timer', () => {
        expect(bear.regimeDecision({ regimeType: 'BULL', lastBearAt: new Date(now - 3600000), now }).hold).toBe(false);
        expect(bear.regimeDecision({ regimeType: 'PANIC', lastBearAt: new Date(now - 48 * 3600000), now }).hold).toBe(true);
    });
    test('recovery signal: +3% in 5 days or back above the 20-day average', () => {
        const falling = Array.from({ length: 25 }, (_, i) => 700 - i * 3);
        expect(bear.recoverySignal(falling).recovering).toBe(false);
        expect(bear.recoverySignal([...falling.slice(0, 24), 700]).recovering).toBe(true); // jumped above sma20
        expect(bear.recoverySignal([1, 2, 3]).recovering).toBe(false);
    });
    test('risk = loss to the stop (hedge/short) or the debit (spread)', () => {
        expect(bear.positionRisk({ leg: 'hedge', qty: 100, price: 40 })).toBe(240);
        expect(bear.positionRisk({ leg: 'short', qty: 10, price: 100 })).toBe(80);
        expect(bear.positionRisk({ leg: 'spread', qty: 2, debit: 5.5 })).toBe(1100);
    });
    test('risk room: total budget and per-position cap', () => {
        expect(bear.riskRoom({ equity: 100000, openRisk: 3000, totalPct: 5, tradePct: 1 })).toEqual({ total: 2000, perTrade: 1000 });
        expect(bear.riskRoom({ equity: 100000, openRisk: 4500, totalPct: 5, tradePct: 1 })).toEqual({ total: 500, perTrade: 500 });
        expect(bear.riskRoom({ equity: 100000, openRisk: 6000, totalPct: 5, tradePct: 1 }).perTrade).toBe(0);
    });
    test('RSI and squeeze filters', () => {
        const down = Array.from({ length: 40 }, (_, i) => 100 - i);   // straight down → RSI 0
        expect(bear.shortQuality(down).ok).toBe(false);
        expect(bear.shortQuality(down).reason).toMatch(/oversold/);
        const zig = Array.from({ length: 40 }, (_, i) => 100 - i * 0.5 + (i % 2 ? 1.2 : 0)); // choppy decline
        expect(bear.shortQuality(zig).ok).toBe(true);
        const squeeze = [...zig.slice(0, 35), zig[34] * 1.1, ...zig.slice(36)];
        expect(bear.shortQuality(squeeze).reason).toMatch(/squeeze/);
    });
    test('shorts must be weaker than SPY and liquid enough', () => {
        const s = (symbol, o) => ({ symbol, c0: 50, c5: 52, c63: 70, sma50: 55, sma200: 60, dv: 1e8, ...o });
        const out = bear.rankShortCandidates([s('WEAK', { c63: 100 }), s('MKT', { c63: 55 }), s('THIN', { c63: 100, dv: 1e7 })], { spyRet63: -0.08 });
        expect(out.map(x => x.symbol)).toEqual(['WEAK']); // MKT −9% ≈ SPY −8%; THIN under $50M/day
    });
    test('spread: narrows width to fit the per-trade risk, rejects thin legs', () => {
        const q = (bp, ap) => ({ latestQuote: { bp, ap } });
        const snaps = {
            'SPY261231P00700000': q(17.0, 17.4), 'SPY261231P00665000': q(8.0, 8.4),
            'SPY261231P00672000': q(9.6, 10.0), 'SPY261231P00679000': q(11.4, 11.8), 'SPY261231P00682500': q(12.3, 12.7),
        };
        expect(bear.chooseSpread(snaps, 700, '2026-11-20').width).toBe(35);
        const narrow = bear.chooseSpread(snaps, 700, '2026-11-20', { maxDebitUsd: 750 });
        expect(narrow.width).toBeLessThan(35);
        expect(narrow.limit * 100).toBeLessThanOrEqual(750);
        const thin = { 'SPY261231P00700000': q(15.0, 19.0), 'SPY261231P00665000': q(8.0, 8.4) };
        expect(bear.chooseSpread(thin, 700, '2026-11-20').none).toBe(true);
    });
    test('broker mismatch detection', () => {
        expect(bear.brokerMismatch({ leg: 'short', symbol: 'X', qty: 10 }, { X: -10 })).toBeNull();
        expect(bear.brokerMismatch({ leg: 'short', symbol: 'X', qty: 10 }, { X: -4 })).toMatch(/broker -4/);
        const sp = { leg: 'spread', symbol: 'SPY', qty: 1, long_contract: 'L', short_contract: 'S' };
        expect(bear.brokerMismatch(sp, { L: 1, S: -1 })).toBeNull();
        expect(bear.brokerMismatch(sp, { L: 1 })).toMatch(/short 0/); // short leg missing
    });
    test('leg metrics: profit factor, expectancy, return on risk, drawdown, vs T-bills', () => {
        const d = (n) => new Date(Date.UTC(2026, 10, n));
        const rows = [
            { leg: 'short', status: 'closed', pnl: 100, risk_usd: 80, entry_price: 100, qty: 10, opened_at: d(1), closed_at: d(11), meta: { slippagePct: 0.1 } },
            { leg: 'short', status: 'closed', pnl: -50, risk_usd: 80, entry_price: 100, qty: 10, opened_at: d(1), closed_at: d(11), meta: {} },
            { leg: 'short', status: 'closed', pnl: -30, risk_usd: 80, entry_price: 100, qty: 10, opened_at: d(1), closed_at: d(11), meta: {} },
            { leg: 'short', status: 'open', pnl: null, risk_usd: 80, entry_price: 100, qty: 10, opened_at: d(12), meta: {} },
        ];
        const m = bear.legMetrics(rows, { riskFreePct: 3.65 }).short;
        expect(m).toMatchObject({ open: 1, closed: 3, wins: 1, pnl: 20, avgWin: 100, avgLoss: -40, profitFactor: 1.25, expectancy: 6.67, maxDrawdown: 80, avgSlippagePct: 0.1 });
        expect(m.returnOnRiskPct).toBe(8.33);
        expect(m.tbillSameCapital).toBe(3); // 3 × $1,000 × 10 days × 3.65%/yr
        expect(m.vsTbill).toBe(17);
    });
    test('stress: a +5% gap hurts hedges, shorts (beta 1.5) and spreads', () => {
        expect(bear.stressLoss([{ leg: 'hedge', value: 4000 }, { leg: 'short', value: 2000 }, { leg: 'spread', debitUsd: 1000 }])).toBe(200 + 150 + 500);
    });
});

describe('second review pass (2026-11-21)', () => {
    const now = new Date('2026-11-23T16:00:00Z'); // Monday 11:00 ET
    test('regime service says BULL_STRONG / BULL_MILD — both close the book', () => {
        for (const t of ['BULL_STRONG', 'BULL_MILD']) expect(bear.regimeDecision({ regimeType: t, lastBearAt: new Date(now - 3600000), now }).hold).toBe(false);
    });
    test('BEAR confirmation needs two trading sessions, not just 18 wall-clock hours', () => {
        // first seen Monday 9:35 ET → only 1.5h old and the same session: not confirmed
        expect(bear.regimeDecision({ regimeType: 'BEAR', bearSince: new Date('2026-11-23T14:35:00Z'), now }).enter).toBe(false);
        // seen Friday afternoon → Monday is a second session and >18h
        expect(bear.regimeDecision({ regimeType: 'BEAR', bearSince: new Date('2026-11-20T19:00:00Z'), now }).enter).toBe(true);
    });
    test('a stale / fallback regime reading: hold, no entries', () => {
        expect(bear.regimeDecision({ regimeType: 'BULL_MILD', stale: true })).toMatchObject({ hold: true, enter: false, stale: true });
        expect(bear.regimeStale({ spyPrice: 600, timestamp: new Date(now - 5 * 60000).toISOString() }, now)).toBe(false);
        expect(bear.regimeStale({ spyPrice: 600, timestamp: new Date(now - 3 * 3600000).toISOString() }, now)).toBe(true);
        expect(bear.regimeStale({ regimeType: 'NEUTRAL', spyPrice: null }, now)).toBe(true); // default NEUTRAL on data failure
    });
    test('dividends: announced in the hold count; special or large → skip; regular payer projected', () => {
        const today = '2026-11-23';
        const a = bear.dividendExposure([{ ex_date: '2026-12-01', rate: 0.5, special: false }], { today, price: 100 });
        expect(a).toMatchObject({ ok: true, perShare: 0.5, exDate: '2026-12-01', estimated: false });
        expect(bear.dividendExposure([{ ex_date: '2026-12-01', rate: 2, special: true }], { today, price: 100 }).ok).toBe(false);
        expect(bear.dividendExposure([{ ex_date: '2026-12-01', rate: 1.5, special: false }], { today, price: 100 }).ok).toBe(false);
        const q = ['2026-03-01', '2026-06-01', '2026-09-01'].map(d => ({ ex_date: d, rate: 0.4, special: false }));
        expect(bear.dividendExposure(q, { today, price: 100 })).toMatchObject({ estimated: true, perShare: 0.4 });
        expect(bear.dividendExposure([], { today, price: 100 })).toMatchObject({ ok: true, perShare: 0 });
        expect(bear.positionRisk({ leg: 'short', qty: 10, price: 100, dividendUsd: 5 })).toBe(85);
    });
    test('single-short gap stress at +10/20/30%', () => {
        expect(bear.shortGapStress([{ leg: 'short', value: 2000 }, { leg: 'short', value: 1000 }, { leg: 'hedge', value: 5000 }]))
            .toEqual([{ gapPct: 10, largestShortUsd: 200, allShortsUsd: 300 }, { gapPct: 20, largestShortUsd: 400, allShortsUsd: 600 },
                      { gapPct: 30, largestShortUsd: 600, allShortsUsd: 900 }]);
    });
    test('entry tape: skip a stock up 4%+ today or under a short-sale restriction', () => {
        const snap = (p, l, prevL = 95) => ({ prevDailyBar: { c: 100, l: prevL }, latestTrade: { p }, dailyBar: { l } });
        expect(bear.entryTape(snap(99, 98), 100).ok).toBe(true);
        expect(bear.entryTape(snap(105, 99), 100).reason).toMatch(/up 5/);
        expect(bear.entryTape(snap(92, 89), 100).reason).toMatch(/restriction likely today/);
        expect(bear.entryTape(snap(99, 98, 88), 100).reason).toMatch(/from yesterday/);
    });
    test('squeeze flags: fast rise, heavy volume, gap-up, possible halt', () => {
        const t0 = now.getTime();
        const bars = [0, 1, 2].map(i => ({ t: new Date(t0 - (10 - i * 4) * 60000).toISOString(), o: 100 + i * 3, h: 101 + i * 3, l: 100 + i * 3, c: 101 + i * 3.5, v: 50000 }));
        const snap = { prevDailyBar: { c: 95, v: 390000 }, dailyBar: { o: 100, t: now.toISOString() }, latestTrade: { t: now.toISOString() }, latestQuote: { t: now.toISOString() } };
        const f = bear.squeezeFlags({ bars, snap, nowMs: t0 });
        expect(f.join('|')).toMatch(/up .*% in 15 min/);
        expect(f.join('|')).toMatch(/volume/);
        expect(f.join('|')).toMatch(/gapped up/);
        const quiet = { prevDailyBar: { c: 100, v: 1e9 }, dailyBar: { o: 100, t: now.toISOString() }, latestTrade: { t: new Date(t0 - 15 * 60000).toISOString() } };
        expect(bear.squeezeFlags({ bars: [], snap: quiet, nowMs: t0 })).toEqual([expect.stringMatching(/possible halt/)]);
    });
    test('liquidation check: leftovers at the broker are reported', () => {
        const closed = [{ leg: 'short', symbol: 'RDDT' }, { leg: 'hedge', symbol: 'SH' }, { leg: 'spread', long_contract: 'L1', short_contract: 'S1' }];
        expect(bear.liquidationLeftovers(closed, {})).toEqual([]);
        expect(bear.liquidationLeftovers(closed, { RDDT: -5, SH: 10, S1: -1 })).toHaveLength(3);
    });
    test('RSI bands and regime buckets for the report', () => {
        expect([20, 27, 35, 45, 60, null].map(bear.rsiBand)).toEqual(['<25', '25-30', '30-40', '40-50', '50+', 'unknown']);
        expect(bear.regimeBucket({ meta: { exitRegime: 'PANIC' } })).toBe('PANIC');
        expect(bear.regimeBucket({ meta: { exitRegime: 'BULL_MILD' } })).toMatch(/recovery/);
        expect(bear.regimeBucket({ meta: { exitRegime: 'BEAR', vixAtEntry: 30 } })).toMatch(/high/);
        expect(bear.regimeBucket({ meta: { exitRegime: 'BEAR', vixAtEntry: 20 } })).toMatch(/moderate/);
        const b = bear.regimeBreakdown([{ status: 'closed', pnl: 100, leg: 'short', meta: { exitRegime: 'PANIC' } }, { status: 'closed', pnl: -50, leg: 'hedge', meta: { exitRegime: 'PANIC' } }]);
        expect(b[0]).toMatchObject({ bucket: 'PANIC', trades: 2, pnl: 50, profitFactor: 2 });
    });
    test('leg metrics: win rate, time underwater, gap-through-stop loss', () => {
        const d = s => new Date(`2026-11-${s}T20:00:00Z`);
        const rows = [
            { leg: 'short', status: 'closed', pnl: 100, qty: 10, entry_price: 50, risk_usd: 40, opened_at: d('01'), closed_at: d('02') },
            { leg: 'short', status: 'closed', pnl: -80, qty: 10, entry_price: 50, risk_usd: 40, opened_at: d('02'), closed_at: d('05'), exit_reason: 'stop', stop_price: 54, exit_price: 58 },
            { leg: 'short', status: 'closed', pnl: 90, qty: 10, entry_price: 50, risk_usd: 40, opened_at: d('05'), closed_at: d('09') },
        ];
        const m = bear.legMetrics(rows).short;
        expect(m.winRatePct).toBe(66.67);
        expect(m.longestUnderwaterDays).toBe(3);
        expect(m.gapLossUsd).toBe(40);
    });
});
