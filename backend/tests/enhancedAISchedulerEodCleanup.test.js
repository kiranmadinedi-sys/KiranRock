jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/userDatabaseService', () => ({
    getUsersWithAITradingEnabled: jest.fn(),
    getUserAlpacaCredentials: jest.fn(),
}));
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/enhancedAITradingBot', () => ({ isMarketOpen: jest.fn() }));
jest.mock('../src/services/tradingControlService', () => ({ getGlobalTradingControl: jest.fn() }));
jest.mock('../src/services/redisStateService', () => ({
    pingAgentHealth: jest.fn().mockResolvedValue(),
    setHaltAll: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/services/vixSpikeMonitorService', () => ({}));
jest.mock('../src/services/premarketGapAlertService', () => ({}));
jest.mock('../src/services/extendedHoursTradingService', () => ({}));
jest.mock('../src/services/marketRegimeService', () => ({ getMarketRegime: jest.fn() }));
jest.mock('../src/services/globalSentimentService', () => ({ getGlobalSentiment: jest.fn() }));
jest.mock('../src/services/brokerService', () => ({ eodCancelPartialFills: jest.fn().mockResolvedValue({ canceled: 0, journaled: 0 }) }));
jest.mock('../src/services/nightlyUniverseScanService', () => ({ runNightlyUniverseScan: jest.fn().mockResolvedValue(null) }));

/**
 * 2026-09-19: the daily trade-flow anomaly detector inside runEodCleanup() — the
 * one that can engage the HALT_ALL kill switch for a runaway bot or a strategy
 * breakdown — filtered `decision_phase = 'EXIT'`, a value that has never existed
 * in trade_decision_journal's CHECK constraint (CANDIDATE/EXECUTED/CLOSED only),
 * present since this detector and that table were introduced together on
 * 2026-06-05. Every query always matched zero rows, so today_count/baseline_avg/
 * today_wr/baseline_wr were always 0/null and every anomaly/auto-pause condition
 * was structurally unreachable — this safety mechanism has never once fired for
 * any account. These tests confirm the fixed 'CLOSED' filter and that a genuine
 * strategy-breakdown scenario now actually engages HALT_ALL.
 */
describe('enhancedAIScheduler.runEodCleanup — trade-flow anomaly detector (2026-09-19 fix)', () => {
    let runEodCleanup;
    let query, redisState, alertService, userDb;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();
        // 20:50 UTC in September = 15:50 ET (EDT, UTC-5 during Sept DST... actually UTC-4).
        // 15:50 ET = 19:50 UTC. Inside the 15:44-15:59 ET run window.
        jest.setSystemTime(new Date('2026-09-19T19:50:00Z'));

        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        jest.doMock('../src/services/userDatabaseService', () => ({
            getUsersWithAITradingEnabled: jest.fn(),
            getUserAlpacaCredentials: jest.fn(),
        }));
        jest.doMock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));
        jest.doMock('../src/services/enhancedAITradingBot', () => ({ isMarketOpen: jest.fn() }));
        jest.doMock('../src/services/tradingControlService', () => ({ getGlobalTradingControl: jest.fn() }));
        jest.doMock('../src/services/redisStateService', () => ({
            pingAgentHealth: jest.fn().mockResolvedValue(),
            setHaltAll: jest.fn().mockResolvedValue(),
        }));
        jest.doMock('../src/services/vixSpikeMonitorService', () => ({}));
        jest.doMock('../src/services/premarketGapAlertService', () => ({}));
        jest.doMock('../src/services/extendedHoursTradingService', () => ({}));
        jest.doMock('../src/services/marketRegimeService', () => ({ getMarketRegime: jest.fn() }));
        jest.doMock('../src/services/globalSentimentService', () => ({ getGlobalSentiment: jest.fn() }));
        jest.doMock('../src/services/brokerService', () => ({ eodCancelPartialFills: jest.fn().mockResolvedValue({ canceled: 0, journaled: 0 }) }));
        jest.doMock('../src/services/nightlyUniverseScanService', () => ({ runNightlyUniverseScan: jest.fn().mockResolvedValue(null) }));

        ({ runEodCleanup } = require('../src/services/enhancedAIScheduler'));
        query = require('../src/config/database').query;
        redisState = require('../src/services/redisStateService');
        alertService = require('../src/services/telegramAlertService');
        userDb = require('../src/services/userDatabaseService');

        userDb.getUsersWithAITradingEnabled.mockResolvedValue([{ id: 'user-1' }]);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    // Route the shared query mock: the anomaly detector's own query is the only one
    // selecting today_count / baseline_daily_avg; everything else (daily digest,
    // nightly scan kickoff) gets an empty result and is caught by its own try/catch.
    function mockAnomalyStats(stats) {
        query.mockImplementation((sql) => {
            if (sql.includes('today_count')) {
                return Promise.resolve({ rows: [stats] });
            }
            return Promise.resolve({ rows: [] });
        });
    }

    test('the anomaly query filters decision_phase = CLOSED, never the old invalid EXIT value', async () => {
        mockAnomalyStats({ today_count_raw: '0', baseline_daily_avg: null, today_wr: null, baseline_wr: null });

        await runEodCleanup();

        const anomalyCall = query.mock.calls.find(c => c[0].includes('today_count'));
        expect(anomalyCall).toBeDefined();
        expect(anomalyCall[0]).not.toMatch(/decision_phase\s*=\s*'EXIT'/);
        expect(anomalyCall[0]).toMatch(/decision_phase\s*=\s*'CLOSED'/);
    });

    test('engages HALT_ALL on a genuine strategy-breakdown day (real bug this fix now catches)', async () => {
        mockAnomalyStats({
            today_count_raw: '5',
            baseline_daily_avg: '4.0',
            today_wr: '10.0',   // < 20%
            baseline_wr: '55.0', // > 40%, so a real breakdown vs a healthy baseline
        });

        await runEodCleanup();

        expect(redisState.setHaltAll).toHaveBeenCalledWith(expect.stringContaining('Strategy breakdown'));
        expect(alertService.sendMessage).toHaveBeenCalledWith('user-1', expect.stringContaining('AUTO-PAUSE ACTIVATED'));
    });

    test('does not falsely engage HALT_ALL on a normal, unremarkable day', async () => {
        mockAnomalyStats({
            today_count_raw: '3',
            baseline_daily_avg: '3.5',
            today_wr: '50.0',
            baseline_wr: '48.0',
        });

        await runEodCleanup();

        expect(redisState.setHaltAll).not.toHaveBeenCalled();
    });
});
