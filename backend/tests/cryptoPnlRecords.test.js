/**
 * Crypto P&L records must match the broker (2026-11-22).
 *
 * Found: the bot's crypto_trades summed to about +$3 while Alpaca's real fills showed −$215.
 *  1. The "position already closed at Alpaca" path took the newest filled sell among the last
 *     5 closed orders, with no date check. SOL bought 11-06 @ 89.78 really stopped out @ 87.93,
 *     but was recorded at an OLD 09-19 sell @ 112.59 → a fake +$126.75.
 *  2. P&L ignored Alpaca's 0.25% crypto fees (coin taken on the buy, USD taken on the sell).
 */
jest.mock('axios');
jest.mock('../src/services/userDatabaseService', () => ({ getUserAlpacaCredentials: jest.fn() }));
jest.mock('../src/services/brokerService', () => ({
    getPosition: jest.fn(), getOpenOrders: jest.fn().mockResolvedValue([]), cancelOrder: jest.fn(),
}));
jest.mock('../src/services/cryptoDatabaseService', () => {
    const real = jest.requireActual('../src/services/cryptoDatabaseService');
    return { getPosition: jest.fn(), closePosition: jest.fn(), netPnl: real.netPnl };
});
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const axios = require('axios');
const userDb = require('../src/services/userDatabaseService');
const brokerService = require('../src/services/brokerService');
const cryptoDb = require('../src/services/cryptoDatabaseService');
const cryptoBroker = require('../src/services/cryptoBrokerService');

// The real SOL orders from the paper account.
const OLD_SELL = { side: 'sell', status: 'filled', type: 'market', filled_qty: '5.020510', filled_avg_price: '112.59', filled_at: '2026-09-19T00:05:00Z' };
const REAL_STOP = { side: 'sell', status: 'filled', type: 'stop_limit', filled_qty: '5.556694', filled_avg_price: '87.93', filled_at: '2026-11-08T21:47:00Z' };
const BUY = { side: 'buy', status: 'filled', type: 'market', filled_qty: '5.570621', filled_avg_price: '89.78', filled_at: '2026-11-06T00:20:00Z' };

describe('closing a position the broker already sold', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        userDb.getUserAlpacaCredentials.mockResolvedValue({ isPaper: true, keyId: 'k', secretKey: 's' });
        brokerService.getPosition.mockResolvedValue(null); // gone at Alpaca
        cryptoDb.getPosition.mockResolvedValue({
            quantity: '5.556694', average_price: '89.78', current_price: '86', opened_at: '2026-11-06T00:20:00Z', broker_order_id: 'buy-1',
        });
        cryptoDb.closePosition.mockResolvedValue({ pnl: '-12.75' });
        axios.get.mockImplementation(async (url) => (/orders\/buy-1$/.test(url) ? { data: BUY } : { data: [OLD_SELL, REAL_STOP] }));
    });

    test('ignores sells from before the position opened (the SOL +$126.75 bug)', async () => {
        await cryptoBroker.sellCrypto('u', 'SOL/USD', { exitReason: 'reconciliation_ghost' });
        expect(cryptoDb.closePosition).toHaveBeenCalledWith('u', 'SOL/USD', expect.objectContaining({
            exitPrice: 87.93, exitTime: '2026-11-08T21:47:00Z', exitReason: 'broker-stop-filled', soldQty: 5.556694, buyQty: 5.570621,
        }));
        const params = axios.get.mock.calls.find(c => /\/orders$/.test(c[0]))[1].params;
        expect(params).toMatchObject({ status: 'closed', symbols: 'SOL/USD', direction: 'asc' });
        expect(new Date(params.after).getTime()).toBeLessThan(new Date('2026-11-06T00:20:00Z').getTime());
    });

    test('averages partial fills by quantity', async () => {
        axios.get.mockImplementation(async (url) => (/orders\/buy-1$/.test(url) ? { data: BUY } : { data: [
            { ...REAL_STOP, status: 'canceled', filled_qty: '2', filled_avg_price: '88', filled_at: '2026-11-08T21:40:00Z' },
            { ...REAL_STOP, filled_qty: '3', filled_avg_price: '87', filled_at: '2026-11-08T21:47:00Z' },
        ] }));
        await cryptoBroker.sellCrypto('u', 'SOL/USD', { exitReason: 'reconciliation_ghost' });
        const arg = cryptoDb.closePosition.mock.calls[0][2];
        expect(arg.exitPrice).toBeCloseTo(87.4, 6);
        expect(arg.soldQty).toBe(5);
        expect(arg.exitTime).toBe('2026-11-08T21:47:00Z');
    });

    test('no sell since opening → labelled "-estimated", never borrowed from an older trade', async () => {
        axios.get.mockImplementation(async (url) => (/orders\/buy-1$/.test(url) ? { data: BUY } : { data: [OLD_SELL] }));
        await cryptoBroker.sellCrypto('u', 'SOL/USD', { exitReason: 'reconciliation_ghost' });
        expect(cryptoDb.closePosition).toHaveBeenCalledWith('u', 'SOL/USD', expect.objectContaining({
            exitPrice: 86, exitTime: null, exitReason: 'reconciliation_ghost-estimated', soldQty: null,
        }));
    });

    test('a market (non-stop) broker sell is labelled with the reason + "-broker-fill"', async () => {
        axios.get.mockImplementation(async (url) => (/orders\/buy-1$/.test(url) ? { data: BUY } : { data: [{ ...REAL_STOP, type: 'market' }] }));
        await cryptoBroker.sellCrypto('u', 'SOL/USD', { exitReason: 'take-profit' });
        expect(cryptoDb.closePosition.mock.calls[0][2].exitReason).toBe('take-profit-broker-fill');
    });

    test('returns the recorded trade so a losing ghost close can start the cooldown', async () => {
        await expect(cryptoBroker.sellCrypto('u', 'SOL/USD', { exitReason: 'reconciliation_ghost' })).resolves.toEqual({ pnl: '-12.75' });
    });
});

describe('netPnl counts Alpaca crypto fees', () => {
    const { netPnl } = jest.requireActual('../src/services/cryptoDatabaseService');
    test('the real SOL trade: −$12.75 net, not the −$10.26 the fee-free formula gives', () => {
        const r = netPnl({ entryPrice: 89.78, exitPrice: 87.93, heldQty: 5.556694, buyQty: 5.570621, soldQty: 5.556694, rate: 0.0025 });
        expect(r.pnl).toBeCloseTo(-12.75, 2);
        expect(r.meta.exitFeeUsd).toBeCloseTo(1.2215, 3);
        expect(r.meta.entryFeeUsd).toBeCloseTo(1.2504, 3);
        expect(r.meta.grossPnlNoFees).toBeCloseTo(-10.28, 2);
        expect(r.pnlPercent).toBeCloseTo(-2.55, 2);
    });
    test('falls back to the held quantity when the broker quantities are unknown', () => {
        const r = netPnl({ entryPrice: 10, exitPrice: 11, heldQty: 10, rate: 0 });
        expect(r.pnl).toBeCloseTo(10, 6);
    });
});
