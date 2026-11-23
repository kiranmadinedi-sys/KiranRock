const cal = require('../src/utils/marketCalendar');

// 2026-11-27 (day after Thanksgiving) closes at 1:00 PM ET. November is EST (UTC-5).
describe('market calendar — 1:00 PM early-close days', () => {
    test('11-27 is open at 12:59 PM ET and closed from 1:00 PM ET', () => {
        expect(cal.isMarketOpen(new Date('2026-11-27T17:59:00Z'))).toBe(true);
        expect(cal.isMarketOpen(new Date('2026-11-27T18:00:00Z'))).toBe(false);
        expect(cal.isMarketOpen(new Date('2026-11-27T20:30:00Z'))).toBe(false);
    });
    test('a normal day stays open until 4:00 PM ET', () => {
        expect(cal.isMarketOpen(new Date('2026-11-23T20:59:00Z'))).toBe(true);
        expect(cal.isMarketOpen(new Date('2026-11-23T21:00:00Z'))).toBe(false);
    });
    test('close minutes: 780 on early-close days, 960 otherwise', () => {
        expect(cal.marketCloseMinutesET(new Date('2026-11-27T15:00:00Z'))).toBe(780);
        expect(cal.marketCloseMinutesET(new Date('2026-12-24T15:00:00Z'))).toBe(780);
        expect(cal.marketCloseMinutesET(new Date('2026-11-23T15:00:00Z'))).toBe(960);
    });
    test('Thanksgiving itself is still a full holiday', () => {
        expect(cal.isMarketOpen(new Date('2026-11-26T16:00:00Z'))).toBe(false);
        expect(cal.isEarlyClose(new Date('2026-11-26T16:00:00Z'))).toBe(false);
    });
    test('early-close dates are never also listed as holidays', () => {
        for (const d of cal.NYSE_EARLY_CLOSES) expect(cal.NYSE_HOLIDAYS.has(d)).toBe(false);
    });
});
