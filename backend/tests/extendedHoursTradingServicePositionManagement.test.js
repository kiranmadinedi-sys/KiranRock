jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/userDatabaseService', () => ({
    getUsersWithAITradingEnabled: jest.fn(),
}));
jest.mock('../src/services/enhancedAITradingBot', () => ({
    manageExistingPositions: jest.fn(),
    scanMarketForOpportunities: jest.fn(),
    getUserRiskConfig: jest.fn(),
}));
jest.mock('../src/services/brokerService', () => ({ getAccountInfo: jest.fn() }));
jest.mock('../src/services/holdingsDatabaseService', () => ({ getUserHoldings: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { query } = require('../src/config/database');
const userDb = require('../src/services/userDatabaseService');
const enhancedAITradingBot = require('../src/services/enhancedAITradingBot');
const extendedHoursTradingService = require('../src/services/extendedHoursTradingService');

/**
 * Added 2026-09-12 alongside the fix: manageExistingPositions (trailing stops,
 * decay re-scoring, distress-mode tightening) previously only ran inside the
 * regular 9:30-4:00 ET cycle, leaving every account's open positions unmanaged
 * during the 4-9:30 AM / 4-8 PM windows real equity trading -- and a real
 * stop-loss fill -- can still happen. Measured live: positions caught by
 * reconciliation after this gap averaged an 89-hour delay and a net loss;
 * positions the loop actually got to manage were net positive.
 */
describe('extendedHoursTradingService — position management during extended hours', () => {
    beforeEach(() => {
        query.mockResolvedValue({ rows: [] });
        enhancedAITradingBot.manageExistingPositions.mockResolvedValue();
        enhancedAITradingBot.scanMarketForOpportunities.mockResolvedValue([]);
    });

    test('manageOpenPositionsDuringExtendedHours manages every active-AI-trading user, not just extended-hours-entry opt-ins', async () => {
        userDb.getUsersWithAITradingEnabled.mockResolvedValue([
            { id: 'user-A' }, { id: 'user-B' }, { id: 'user-C' },
        ]);

        await extendedHoursTradingService.manageOpenPositionsDuringExtendedHours();

        expect(enhancedAITradingBot.manageExistingPositions).toHaveBeenCalledTimes(3);
        expect(enhancedAITradingBot.manageExistingPositions).toHaveBeenCalledWith('user-A');
        expect(enhancedAITradingBot.manageExistingPositions).toHaveBeenCalledWith('user-B');
        expect(enhancedAITradingBot.manageExistingPositions).toHaveBeenCalledWith('user-C');
    });

    test('one user failing does not block position management for the others', async () => {
        userDb.getUsersWithAITradingEnabled.mockResolvedValue([{ id: 'user-A' }, { id: 'user-B' }]);
        enhancedAITradingBot.manageExistingPositions
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce();

        await expect(extendedHoursTradingService.manageOpenPositionsDuringExtendedHours()).resolves.toBeUndefined();

        expect(enhancedAITradingBot.manageExistingPositions).toHaveBeenCalledTimes(2);
    });

    test('does nothing when there are no active-AI-trading users', async () => {
        userDb.getUsersWithAITradingEnabled.mockResolvedValue([]);
        await extendedHoursTradingService.manageOpenPositionsDuringExtendedHours();
        expect(enhancedAITradingBot.manageExistingPositions).not.toHaveBeenCalled();
    });

    test('does nothing when the user lookup itself fails, rather than throwing', async () => {
        userDb.getUsersWithAITradingEnabled.mockRejectedValue(new Error('db down'));
        await expect(extendedHoursTradingService.manageOpenPositionsDuringExtendedHours()).resolves.toBeUndefined();
        expect(enhancedAITradingBot.manageExistingPositions).not.toHaveBeenCalled();
    });
});
