jest.mock('node-cron', () => ({ schedule: jest.fn(() => ({ stop: jest.fn() })) }));
jest.mock('../src/services/assetUniverseService', () => ({}));
jest.mock('../src/services/historicalDataService', () => ({}));
jest.mock('../src/services/stockUniverseService', () => ({ STATIC_STOCK_UNIVERSE: [] }));
jest.mock('../src/services/dynamicUniverseService', () => ({}));
jest.mock('../src/services/premarketGapAlertService', () => ({ runPremarketGapAlert: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/nightlyUniverseScanService', () => ({
    isScanRunning: jest.fn().mockReturnValue(false),
    runNightlyUniverseScan: jest.fn().mockResolvedValue(null),
}));

const { query } = require('../src/config/database');
const nightlyScanSvc = require('../src/services/nightlyUniverseScanService');
const { runMorningCatchupScan } = require('../src/services/assetUniverseScheduler');

/**
 * 2026-10-08: the 8 AM ET catch-up checked TODAY's date, but evening scans are stamped with
 * the evening's date — so it saw 0 rows almost every morning and launched a partial rescan
 * that displaced the complete evening scan as the morning candidate source.
 */
describe('morning catch-up checks the previous trading day\'s scan', () => {
    function db({ scanRows, target, todayRows = 0 }) {
        query.mockImplementation(async (sql, params) => {
            if (/FROM hermes_symbol_log/.test(sql)) return { rows: [{ n: String(target) }] };
            if (/FROM daily_universe_analysis/.test(sql)) {
                return { rows: [{ cnt: String(params[0] === '2026-10-08' ? todayRows : scanRows) }] };
            }
            return { rows: [] };
        });
    }

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-10-08T12:00:00Z')); // 8:00 AM EDT Thursday
    });
    afterEach(() => jest.useRealTimers());

    test('a complete evening scan (2,628 of 2,636) means no morning rescan', async () => {
        db({ scanRows: 2628, target: 2636 });
        await runMorningCatchupScan();
        expect(query.mock.calls.find(c => /daily_universe_analysis/.test(c[0]))[1]).toEqual(['2026-10-07']);
        expect(nightlyScanSvc.runNightlyUniverseScan).not.toHaveBeenCalled();
    });

    test('an incomplete evening scan still gets caught up before the open', async () => {
        db({ scanRows: 900, target: 2636 });
        await runMorningCatchupScan();
        expect(nightlyScanSvc.runNightlyUniverseScan).toHaveBeenCalledWith({ missingOnly: false });
    });

    test('Monday morning checks Friday\'s scan', async () => {
        jest.setSystemTime(new Date('2026-10-12T12:00:00Z')); // Monday 8:00 AM EDT
        db({ scanRows: 2600, target: 2636 });
        await runMorningCatchupScan();
        expect(query.mock.calls.find(c => /daily_universe_analysis/.test(c[0]))[1]).toEqual(['2026-10-09']);
        expect(nightlyScanSvc.runNightlyUniverseScan).not.toHaveBeenCalled();
    });
});
