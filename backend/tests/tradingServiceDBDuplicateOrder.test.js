const { transaction, query } = require('../src/config/database');

jest.mock('../src/config/database', () => ({
    transaction: jest.fn(),
    query: jest.fn(),
}));
jest.mock('../src/services/dataProvider', () => ({
    getQuote: jest.fn(),
}));
jest.mock('../src/services/tradeForwardTrackingService', () => ({
    recordTradeEntry: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/services/tradesDatabaseService', () => ({
    ensureBrokerOrderIdColumn: jest.fn().mockResolvedValue(),
}));

const dataProvider = require('../src/services/dataProvider');
const tradingServiceDB = require('../src/services/tradingServiceDB');

/**
 * 2026-09-19: kmadined's ORCL buy got recorded twice — once by the live
 * executeBuyOrder path, once by the reconciler's SHADOW backfill — each
 * unaware of the other, because nothing made a second insert for the same
 * real Alpaca order impossible. Fixed with a new trailing `brokerOrderId`
 * param (backward compatible — every existing caller omits it and behaves
 * exactly as before) plus a real unique index on (user_id, broker_order_id).
 * These tests cover the new duplicate-resolution path: a unique-violation on
 * that index must resolve to the already-recorded row, not throw — the
 * transaction already rolled back cleanly (config/database.js's transaction()),
 * so holdings/balance were never double-applied.
 */
function makeUniqueViolationError() {
    const err = new Error('duplicate key value violates unique constraint "idx_trades_broker_order_unique"');
    err.code = '23505';
    return err;
}

describe('tradingServiceDB — broker_order_id duplicate guard (2026-09-19)', () => {
    let fakeClient;
    let queries;

    beforeEach(() => {
        dataProvider.getQuote.mockResolvedValue({ price: 100 });
        query.mockReset();
        queries = [];
        fakeClient = { query: jest.fn() };
        transaction.mockImplementation(async (callback) => callback(fakeClient));
    });

    describe('executeBuyOrder', () => {
        test('passes brokerOrderId through to the trades INSERT', async () => {
            fakeClient.query.mockImplementation((sql, params) => {
                queries.push({ sql, params });
                if (sql.includes('SELECT * FROM holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO trades')) {
                    return Promise.resolve({ rows: [{ id: 1, symbol: 'NVDA', price: '100' }] });
                }
                return Promise.resolve({ rows: [] });
            });

            await tradingServiceDB.executeBuyOrder(
                'user-1', 'NVDA', 5, 'AI_BOT', 90, 'Technology', null, 100, null, null, 'order-abc-123'
            );

            const insertTrade = queries.find(q => q.sql.includes('INSERT INTO trades'));
            expect(insertTrade.params).toContain('order-abc-123');
        });

        test('a unique-violation resolves to the already-recorded row instead of throwing', async () => {
            fakeClient.query.mockImplementation((sql) => {
                if (sql.includes('SELECT * FROM holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO trades')) return Promise.reject(makeUniqueViolationError());
                return Promise.resolve({ rows: [] });
            });
            query.mockResolvedValue({
                rows: [{ id: 863, symbol: 'ORCL', price: '156.57', quantity: '1', total: '156.57', commission: '0', entry_regime: 'BULL' }],
            });

            const result = await tradingServiceDB.executeBuyOrder(
                'user-1', 'ORCL', 1, 'ALPACA_LIVE', null, null, null, 156.57, null, null, 'order-real-1'
            );

            expect(result.duplicate).toBe(true);
            expect(result.success).toBe(true);
            expect(result.trade.id).toBe(863);
            // Looked up by the SAME user + broker order id that collided.
            const lookupCall = query.mock.calls.find(c => c[0].includes('SELECT * FROM trades'));
            expect(lookupCall[1]).toEqual(['user-1', 'order-real-1']);
        });

        test('a unique-violation with no matching row (edge case) still surfaces the original error', async () => {
            fakeClient.query.mockImplementation((sql) => {
                if (sql.includes('SELECT * FROM holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO trades')) return Promise.reject(makeUniqueViolationError());
                return Promise.resolve({ rows: [] });
            });
            query.mockResolvedValue({ rows: [] }); // lookup finds nothing — shouldn't happen, but must not hang

            await expect(tradingServiceDB.executeBuyOrder(
                'user-1', 'ORCL', 1, 'ALPACA_LIVE', null, null, null, 156.57, null, null, 'order-real-1'
            )).rejects.toThrow(/unique constraint/);
        });

        test('a plain DB error (not a unique violation) still throws normally', async () => {
            fakeClient.query.mockImplementation((sql) => {
                if (sql.includes('SELECT * FROM holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO trades')) return Promise.reject(new Error('connection terminated'));
                return Promise.resolve({ rows: [] });
            });

            await expect(tradingServiceDB.executeBuyOrder(
                'user-1', 'NVDA', 5, 'AI_BOT', null, null, null, 100, null, null, 'order-xyz'
            )).rejects.toThrow('connection terminated');
        });

        test('backward compatible: omitting brokerOrderId records NULL, exactly like before this fix', async () => {
            fakeClient.query.mockImplementation((sql, params) => {
                queries.push({ sql, params });
                if (sql.includes('SELECT * FROM holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO trades')) return Promise.resolve({ rows: [{ id: 1 }] });
                return Promise.resolve({ rows: [] });
            });

            await tradingServiceDB.executeBuyOrder('user-1', 'NVDA', 5, 'ALPACA_LIVE', null, null, null, 100);

            const insertTrade = queries.find(q => q.sql.includes('INSERT INTO trades'));
            expect(insertTrade.params[insertTrade.params.length - 1]).toBeNull();
        });
    });

    describe('executeSellOrder', () => {
        function mockHolding() {
            fakeClient.query.mockImplementation((sql, params) => {
                queries.push({ sql, params });
                if (sql.includes('SELECT * FROM holdings')) {
                    return Promise.resolve({ rows: [{ quantity: 10, average_price: 100 }] });
                }
                if (sql.includes('UPDATE holdings') || sql.includes('DELETE FROM holdings')) return Promise.resolve({ rows: [] });
                if (sql.includes('SELECT ai_score')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO trades')) return Promise.resolve({ rows: [{ id: 2, symbol: 'NVDA' }] });
                return Promise.resolve({ rows: [] });
            });
        }

        test('passes brokerOrderId through to the trades INSERT', async () => {
            mockHolding();

            await tradingServiceDB.executeSellOrder('user-1', 'NVDA', 5, 'ALPACA_LIVE', '', 110, 'sell-order-1');

            const insertTrade = queries.find(q => q.sql.includes('INSERT INTO trades'));
            expect(insertTrade.params).toContain('sell-order-1');
        });

        test('a unique-violation on the sell side also resolves instead of throwing', async () => {
            fakeClient.query.mockImplementation((sql) => {
                if (sql.includes('SELECT * FROM holdings')) return Promise.resolve({ rows: [{ quantity: 10, average_price: 100 }] });
                if (sql.includes('SELECT ai_score')) return Promise.resolve({ rows: [] });
                if (sql.includes('INSERT INTO trades')) return Promise.reject(makeUniqueViolationError());
                return Promise.resolve({ rows: [] });
            });
            query.mockResolvedValue({
                rows: [{ id: 862, symbol: 'ORCL', price: '143.37', quantity: '1', total: '143.37', commission: '0', pnl: '-12.87', pnl_percent: '-7.78' }],
            });

            const result = await tradingServiceDB.executeSellOrder(
                'user-1', 'ORCL', 1, 'ALPACA_LIVE', 'Stop-loss triggered', 143.37, 'sell-order-real'
            );

            expect(result.duplicate).toBe(true);
            expect(result.trade.id).toBe(862);
            expect(result.profitLoss).toBeCloseTo(-12.87, 5);
        });
    });
});
