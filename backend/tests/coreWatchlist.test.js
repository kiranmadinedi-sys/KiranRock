/** Core watchlist statuses (2026-10-26) — suggestions only. */
const { classify } = require('../src/services/coreWatchlistService');

describe('coreWatchlistService.classify', () => {
    const base = { ddPct: 3, above200: true, gemini: 0, daysToEarnings: 40, revenueGrowth: 0.1 };
    test('near the high → Fine to buy', () => expect(classify(base).status).toBe('Fine to buy'));
    test('10-30% off the high, no flags → Good entry', () => expect(classify({ ...base, ddPct: 16 }).status).toBe('Good entry'));
    test('below the 200-day average adds a stage-buying note', () => {
        expect(classify({ ...base, ddPct: 16, above200: false }).reasons.join(' ')).toMatch(/stages/);
    });
    test('earnings within 5 days → Wait, even when on sale', () => expect(classify({ ...base, ddPct: 18, daysToEarnings: 3 }).status).toBe('Wait'));
    test('strongly bearish news → Avoid today, overrides everything', () => expect(classify({ ...base, ddPct: 18, gemini: -4, daysToEarnings: 2 }).status).toBe('Avoid today'));
    test('30%+ collapse → Review first', () => expect(classify({ ...base, ddPct: 33 }).status).toBe('Review first'));
    test('on sale with shrinking revenue → Review first', () => expect(classify({ ...base, ddPct: 14, revenueGrowth: -0.05 }).status).toBe('Review first'));
    test('unknown fundamentals do not block', () => expect(classify({ ...base, ddPct: 12, revenueGrowth: null, gemini: null }).status).toBe('Good entry'));
});
