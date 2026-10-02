/**
 * 2026-09-30 real incident: SCAN_COMPLETE_THRESHOLD was a fixed 420, set when the real
 * universe was ~455 symbols. The universe grew ~5x since (2,390 on 2026-09-28) without
 * this ever being revisited, so 420 — under a fifth of a real night's total — was enough
 * to declare the scan "complete." Confirmed live: stopped at 1,156/2,390 (48%), 1,242
 * symbols never analyzed, only caught via an unrelated "missed opportunity" investigation.
 * Fixed to scale with the real target universe size (hermes_symbol_log) instead of a
 * number that can only go stale again as the universe keeps changing size.
 */
describe('enhancedAIScheduler — dynamic scan-completion threshold', () => {
    // Monday 2026-09-28, 9:00 PM ET (EDT, UTC-4) = 2026-09-29T01:00:00Z — a weekday,
    // outside the 9:26 AM-4:14 PM ET daytime block both runNightlyScanTrigger and
    // runScanHealthCheck gate on.
    const A_VALID_WEEKDAY_EVENING = new Date('2026-09-29T01:00:00Z');

    let query, alertService, nightlyScanSvc;
    let runNightlyScanTrigger, runScanHealthCheck, _getTargetUniverseSize;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();
        jest.setSystemTime(A_VALID_WEEKDAY_EVENING);

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
            // added 2026-10-01 for the midnight-lag fix — null means "no run tracked yet",
            // which _effectiveScanDay falls back to the raw calendar date for, matching
            // this file's pre-existing tests (none of them exercise the overnight-lag path).
            getScanTargetDate: jest.fn().mockReturnValue(null),
        }));

        ({ runNightlyScanTrigger, runScanHealthCheck, _getTargetUniverseSize } = require('../src/services/enhancedAIScheduler'));
        query = require('../src/config/database').query;
        alertService = require('../src/services/telegramAlertService');
        nightlyScanSvc = require('../src/services/nightlyUniverseScanService');
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('_getTargetUniverseSize', () => {
        test('returns the real HERMES-qualified count for the date', async () => {
            query.mockResolvedValue({ rows: [{ n: '2390' }] });

            const size = await _getTargetUniverseSize('2026-09-28');

            expect(size).toBe(2390);
            expect(query.mock.calls[0][0]).toMatch(/hermes_symbol_log/);
        });

        test('fails safe to 0 on a query error, rather than throwing', async () => {
            query.mockRejectedValue(new Error('db down'));

            await expect(_getTargetUniverseSize('2026-09-28')).resolves.toBe(0);
        });
    });

    describe('runNightlyScanTrigger', () => {
        test('a genuinely large night (2,390 universe) is NOT declared complete at the old fixed 420', async () => {
            query
                .mockResolvedValueOnce({ rows: [{ analysis_date: '2026-09-28', cnt: '1156' }] }) // today-progress check
                .mockResolvedValueOnce({ rows: [{ n: '2390' }] }); // target universe size

            await runNightlyScanTrigger();

            // 1,156 < 90% of 2,390 (2,151) -> must still be treated as incomplete and relaunch.
            expect(nightlyScanSvc.runNightlyUniverseScan).toHaveBeenCalledWith({ missingOnly: true });
        });

        test('correctly recognizes completion once past 90% of the REAL target size', async () => {
            query
                .mockResolvedValueOnce({ rows: [{ analysis_date: '2026-09-28', cnt: '2200' }] })
                .mockResolvedValueOnce({ rows: [{ n: '2390' }] });

            await runNightlyScanTrigger();

            // 2,200 >= 90% of 2,390 (2,151) -> complete, no relaunch.
            expect(nightlyScanSvc.runNightlyUniverseScan).not.toHaveBeenCalled();
        });

        test('falls back to the fixed threshold when HERMES has no data for the date yet', async () => {
            query
                .mockResolvedValueOnce({ rows: [{ analysis_date: '2026-09-28', cnt: '450' }] })
                .mockResolvedValueOnce({ rows: [{ n: '0' }] }); // no HERMES rows yet

            await runNightlyScanTrigger();

            // 450 >= the 420 fallback -> complete, matching the pre-fix behavior when
            // real universe data isn't available to compute a dynamic threshold from.
            expect(nightlyScanSvc.runNightlyUniverseScan).not.toHaveBeenCalled();
        });
    });

    describe('runScanHealthCheck — deadline-miss alert', () => {
        test('alerts with the REAL universe size, not the stale fixed constant', async () => {
            jest.setSystemTime(new Date('2026-09-29T13:25:00Z')); // 9:25 AM ET -- inside the 9:20-9:29 deadline-check window
            nightlyScanSvc.isScanRunning.mockReturnValue(false);
            query
                .mockResolvedValueOnce({ rows: [{ scored: '1156' }] })
                .mockResolvedValueOnce({ rows: [{ n: '2390' }] });

            await runScanHealthCheck();

            expect(alertService.alertNightlyScanFailure).toHaveBeenCalledWith(expect.objectContaining({
                analyzed: 1156,
                universe: 2390,
            }));
        });
    });
});
