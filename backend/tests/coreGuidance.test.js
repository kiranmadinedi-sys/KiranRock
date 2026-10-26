/** Core guidance rules (2026-10-26). */
const { idleCashRule, driftRule, concentrationRule, RULES } = require('../src/services/coreGuidanceService');

describe('idleCashRule', () => {
    const day = (cashPct, reservePct = 25) => ({ cashPct, reservePct });
    test('needs 10 trading days of history', () => {
        expect(idleCashRule(Array(9).fill(day(50)), { equity: 10000, totalTargetPct: 65 })).toBeNull();
    });
    test('fires when every one of the last 10 days sat above reserve + 5%', () => {
        const r = idleCashRule(Array(10).fill(day(40)), { equity: 10000, totalTargetPct: 65 });
        expect(r).toMatchObject({ addPct: 10, excessUsd: 1000 }); // 40 − 25 − 5 = 10 points
    });
    test('one day below the line resets it', () => {
        const h = Array(10).fill(day(40)); h[5] = day(28);
        expect(idleCashRule(h, { equity: 10000, totalTargetPct: 65 })).toBeNull();
    });
    test('never suggests more than the 80% total-target room', () => {
        expect(idleCashRule(Array(10).fill(day(60)), { equity: 10000, totalTargetPct: 75 }).addPct).toBe(5);
        expect(idleCashRule(Array(10).fill(day(60)), { equity: 10000, totalTargetPct: 79 })).toBeNull();
    });
});

test('driftRule flags holdings 10+ points above target only', () => {
    expect(driftRule([
        { symbol: 'SPY', targetPct: 40, currentPct: 52 }, { symbol: 'V', targetPct: 10, currentPct: 14 },
        { symbol: 'OLD', targetPct: 0, currentPct: 30 },
    ]).map(h => h.symbol)).toEqual(['SPY']);
});

test('concentrationRule: single-stock sectors above 35%; ETFs (no sector) ignored', () => {
    const r = concentrationRule([
        { symbol: 'NVDA', value: 2500, sector: 'Technology' }, { symbol: 'AMD', value: 1500, sector: 'Technology' },
        { symbol: 'SPY', value: 5000, sector: null }, { symbol: 'JPM', value: 1000, sector: 'Financial Services' },
    ], 10000);
    expect(r).toEqual([{ sector: 'Technology', pct: 40 }]);
});

test('no rule starts above level 1 — autonomy has to be earned', () => {
    expect(Math.max(...Object.values(RULES).map(r => r.level))).toBeLessThanOrEqual(1);
});
