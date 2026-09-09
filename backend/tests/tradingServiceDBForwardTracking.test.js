const { transaction } = require('../src/config/database');

jest.mock('../src/config/database', () => ({
    transaction: jest.fn(),
    query: jest.fn(),
}));
jest.mock('../src/services/dataProvider', () => ({
    getQuote: jest.fn(),
}));
jest.mock('../src/services/tradeForwardTrackingService', () => ({
    recordTradeEntry: jest.fn(),
}));

const dataProvider = require('../src/services/dataProvider');
const tradeForwardTrackingService = require('../src/services/tradeForwardTrackingService');
const tradingServiceDB = require('../src/services/tradingServiceDB');

/**
 * These tests exist specifically because of the "preserve existing behavior"
 * requirement on the Gate Alpha Attribution instrumentation: recordTradeEntry
 * is fire-and-forget, added AFTER the real trade transaction commits. A real
 * BUY must succeed and return its normal result whether the tracking hook
 * succeeds, fails, or isn't awaited yet by the time the caller gets its answer.
 */
describe('tradingServiceDB.executeBuyOrder — forward-tracking instrumentation', () => {
    let fakeClient;

    beforeEach(() => {
        dataProvider.getQuote.mockResolvedValue({ price: 100 });
        tradeForwardTrackingService.recordTradeEntry.mockReset();
        tradeForwardTrackingService.recordTradeEntry.mockResolvedValue();

        fakeClient = { query: jest.fn() };
        // SELECT existing holding -> none found
        fakeClient.query.mockImplementation((sql) => {
            if (sql.includes('SELECT * FROM holdings')) return Promise.resolve({ rows: [] });
            if (sql.includes('INSERT INTO holdings')) return Promise.resolve({ rows: [] });
            if (sql.includes('INSERT INTO trades')) {
                return Promise.resolve({
                    rows: [{ id: 555, symbol: 'NVDA', price: '180.50', ai_score: 91, sector: 'Technology', entry_regime: 'BULL' }],
                });
            }
            if (sql.includes('INSERT INTO trade_lots')) return Promise.resolve({ rows: [] });
            return Promise.resolve({ rows: [] });
        });

        transaction.mockImplementation(async (callback) => callback(fakeClient));
    });

    test('a successful BUY still resolves normally when tracking succeeds', async () => {
        const result = await tradingServiceDB.executeBuyOrder(
            'user-1', 'NVDA', 1, 'AI_BOT', 91, 'Technology',
            JSON.stringify({ regime: 'BULL' }), 180.50
        );

        expect(result.success).toBe(true);
        expect(result.trade.id).toBe(555);
        expect(tradeForwardTrackingService.recordTradeEntry).toHaveBeenCalledWith(
            expect.objectContaining({ tradeId: 555, symbol: 'NVDA', userId: 'user-1', entryPrice: '180.50' })
        );
    });

    test('a successful BUY still resolves normally even if tracking throws synchronously', async () => {
        tradeForwardTrackingService.recordTradeEntry.mockImplementation(() => { throw new Error('boom'); });

        const result = await tradingServiceDB.executeBuyOrder(
            'user-1', 'NVDA', 1, 'AI_BOT', 91, 'Technology',
            JSON.stringify({ regime: 'BULL' }), 180.50
        );

        expect(result.success).toBe(true);
        expect(result.trade.id).toBe(555);
    });

    test('a successful BUY still resolves normally even if tracking rejects asynchronously', async () => {
        tradeForwardTrackingService.recordTradeEntry.mockRejectedValue(new Error('db down'));

        const result = await tradingServiceDB.executeBuyOrder(
            'user-1', 'NVDA', 1, 'AI_BOT', 91, 'Technology',
            JSON.stringify({ regime: 'BULL' }), 180.50
        );

        expect(result.success).toBe(true);
        expect(result.trade.id).toBe(555);
    });
});
