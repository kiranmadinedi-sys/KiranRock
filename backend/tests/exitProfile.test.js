/** Exit profiles (2026-10-17): 'wide' = flat 7% trail, no break-even lock (3-year replay winner). */
describe('getDynamicTrailingStop exit profiles', () => {
    let getDynamicTrailingStop;
    beforeAll(() => {
        jest.resetModules();
        ({ getDynamicTrailingStop } = require('../src/services/enhancedAITradingBot'));
    });

    test('standard: tightens as gains grow and locks break-even at +2%', () => {
        expect(getDynamicTrailingStop(0.01, null, 100)).toEqual({ trailPct: 0.055, useBreakevenFloor: false });
        expect(getDynamicTrailingStop(0.03, null, 100)).toEqual({ trailPct: 0.05, useBreakevenFloor: true });
        expect(getDynamicTrailingStop(0.12, null, 100).trailPct).toBe(0.03);
    });

    test('wide: flat 7% at every gain level, no break-even lock', () => {
        for (const g of [0.01, 0.03, 0.12, 0.25]) {
            expect(getDynamicTrailingStop(g, null, 100, 'wide')).toEqual({ trailPct: 0.07, useBreakevenFloor: false });
        }
    });

    test('wide still respects the ATR floor for very volatile stocks', () => {
        // ATR $6 on a $100 peak → 1.5×ATR = 9% > 7%
        expect(getDynamicTrailingStop(0.05, 6, 100, 'wide').trailPct).toBeCloseTo(0.09);
    });
});
