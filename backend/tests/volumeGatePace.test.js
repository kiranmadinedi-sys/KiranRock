/**
 * VolumeGate pace (2026-11-09): today's volume so far is compared with what a normal day has
 * traded by this time, not with a full day's average.
 */
jest.mock('../src/config/database', () => ({ query: jest.fn(), pool: { on: jest.fn() } }));
const { _test } = require('../src/services/enhancedAITradingBot');
const f = (iso) => _test._sessionVolumeFraction(new Date(iso));

describe('session volume fraction (ET)', () => {
    test('one hour after the open ≈ 21% of a day', () => {
        expect(f('2026-11-09T15:30:00Z')).toBeCloseTo(0.21, 2);     // 10:30 ET
    });
    test('first minutes are floored so a few prints are not a surge', () => {
        expect(f('2026-11-09T14:32:00Z')).toBe(0.10);               // 9:32 ET
    });
    test('interpolates between curve points', () => {
        expect(f('2026-11-09T16:30:00Z')).toBeCloseTo(0.33, 2);     // 11:30 ET
        expect(f('2026-11-09T17:00:00Z')).toBeCloseTo(0.38, 2);     // 12:00 ET
    });
    test('outside regular hours → 1 (raw ratio, unchanged behaviour)', () => {
        expect(f('2026-11-09T13:00:00Z')).toBe(1);                  // 8:00 ET pre-market
        expect(f('2026-11-09T21:30:00Z')).toBe(1);                  // 4:30 ET after close
    });
    test('handles daylight time (summer: open is 13:30Z)', () => {
        expect(f('2026-07-15T14:30:00Z')).toBeCloseTo(0.21, 2);     // 10:30 EDT
    });
    test("this morning's example: raw 0.5 one hour in is 2.4× pace → passes 1.5", () => {
        expect(0.5 / f('2026-11-09T15:30:00Z')).toBeGreaterThan(1.5);
        expect(0.12 / f('2026-11-09T15:30:00Z')).toBeLessThan(1.5); // the median stock still blocked
    });
});
