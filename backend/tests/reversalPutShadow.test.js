jest.mock('../src/config/database', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
const rv = require('../src/services/reversalPutShadowService');

describe('reversal put shadow log (no orders)', () => {
    const snap = (prev, open, high, px) => ({ prevDailyBar: { c: prev }, dailyBar: { o: open, h: high, c: px }, latestTrade: { p: px } });
    test('fires on the real GOOGL 11-19 shape on a weak market day', () => {
        const s = rv.reversalSignal(snap(282.36, 294.375, 295.345, 272.475), -1.98);
        expect(s).toMatchObject({ openPct: 4.26, offHighPct: 7.74, dayPct: -3.5 });
    });
    test('needs a weak market, an up open/high, a ≥3% fall from the high, and a price below the prior close', () => {
        expect(rv.reversalSignal(snap(282.36, 294.375, 295.345, 272.475), -0.3)).toBeNull();   // market not weak
        expect(rv.reversalSignal(snap(100, 99.8, 100.4, 96), -1)).toBeNull();                 // never opened/traded higher
        expect(rv.reversalSignal(snap(100, 102, 103, 101), -1)).toBeNull();                   // fell only 1.9% from high
        expect(rv.reversalSignal(snap(100, 104, 108, 103), -1)).toBeNull();                   // still above prior close
        expect(rv.reversalSignal(null, -2)).toBeNull();
    });
    test('picks at-the-money and ~5% out-of-the-money puts for a near and a 21-45 day expiry', () => {
        const q = (bp, ap) => ({ latestQuote: { bp, ap } });
        const chain = {
            GOOGL261127P00265000: q(7.1, 8.5), GOOGL261127P00252500: q(3.3, 3.9), GOOGL261127P00270000: q(9, 10),
            GOOGL261211P00265000: q(11.3, 12.6), GOOGL261211P00250000: q(6, 7.3),
            GOOGL261122P00265000: q(5, 6), // only 2 days out — skipped as "near"
        };
        const p = rv.pickPuts(chain, 265.62, '2026-11-20');
        expect(p.map(x => [x.kind, x.contract])).toEqual([
            ['near_atm', 'GOOGL261127P00265000'], ['near_otm5', 'GOOGL261127P00252500'],
            ['month_atm', 'GOOGL261211P00265000'], ['month_otm5', 'GOOGL261211P00250000']]);
    });
    test('grading: buy at the ask, sell at the bid (realistic), and mid to mid', () => {
        expect(rv.gradeLeg({ ask: 2, mid: 1.9 }, { bid: 3, ask: 3.2, mid: 3.1 })).toEqual({ askToBidPct: 50, midToMidPct: 63.16 });
        expect(rv.gradeLeg({ ask: 2, mid: 1.9 }, { bid: 0, ask: 0.05, mid: 0.025 }).askToBidPct).toBe(-100);
    });
    test('trading-day arithmetic skips weekends and holidays (Thanksgiving 11-26)', () => {
        expect(rv.addTradingDays('2026-11-25', 1)).toBe('2026-11-27');
        expect(rv.addTradingDays('2026-11-20', 3)).toBe('2026-11-25');
        expect(rv.addTradingDays('2026-11-20', 0)).toBe('2026-11-20');
    });
    test('the module has no order code at all', () => {
        const src = require('fs').readFileSync(require.resolve('../src/services/reversalPutShadowService'), 'utf8');
        expect(src).not.toMatch(/\/v2\/orders|axios\.post|buyMarket|sellMarket/);
    });
});

describe('summary splits broad-market days from isolated reversals', () => {
    test('a day with 5+ signals is "broad"; fewer is "isolated"; each day counted once', async () => {
        const { query } = require('../src/config/database');
        const leg = c => ({ kind: 'near_atm', contract: c, ask: 2, mid: 1.9 });
        const g = (c, bid) => ({ close: { price: 1, legs: { [c]: { bid, ask: bid + 0.1, mid: bid + 0.05 } } } });
        const broad = ['A', 'B', 'C', 'D', 'E'].map(s => ({ d: '2026-11-19', symbol: s, signal: { price: 1 }, contracts: [leg(s)], grades: g(s, 3) })); // +50% each
        const iso = [{ d: '2026-11-24', symbol: 'Z', signal: { price: 1 }, contracts: [leg('Z')], grades: g('Z', 1) }];                       // −50%
        query.mockImplementation(async () => ({ rows: [...broad, ...iso] }));
        const s = await rv.summary();
        expect(s.byHorizon.close.nearAtmByDay).toMatchObject({ days: 2, avgAskToBidPct: 0, daysWonPct: 50 });
        expect(s.byHorizon.close.nearAtmBroadDays).toMatchObject({ days: 1, avgAskToBidPct: 50 });
        expect(s.byHorizon.close.nearAtmIsolatedDays).toMatchObject({ days: 1, avgAskToBidPct: -50 });
    });
});
