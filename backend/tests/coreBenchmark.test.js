jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const { compare, maxDrawdown } = require('../src/services/coreBenchmarkService');
const { singleStockRule } = require('../src/services/coreGuidanceService');
const { accountBreakdown } = require('../src/services/coreHoldingsService');

const snap = (day, positions, spy) => ({ day, positions, spy, value: Object.values(positions).reduce((s, p) => s + p.qty * p.px, 0) });

describe('core vs SPY comparison', () => {
    test('new buys are not counted as gains', () => {
        const c = compare([
            snap('2026-11-16', { SPY: { qty: 1, px: 100 } }, 100),
            snap('2026-11-17', { SPY: { qty: 2, px: 100 } }, 100), // bought one more share, price flat
        ], 0);
        expect(c.corePct).toBe(0);
        expect(c.vsSpyPp).toBe(0);
    });
    test('price moves are counted, chained over days', () => {
        const c = compare([
            snap('2026-11-16', { V: { qty: 1, px: 100 } }, 100),
            snap('2026-11-17', { V: { qty: 1, px: 110 } }, 101),
            snap('2026-11-18', { V: { qty: 2, px: 99 } }, 101), // -10% then bought one more
        ], 0);
        expect(c.corePct).toBeCloseTo(-1, 1);   // 1.10 × 0.90 − 1
        expect(c.spyPct).toBeCloseTo(1, 1);
        expect(c.vsSpyPp).toBeCloseTo(-2, 1);
        expect(c.tradingDays).toBe(2);
    });
    test('a fully sold position is treated as money leaving, not a loss', () => {
        const c = compare([
            snap('2026-11-16', { V: { qty: 1, px: 100 }, SPY: { qty: 1, px: 100 } }, 100),
            snap('2026-11-17', { SPY: { qty: 1, px: 100 } }, 100),
        ], 0);
        expect(c.corePct).toBe(0);
    });
    test('dividends count for core and SPY alike; a buy is never profit', () => {
        const divs = { V: [{ ex: '2026-11-17', rate: 1 }], SPY: [{ ex: '2026-11-17', rate: 2 }] };
        const c = compare([
            snap('2026-11-16', { V: { qty: 10, px: 100 } }, 100),
            snap('2026-11-17', { V: { qty: 11, px: 99 } }, 98), // ex-div: price drops by the dividend, bought 1 more
        ], 0, divs);
        expect(c.corePct).toBeCloseTo(0, 5);
        expect(c.spyPct).toBeCloseTo(0, 5);
        expect(c.dividendsUsd).toBe(10);
        expect(c.newMoneyUsd).toBe(99);
    });
    test('same deposits into SPY: equal when core behaves like SPY', () => {
        const c = compare([
            snap('2026-11-16', { SPY: { qty: 1, px: 100 } }, 100),
            snap('2026-11-17', { SPY: { qty: 2, px: 110 } }, 110),
        ], 0);
        expect(c.sameDepositsInSpy.diffUsd).toBeCloseTo(0, 5);
        expect(c.sameDepositsInSpy.spyUsd).toBeCloseTo(220, 5);
    });
    test('max drawdown measures the worst fall from a high', () => {
        expect(maxDrawdown([1, 1.2, 0.9, 1.3])).toBe(-25);
    });
    test('T-bills accrue by calendar day', () => {
        const c = compare([snap('2026-01-01', { SPY: { qty: 1, px: 100 } }, 100), snap('2027-01-01', { SPY: { qty: 1, px: 100 } }, 100)], 4);
        expect(c.tbillPct).toBeCloseTo(4, 1);
    });
});

describe('single-stock concentration', () => {
    test('flags a company above 10%, never a fund', () => {
        const out = singleStockRule([{ symbol: 'V', value: 1500 }, { symbol: 'SPY', value: 4000 }, { symbol: 'SGOV', value: 1600 }, { symbol: 'AMD', value: 200 }], 10000);
        expect(out.map(x => x.symbol)).toEqual(['V']);
    });
    test('adds core and swing shares of the same company', () => {
        expect(singleStockRule([{ symbol: 'NVDA', value: 600 }, { symbol: 'NVDA', value: 600 }], 10000)).toHaveLength(1);
    });
});

describe('account breakdown', () => {
    test('splits core, sweep, swing and cash and reconciles to equity', () => {
        const b = accountBreakdown({
            positions: [{ symbol: 'SPY', qty: 5, marketValue: 4000 }, { symbol: 'SGOV', qty: 20, marketValue: 2000 }, { symbol: 'XYZ', qty: 10, marketValue: 300 }, { symbol: 'ABC', qty: 1, marketValue: 200 }],
            coreSymbols: new Set(['SPY', 'SGOV']), equity: 7500, cash: 1000, sweepSymbol: 'SGOV', sweepQty: 5,
        });
        expect(b.core.usd).toBe(5500);   // SPY 4000 + 15 core SGOV shares 1500
        expect(b.sweep.usd).toBe(500);
        expect(b.swing).toEqual({ usd: 500, pct: 6.7, count: 2 });
        expect(b.other.usd).toBe(0);
    });
    test('sold puts are their own (negative) slice so the total still matches equity', () => {
        const b = accountBreakdown({ positions: [{ symbol: 'SPY', qty: 1, marketValue: 700 }, { symbol: 'F251219P00012000', qty: -1, marketValue: -40 }],
            coreSymbols: new Set(['SPY']), equity: 960, cash: 300 });
        expect(b.options).toEqual({ usd: -40, pct: -4.2, count: 1, collateralUsd: 1200 });
        expect(b.freeCashUsd).toBe(0);
        expect(b.other.usd).toBe(0);
    });
});
