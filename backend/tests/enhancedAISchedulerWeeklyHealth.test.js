jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/userDatabaseService', () => ({
    getUsersWithAITradingEnabled: jest.fn(),
    getUserAlpacaCredentials: jest.fn(),
}));
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/enhancedAITradingBot', () => ({ isMarketOpen: jest.fn() }));
jest.mock('../src/services/tradingControlService', () => ({ getGlobalTradingControl: jest.fn() }));
jest.mock('../src/services/redisStateService', () => ({}));
jest.mock('../src/services/vixSpikeMonitorService', () => ({}));
jest.mock('../src/services/premarketGapAlertService', () => ({}));
jest.mock('../src/services/extendedHoursTradingService', () => ({}));
jest.mock('../src/services/marketRegimeService', () => ({ getMarketRegime: jest.fn() }));
jest.mock('../src/services/globalSentimentService', () => ({ getGlobalSentiment: jest.fn() }));
jest.mock('../src/services/historicalBacktestEngine', () => ({ runBacktest: jest.fn().mockResolvedValue({ winRate: 0.5, avgReturn: 0.01, sharpeRatio: 1, maxDrawdown: 0.05 }) }));

/**
 * 2026-09-19: five sections of this weekly report (win rate by score bucket,
 * win rate by regime, alpha decay, top/worst symbols, what-if simulator) all
 * filtered `decision_phase = 'EXIT'` — a value that has never existed in
 * trade_decision_journal's CHECK constraint, present since the table and this
 * report were introduced together on 2026-06-05. Every one of those queries
 * always matched zero rows, so those sections have been silently missing from
 * the weekly Telegram report (not shown as empty — just absent, since each is
 * guarded by `if (rows.length > 0)`) for over three months. This test confirms
 * the fixed 'CLOSED' filter.
 */
describe('enhancedAIScheduler.runWeeklyParameterHealthCheck (2026-09-19 EXIT->CLOSED fix)', () => {
    let runWeeklyParameterHealthCheck, query;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();
        // Friday, 15:45 ET (EDT, UTC-4 in September) = 19:45 UTC — inside the run window.
        jest.setSystemTime(new Date('2026-09-18T19:45:00Z')); // 2026-09-18 is a Friday

        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        jest.doMock('../src/services/userDatabaseService', () => ({
            getUsersWithAITradingEnabled: jest.fn().mockResolvedValue([{ id: 'user-1' }]),
            getUserAlpacaCredentials: jest.fn(),
        }));
        jest.doMock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));
        jest.doMock('../src/services/enhancedAITradingBot', () => ({ isMarketOpen: jest.fn() }));
        jest.doMock('../src/services/tradingControlService', () => ({ getGlobalTradingControl: jest.fn() }));
        jest.doMock('../src/services/redisStateService', () => ({}));
        jest.doMock('../src/services/vixSpikeMonitorService', () => ({}));
        jest.doMock('../src/services/premarketGapAlertService', () => ({}));
        jest.doMock('../src/services/extendedHoursTradingService', () => ({}));
        jest.doMock('../src/services/marketRegimeService', () => ({ getMarketRegime: jest.fn() }));
        jest.doMock('../src/services/globalSentimentService', () => ({ getGlobalSentiment: jest.fn() }));
        jest.doMock('../src/services/historicalBacktestEngine', () => ({
            runBacktest: jest.fn().mockResolvedValue({ winRate: 0.5, avgReturn: 0.01, sharpeRatio: 1, maxDrawdown: 0.05 }),
        }));

        ({ runWeeklyParameterHealthCheck } = require('../src/services/enhancedAIScheduler'));
        query = require('../src/config/database').query;
        query.mockResolvedValue({ rows: [] }); // empty everywhere is fine — just checking SQL text
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('none of the report queries use the old invalid EXIT value; the fixed ones use CLOSED', async () => {
        await runWeeklyParameterHealthCheck();

        expect(query.mock.calls.length).toBeGreaterThan(0);
        for (const call of query.mock.calls) {
            expect(call[0]).not.toMatch(/decision_phase\s*=\s*'EXIT'/);
        }
        const closedFilterCalls = query.mock.calls.filter(c => /decision_phase\s*=\s*'CLOSED'/.test(c[0]));
        // score bucket, regime, alpha decay, top/worst symbols, what-if = 5 sites
        expect(closedFilterCalls.length).toBe(5);
    });
});
