/** 2026-09-20: Friday 16:10 ET weekly $/day report trigger — once per Friday, never other days/times. */
describe('enhancedAIScheduler.runWeeklyPnlReport', () => {
    let runWeeklyPnlReport, send;

    function load(isoTime) {
        jest.resetModules();
        jest.useFakeTimers();
        jest.setSystemTime(new Date(isoTime));
        send = jest.fn().mockResolvedValue({});
        jest.doMock('../src/services/dailyPnlTargetService', () => ({ sendWeeklyPnlReports: send }));
        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        jest.doMock('../src/services/userDatabaseService', () => ({ getUsersWithAITradingEnabled: jest.fn(), getUserAlpacaCredentials: jest.fn() }));
        jest.doMock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));
        jest.doMock('../src/services/enhancedAITradingBot', () => ({ isMarketOpen: jest.fn() }));
        jest.doMock('../src/services/tradingControlService', () => ({ getGlobalTradingControl: jest.fn() }));
        jest.doMock('../src/services/redisStateService', () => ({}));
        jest.doMock('../src/services/vixSpikeMonitorService', () => ({}));
        jest.doMock('../src/services/premarketGapAlertService', () => ({}));
        jest.doMock('../src/services/extendedHoursTradingService', () => ({}));
        jest.doMock('../src/services/marketRegimeService', () => ({ getMarketRegime: jest.fn() }));
        jest.doMock('../src/services/globalSentimentService', () => ({ getGlobalSentiment: jest.fn() }));
        ({ runWeeklyPnlReport } = require('../src/services/enhancedAIScheduler'));
    }

    afterEach(() => jest.useRealTimers());

    test('fires on Friday 16:10 ET, and only once that day', async () => {
        load('2026-09-18T20:10:00Z'); // Fri 16:10 EDT
        await runWeeklyPnlReport();
        await runWeeklyPnlReport();
        expect(send).toHaveBeenCalledTimes(1);
    });

    test('does not fire before 16:10 ET on Friday', async () => {
        load('2026-09-18T20:05:00Z');
        await runWeeklyPnlReport();
        expect(send).not.toHaveBeenCalled();
    });

    test('does not fire on other weekdays', async () => {
        load('2026-09-17T20:10:00Z'); // Thursday
        await runWeeklyPnlReport();
        expect(send).not.toHaveBeenCalled();
    });
});
