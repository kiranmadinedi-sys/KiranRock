jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const bear = require('../src/services/bearSideService');
const { cashSecuredRoom } = require('../src/services/optionsIncomeService');
const { accountBreakdown } = require('../src/services/coreHoldingsService');

describe('regime gate', () => {
    const now = new Date('2026-11-20T16:00:00Z');
    test('BEAR: hold and enter', () => {
        expect(bear.regimeDecision({ regimeType: 'BEAR', now })).toMatchObject({ hold: true, enter: true });
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
        expect(bear.chooseSpread(pricey, 700, today)).toBeNull();
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
