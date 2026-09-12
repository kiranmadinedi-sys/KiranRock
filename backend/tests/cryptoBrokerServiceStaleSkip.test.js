jest.mock('axios');
jest.mock('../src/services/userDatabaseService', () => ({
    getUserAlpacaCredentials: jest.fn(),
}));
jest.mock('../src/services/brokerService', () => ({
    getPosition: jest.fn(),
    getOpenOrders: jest.fn().mockResolvedValue([]),
    cancelOrder: jest.fn(),
}));
jest.mock('../src/services/cryptoDatabaseService', () => ({
    getPosition: jest.fn(),
    closePosition: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const axios = require('axios');
const userDb = require('../src/services/userDatabaseService');
const brokerService = require('../src/services/brokerService');
const cryptoDb = require('../src/services/cryptoDatabaseService');
const cryptoBrokerService = require('../src/services/cryptoBrokerService');

/**
 * The "stale_skip" path in sellCrypto: our tracking says a position should be
 * closed, but Alpaca already shows zero real quantity -- almost always because
 * the real resting stop-loss/take-profit order already filled. Found
 * 2026-09-12: the old code guessed the exit price from position.current_price
 * (a stale cached value) instead of looking up the real fill, producing two
 * historical trades off by $8-26 of recorded P&L even though the position
 * itself closed safely. Fixed to fetch the real closing order from Alpaca.
 */
describe('cryptoBrokerService.sellCrypto — stale_skip real-fill lookup', () => {
    beforeEach(() => {
        userDb.getUserAlpacaCredentials.mockResolvedValue({ isPaper: true, keyId: 'k', secretKey: 's' });
        cryptoDb.getPosition.mockResolvedValue({
            quantity: '71.20371757', average_price: '7.014', current_price: '6.75745', opened_at: '2026-09-08T01:20:00Z',
        });
        cryptoDb.closePosition.mockResolvedValue({});
        // No real position left at Alpaca -- triggers the stale_skip branch.
        brokerService.getPosition.mockResolvedValue({ qty: '0' });
    });

    test('uses the real Alpaca fill price/time when a matching closed sell order is found', async () => {
        axios.get.mockResolvedValue({
            data: [
                { side: 'sell', status: 'filled', filled_avg_price: '6.86783', filled_at: '2026-09-08T13:40:45.416884Z' },
            ],
        });

        await cryptoBrokerService.sellCrypto('user-1', 'UNI/USD', { exitReason: 'stop-loss-backstop' });

        expect(cryptoDb.closePosition).toHaveBeenCalledWith('user-1', 'UNI/USD', expect.objectContaining({
            exitPrice: 6.86783,
            exitTime: '2026-09-08T13:40:45.416884Z',
            exitReason: 'stop-loss-backstop_stale_skip',
        }));
    });

    test('falls back to the cached-price estimate when no closed sell order is found', async () => {
        axios.get.mockResolvedValue({ data: [] });

        await cryptoBrokerService.sellCrypto('user-1', 'UNI/USD', { exitReason: 'stop-loss-backstop' });

        expect(cryptoDb.closePosition).toHaveBeenCalledWith('user-1', 'UNI/USD', expect.objectContaining({
            exitPrice: 6.75745, // position.current_price fallback
            exitTime: null,
            exitReason: 'stop-loss-backstop_stale_skip',
        }));
    });

    test('falls back gracefully when the Alpaca order lookup itself fails', async () => {
        axios.get.mockRejectedValue(new Error('network error'));

        await expect(
            cryptoBrokerService.sellCrypto('user-1', 'UNI/USD', { exitReason: 'stop-loss-backstop' })
        ).resolves.toBeNull();

        expect(cryptoDb.closePosition).toHaveBeenCalledWith('user-1', 'UNI/USD', expect.objectContaining({
            exitPrice: 6.75745,
            exitReason: 'stop-loss-backstop_stale_skip',
        }));
    });
});
