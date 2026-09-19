jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const { query } = require('../src/config/database');
const { recordTrade } = require('../src/services/tradesDatabaseService');

function findInsertCall() {
    return query.mock.calls.find(([sql]) => sql.includes('INSERT INTO trades'));
}

function makeUniqueViolationError() {
    const err = new Error('duplicate key value violates unique constraint "idx_trades_broker_order_unique"');
    err.code = '23505';
    return err;
}

/**
 * 2026-09-19: added alongside a real incident — kmadined's ORCL buy was
 * recorded twice, once by the live executeBuyOrder path and once by this
 * function's own SHADOW-backfill caller (positionReconciliationService.js),
 * each with no broker_order_id at all, so nothing could ever tell they were
 * the same fill. _ensureBrokerOrderIdColumn now also creates a real unique
 * index on (user_id, broker_order_id) WHERE broker_order_id IS NOT NULL, and
 * recordTrade catches a violation of it and resolves to the already-recorded
 * row (tagged `_duplicate: true`) instead of throwing.
 */
describe('tradesDatabaseService.recordTrade — duplicate broker_order_id (2026-09-19)', () => {
    beforeEach(() => {
        query.mockReset();
    });

    test('_ensureBrokerOrderIdColumn creates the unique index, not just the old non-unique one', async () => {
        query.mockResolvedValue({ rows: [{ id: 1 }] });

        await recordTrade({ userId: 'u1', symbol: 'NVDA', action: 'BUY', quantity: 1, price: 100, total: 100 });

        const ddlCalls = query.mock.calls.map(c => c[0]);
        expect(ddlCalls.some(sql => sql.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_trades_broker_order_unique'))).toBe(true);
    });

    test('passes brokerOrderId through as the 16th bind param', async () => {
        query.mockResolvedValue({ rows: [{ id: 1 }] });

        await recordTrade({
            userId: 'u1', symbol: 'ORCL', action: 'BUY', quantity: 1, price: 156.57, total: 156.57,
            brokerOrderId: '8ba07571-real-order',
        });

        const [, params] = findInsertCall();
        expect(params[params.length - 1]).toBe('8ba07571-real-order');
    });

    test('a unique-violation resolves to the existing row tagged _duplicate, instead of throwing', async () => {
        query.mockImplementation((sql, params) => {
            if (sql.includes('INSERT INTO trades')) return Promise.reject(makeUniqueViolationError());
            if (sql.includes('SELECT * FROM trades WHERE user_id')) {
                return Promise.resolve({ rows: [{ id: 863, symbol: 'ORCL', broker_order_id: params[1] }] });
            }
            return Promise.resolve({ rows: [] });
        });

        const result = await recordTrade({
            userId: 'u1', symbol: 'ORCL', action: 'BUY', quantity: 1, price: 156.5676, total: 156.5676,
            executedBy: 'reconciler', brokerOrderId: 'afbd9a35-real-order',
        });

        expect(result._duplicate).toBe(true);
        expect(result.id).toBe(863);
        // Looked up scoped to the same user AND the colliding order id.
        const lookupCall = query.mock.calls.find(c => c[0].includes('SELECT * FROM trades WHERE user_id'));
        expect(lookupCall[1]).toEqual(['u1', 'afbd9a35-real-order']);
    });

    test('a unique-violation with no brokerOrderId provided still throws (can only happen if the DB itself is inconsistent)', async () => {
        query.mockImplementation((sql) => {
            if (sql.includes('INSERT INTO trades')) return Promise.reject(makeUniqueViolationError());
            return Promise.resolve({ rows: [] });
        });

        await expect(recordTrade({
            userId: 'u1', symbol: 'NVDA', action: 'BUY', quantity: 1, price: 100, total: 100,
        })).rejects.toThrow(/unique constraint/);
    });

    test('a non-duplicate DB error still propagates unchanged', async () => {
        query.mockImplementation((sql) => {
            if (sql.includes('INSERT INTO trades')) return Promise.reject(new Error('connection terminated'));
            return Promise.resolve({ rows: [] });
        });

        await expect(recordTrade({
            userId: 'u1', symbol: 'NVDA', action: 'BUY', quantity: 1, price: 100, total: 100, brokerOrderId: 'x',
        })).rejects.toThrow('connection terminated');
    });
});
