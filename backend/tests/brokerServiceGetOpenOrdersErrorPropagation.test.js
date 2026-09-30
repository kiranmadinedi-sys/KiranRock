jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('@alpacahq/alpaca-trade-api', () => jest.fn().mockImplementation(() => ({})));

/**
 * 2026-09-30 real incident: brokerService.getOpenOrders() swallowed ANY failure
 * (this time, a DB connection-pool timeout on the Alpaca credential lookup) into a
 * bare `return []`. enhancedAITradingBot.js's per-cycle StopRepair has no .catch()
 * at its own call site — it relies entirely on this function either succeeding with
 * real data or throwing so its own outer try/catch can skip the cycle. Getting []
 * back instead made StopRepair conclude all 8 of a real account's actively-protected
 * positions had no stop, and it tried to place a duplicate stop on every one —
 * harmless only because Alpaca's own "insufficient qty available" check rejected
 * each attempt (the real stops were never touched), but the exact same failure SHAPE
 * as the 2026-09-24 incident this was already supposed to have fixed (that fix
 * removed the swallow at the ENHANCEDAITRADINGBOT.JS call site; this function's own
 * internal swallow, one layer down, silently undid it). Fixed to propagate instead.
 */
describe('brokerService.getOpenOrders — propagates failures instead of swallowing to []', () => {
    let brokerService, userDb;

    beforeEach(() => {
        jest.resetModules();
        process.env.BROKER = 'alpaca';

        jest.doMock('../src/services/userDatabaseService', () => ({
            getUserAlpacaCredentials: jest.fn(),
        }));

        brokerService = require('../src/services/brokerService');
        userDb = require('../src/services/userDatabaseService');
    });

    test('a credential-lookup failure (e.g. a DB timeout) propagates rather than resolving to []', async () => {
        userDb.getUserAlpacaCredentials.mockRejectedValue(
            new Error('Connection terminated due to connection timeout')
        );

        await expect(brokerService.getOpenOrders('user-1')).rejects.toThrow(/connection timeout/);
    });

    test('a real empty order list still resolves normally (no false failures introduced)', async () => {
        userDb.getUserAlpacaCredentials.mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true });
        const AlpacaCtor = require('@alpacahq/alpaca-trade-api');
        AlpacaCtor.mockImplementation(() => ({ getOrders: jest.fn().mockResolvedValue([]) }));

        await expect(brokerService.getOpenOrders('user-1')).resolves.toEqual([]);
    });
});
