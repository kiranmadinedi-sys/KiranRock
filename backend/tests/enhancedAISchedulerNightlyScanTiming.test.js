/**
 * 2026-10-01 real incident: the nightly scan's own window is documented as opening at
 * 4:15 PM ET, but it was never actually observed starting before ~11:30 PM-12:30 AM
 * CDT (~00:30-01:30 AM ET) — night after night. Root cause: a scan that overruns past
 * midnight ET (routine — these take 7-10+ hours) gets recognized as "complete" using
 * whatever the ET calendar date is AT THAT MOMENT, which by then has already rolled
 * over to the next day. _scanCompletedDate then gets stamped with that next day's date
 * — and that phantom completion exactly matches the next day's OWN etDate for its
 * entire evening, blocking that day's legitimate 4:15 PM launch until the calendar
 * rolls over yet again at the following midnight. A one-day-behind lag that, once
 * started, never self-corrects on its own.
 *
 * Fixed by tracking progress/completion against the date a run actually targets
 * (nightlyUniverseScanService.getScanTargetDate(), computed once at that run's launch
 * relative to which evening's 4:15 PM-midnight window it's really fulfilling — not a
 * fresh "what's today's date" call on every 5-minute tick).
 */
describe('enhancedAIScheduler — nightly scan no longer waits for midnight to start', () => {
    let query, nightlyScanSvc;
    let runNightlyScanTrigger, runScanHealthCheck, _effectiveScanDay;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();

        jest.doMock('../src/services/enhancedAITradingBot', () => ({}));
        jest.doMock('../src/services/userDatabaseService', () => ({}));
        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        jest.doMock('../src/services/tradingControlService', () => ({ getGlobalTradingControl: jest.fn() }));
        jest.doMock('../src/services/redisStateService', () => ({}));
        jest.doMock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue(), alertNightlyScanFailure: jest.fn().mockResolvedValue() }));
        jest.doMock('../src/services/vixSpikeMonitorService', () => ({}));
        jest.doMock('../src/services/premarketGapAlertService', () => ({}));
        jest.doMock('../src/services/extendedHoursTradingService', () => ({}));
        jest.doMock('../src/services/marketRegimeService', () => ({ getMarketRegime: jest.fn() }));
        jest.doMock('../src/services/globalSentimentService', () => ({ getGlobalSentiment: jest.fn() }));
        jest.doMock('../src/services/nightlyUniverseScanService', () => ({
            isScanRunning: jest.fn().mockReturnValue(false),
            runNightlyUniverseScan: jest.fn().mockResolvedValue({ analyzed: 0, passed: 0, failed: 0, elapsedMin: '0.0' }),
            getScanStartTime: jest.fn().mockReturnValue(null),
            getScanTargetDate: jest.fn().mockReturnValue(null),
        }));

        ({ runNightlyScanTrigger, runScanHealthCheck, _effectiveScanDay } = require('../src/services/enhancedAIScheduler'));
        query = require('../src/config/database').query;
        nightlyScanSvc = require('../src/services/nightlyUniverseScanService');
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('_effectiveScanDay', () => {
        test('evening (>=16 ET) always uses the raw calendar date — a fresh decision for tonight', () => {
            nightlyScanSvc.getScanTargetDate.mockReturnValue('2026-10-01'); // yesterday's run, still lying around
            expect(_effectiveScanDay(17, '2026-10-02')).toBe('2026-10-02');
        });

        test('early morning defers to an overnight run that targeted yesterday', () => {
            nightlyScanSvc.getScanTargetDate.mockReturnValue('2026-10-01');
            expect(_effectiveScanDay(2, '2026-10-02')).toBe('2026-10-01');
        });

        test('early morning defers to a run that already targeted today', () => {
            nightlyScanSvc.getScanTargetDate.mockReturnValue('2026-10-02');
            expect(_effectiveScanDay(2, '2026-10-02')).toBe('2026-10-02');
        });

        test('early morning with no tracked run falls back to the raw calendar date', () => {
            nightlyScanSvc.getScanTargetDate.mockReturnValue(null);
            expect(_effectiveScanDay(2, '2026-10-02')).toBe('2026-10-02');
        });

        test('early morning with a stale (multi-day-old) target falls back to the raw calendar date', () => {
            nightlyScanSvc.getScanTargetDate.mockReturnValue('2026-09-28');
            expect(_effectiveScanDay(2, '2026-10-02')).toBe('2026-10-02');
        });
    });

    describe('runNightlyScanTrigger — the real overnight-lag scenario', () => {
        test('an overnight run completing after midnight does NOT block the following evening\'s 4:15 PM launch', async () => {
            // Step 1: 2:00 AM ET Oct 2 — an overnight run launched the evening of Oct 1 is
            // just finishing up. getScanTargetDate() correctly reports '2026-10-01' (the
            // evening it actually serves), even though the calendar has rolled to Oct 2.
            jest.setSystemTime(new Date('2026-10-02T06:00:00.000Z')); // 2:00 AM EDT
            nightlyScanSvc.getScanTargetDate.mockReturnValue('2026-10-01');
            query
                .mockResolvedValueOnce({ rows: [{ analysis_date: '2026-10-01', cnt: '2200' }] }) // progress check
                .mockResolvedValueOnce({ rows: [{ n: '2400' }] }); // hermes target for 2026-10-01

            await runNightlyScanTrigger();

            // Recognized complete for Oct 1 (not Oct 2) — 2200 >= 90% of 2400 (2160).
            expect(nightlyScanSvc.runNightlyUniverseScan).not.toHaveBeenCalled();

            // Step 2: later the SAME calendar day, 5:00 PM ET Oct 2 — the evening window
            // for Oct 2 has opened. Nothing has run yet tonight.
            jest.setSystemTime(new Date('2026-10-02T21:00:00.000Z')); // 5:00 PM EDT
            query
                .mockResolvedValueOnce({ rows: [] }) // nothing scanned yet for Oct 2
                .mockResolvedValueOnce({ rows: [{ n: '2400' }] }); // hermes target for 2026-10-02

            await runNightlyScanTrigger();

            // Must launch fresh for Oct 2 — this is the exact case that used to stay
            // blocked (old behavior: _scanCompletedDate wrongly held '2026-10-02' from
            // step 1, matching today's etDate and silently skipping the whole evening).
            expect(nightlyScanSvc.runNightlyUniverseScan).toHaveBeenCalledWith({ missingOnly: false });
        });
    });

    describe('runScanHealthCheck — deadline-miss check uses the real scan day', () => {
        test('an overnight run stamped with yesterday\'s date does not falsely report 0 scored at market open', async () => {
            jest.setSystemTime(new Date('2026-10-02T13:25:00.000Z')); // 9:25 AM EDT -- inside the 9:20-9:29 deadline window
            nightlyScanSvc.isScanRunning.mockReturnValue(false);
            nightlyScanSvc.getScanTargetDate.mockReturnValue('2026-10-01'); // last night's run targeted Oct 1
            query
                .mockResolvedValueOnce({ rows: [{ scored: '2200' }] }) // queried under 2026-10-01, the real scan day
                .mockResolvedValueOnce({ rows: [{ n: '2400' }] });

            const alertService = require('../src/services/telegramAlertService');
            await runScanHealthCheck();

            expect(alertService.alertNightlyScanFailure).not.toHaveBeenCalled();
            expect(query.mock.calls[0][1]).toEqual(['2026-10-01']);
        });
    });
});
