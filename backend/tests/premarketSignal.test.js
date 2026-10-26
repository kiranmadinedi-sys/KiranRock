/** Pre-market overnight signal (2026-10-26). */
const { classify, changesFromSnapshots, EVENT_DAYS } = require('../src/services/premarketSignalService');

describe('premarketSignalService', () => {
    test('classify: calm when US flat and no event', () => {
        expect(classify({ us: -0.3, asia: -0.8, europe: 0.2 }, null).level).toBe('Calm');
    });
    test('classify: US pre-market -1% → Elevated, -2% → High', () => {
        expect(classify({ us: -1.2, asia: null, europe: null }, null).level).toBe('Elevated');
        expect(classify({ us: -2.4, asia: null, europe: null }, null).level).toBe('High');
    });
    test('classify: weak Asia/Europe only matters if US is also soft', () => {
        expect(classify({ us: 0.4, asia: -2, europe: -1.5 }, null).level).toBe('Calm');
        expect(classify({ us: -0.6, asia: -2, europe: -1.5 }, null).level).toBe('Elevated');
    });
    test('classify: an event day is at least Elevated, never downgrades High', () => {
        expect(classify({ us: 0.5 }, 'FOMC rate decision').level).toBe('Elevated');
        expect(classify({ us: -2.5 }, 'FOMC rate decision').level).toBe('High');
        expect(EVENT_DAYS['2026-10-28']).toMatch(/FOMC/);
    });
    test('changesFromSnapshots: pre-market trade vs last regular close; ignores stale trades', () => {
        const snaps = {
            // Monday pre-market: dailyBar is still Friday → compare with dailyBar.c
            SPY: { latestTrade: { p: 99, t: '2026-10-26T12:30:00Z' }, dailyBar: { c: 100, t: '2026-10-23T04:00:00Z' }, prevDailyBar: { c: 98 } },
            // dailyBar already today → compare with prevDailyBar.c
            QQQ: { latestTrade: { p: 102, t: '2026-10-26T12:30:00Z' }, dailyBar: { c: 101, t: '2026-10-26T04:00:00Z' }, prevDailyBar: { c: 100 } },
            // last trade from Friday → no pre-market data
            EWJ: { latestTrade: { p: 50, t: '2026-10-23T19:59:00Z' }, dailyBar: { c: 50, t: '2026-10-23T04:00:00Z' } },
        };
        const ch = changesFromSnapshots(snaps, '2026-10-26');
        expect(ch.SPY).toBeCloseTo(-1);
        expect(ch.QQQ).toBeCloseTo(2);
        expect(ch.EWJ).toBeUndefined();
    });
});
