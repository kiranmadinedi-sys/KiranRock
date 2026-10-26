/** Core watchlist statuses (2026-10-26) — suggestions only, never "buy". */
const { classify } = require('../src/services/coreWatchlistService');

describe('coreWatchlistService.classify', () => {
    const base = {
        ddPct: 3, above200: true, gemini: 0, staleDays: 3, earningsKnown: true, daysToEarnings: 40,
        daysSinceEarnings: null, valuation: { peVsUsualPct: 0, revenueGrowthPct: 10, epsGrowthPct: 12 },
    };
    const st = f => classify({ ...base, ...f }).status;

    test('near the high → No dip (never labelled a buy)', () => expect(st({})).toBe('No dip'));
    test('dip with P/E at or below its usual → Dip — valuation OK', () => {
        expect(st({ ddPct: 16 })).toBe('Dip — valuation OK');
        expect(st({ ddPct: 16, valuation: { ...base.valuation, peVsUsualPct: -25 } })).toBe('Dip — valuation OK');
    });
    test('dip but P/E >10% above its usual → Dip — but pricey', () => {
        expect(st({ ddPct: 20, valuation: { ...base.valuation, peVsUsualPct: 30 } })).toBe('Dip — but pricey');
    });
    test('dip without valuation data → Dip — review fundamentals', () => expect(st({ ddPct: 12, valuation: null })).toBe('Dip — review fundamentals'));
    test('stale prices fail closed', () => {
        expect(st({ ddPct: 16, staleDays: 6 })).toBe('Data unavailable');
        expect(st({ ddPct: 16, staleDays: null })).toBe('Data unavailable');
    });
    test('unverifiable earnings fail closed', () => expect(st({ ddPct: 16, earningsKnown: false })).toBe('Data unavailable'));
    test('earnings within 5 days → Wait (reassess after, not "buy after")', () => {
        const r = classify({ ...base, ddPct: 18, daysToEarnings: 3 });
        expect(r.status).toBe('Wait');
        expect(r.reasons[0]).toMatch(/reassess/);
    });
    test('just reported → Reassess', () => expect(st({ ddPct: 18, daysSinceEarnings: 1, lastEarningsDate: '2026-10-25' })).toBe('Reassess'));
    test('strongly bearish news → Avoid today', () => expect(st({ ddPct: 18, gemini: -4 })).toBe('Avoid today'));
    test('30%+ collapse → Review first', () => expect(st({ ddPct: 33 })).toBe('Review first'));
    test('dip with shrinking revenue or falling EPS → Review first', () => {
        expect(st({ ddPct: 14, valuation: { ...base.valuation, revenueGrowthPct: -3 } })).toBe('Review first');
        expect(st({ ddPct: 14, valuation: { ...base.valuation, epsGrowthPct: -25 } })).toBe('Review first');
    });
    test('below the 200-day average adds a staged-buying note', () => {
        expect(classify({ ...base, ddPct: 16, above200: false }).reasons.join(' ')).toMatch(/stages/);
    });
});
