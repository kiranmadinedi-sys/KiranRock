jest.mock('axios');
jest.mock('../src/services/userDatabaseService', () => ({
    getUserAlpacaCredentials: jest.fn().mockResolvedValue({ isPaper: true, keyId: 'k', secretKey: 's' }),
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
const brokerService = require('../src/services/brokerService');
const cryptoDb = require('../src/services/cryptoDatabaseService');
const userDb = require('../src/services/userDatabaseService');
const cryptoBrokerService = require('../src/services/cryptoBrokerService');

/**
 * 2026-09-20: SHIB/USD's take-profit exit was rejected 403 "insufficient balance"
 * every 5-min cycle. crypto_positions.quantity is stored at 8 decimals and had
 * rounded UP (96359707.06155586) past Alpaca's real 9-decimal holding
 * (96359707.061555858); both parse to the same double, so Math.min() sent the
 * rounded-up string. The sell qty is now truncated, never rounded.
 */
describe('sellCrypto — sell quantity never exceeds the real Alpaca holding', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        userDb.getUserAlpacaCredentials.mockResolvedValue({ isPaper: true, keyId: 'k', secretKey: 's' });
        brokerService.getOpenOrders.mockResolvedValue([]);
        cryptoDb.closePosition.mockResolvedValue({});
        axios.post.mockResolvedValue({ data: { id: 'o1', status: 'filled', filled_avg_price: '0.00000549' } });
    });

    test('SHIB: DB qty rounded up past the real holding -> submits the truncated real qty', async () => {
        cryptoDb.getPosition.mockResolvedValue({ quantity: '96359707.06155586', average_price: '0.00000527', current_price: '0.00000555' });
        brokerService.getPosition.mockResolvedValue({ qty: '96359707.061555858' });

        await cryptoBrokerService.sellCrypto('u', 'SHIB/USD', { exitReason: 'take-profit' });

        const body = axios.post.mock.calls.find(c => c[0].endsWith('/orders'))[1];
        expect(body.qty).toBe('96359707.06155585');
        expect(parseFloat(body.qty)).toBeLessThanOrEqual(96359707.061555858);
    });

    test('DB qty smaller than the real holding -> sells the DB qty (partial tracking preserved)', async () => {
        cryptoDb.getPosition.mockResolvedValue({ quantity: '10.5', average_price: '1', current_price: '1' });
        brokerService.getPosition.mockResolvedValue({ qty: '12.25' });

        await cryptoBrokerService.sellCrypto('u', 'XRP/USD', { exitReason: 'take-profit' });

        expect(axios.post.mock.calls.find(c => c[0].endsWith('/orders'))[1].qty).toBe('10.5');
    });

    test('_truncDecimals truncates rather than rounds and leaves short values alone', () => {
        const { _truncDecimals } = cryptoBrokerService;
        expect(_truncDecimals('1.999999999', 8)).toBe('1.99999999');
        expect(_truncDecimals('5', 8)).toBe('5');
        expect(_truncDecimals(8.42461767, 8)).toBe('8.42461767');
    });

    /**
     * 2026-09-24: caught while adding a dust-position check elsewhere, before it
     * shipped. A raw JS number smaller than 1e-6 stringifies in exponential
     * notation (String(0.000000006) === "6e-9"), which has no "." for the old
     * implementation to find — the value passed through completely untruncated
     * instead of correctly truncating to zero. Every existing production call
     * site happens to pass a string, not a number, so this never fired live,
     * but it's a correctness bug in the function itself.
     */
    test('_truncDecimals correctly truncates a tiny NUMBER input instead of passing it through via exponential notation', () => {
        const { _truncDecimals } = cryptoBrokerService;
        expect(_truncDecimals(0.000000006, 8)).toBe('0.00000000');
        expect(parseFloat(_truncDecimals(0.000000006, 8))).toBe(0);
        // A tiny value already given as a string (the real production shape) truncates correctly too.
        expect(_truncDecimals('0.000000006', 8)).toBe('0.00000000');
    });
});
