jest.mock('axios');
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/userDatabaseService', () => ({ getUserAlpacaCredentials: jest.fn() }));
jest.mock('../src/services/tradesDatabaseService', () => ({ recordTrade: jest.fn(), ensureBrokerOrderIdColumn: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/tradeIntelligenceService', () => ({ closeLatestOpenExecution: jest.fn().mockResolvedValue() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const axios = require('axios');
const { query } = require('../src/config/database');
const userDb = require('../src/services/userDatabaseService');
const tradeIntel = require('../src/services/tradeIntelligenceService');
const { reconcilePositions } = require('../src/services/positionReconciliationService');

/**
 * 2026-10-06 real incident: anilboddu1's AEHR stop filled once at the broker, but two
 * reconcile runs (different triggers) both found the stale holdings row and both wrote a
 * SELL in the same millisecond, with no broker_order_id — so the partial
 * UNIQUE(user_id, broker_order_id) index couldn't catch it — doubling the realized loss.
 */
describe('PHANTOM exit recording — concurrent reconcile runs', () => {
    const userId = 'user-1';
    let holdingDeleted, inserts, insertConflict;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.BROKER = 'alpaca';
        holdingDeleted = false;
        inserts = [];
        insertConflict = false;
        userDb.getUserAlpacaCredentials.mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: false });

        query.mockImplementation(async (sql, params) => {
            if (/DELETE FROM holdings/.test(sql)) {
                // Postgres row lock: only the first DELETE actually removes the row.
                if (holdingDeleted) return { rows: [], rowCount: 0 };
                holdingDeleted = true;
                return { rows: [{ id: 1 }], rowCount: 1 };
            }
            if (/INSERT INTO trades/.test(sql)) {
                inserts.push({ sql, params });
                return insertConflict ? { rows: [], rowCount: 0 } : { rows: [{ id: 99 }], rowCount: 1 };
            }
            if (/FROM holdings/.test(sql)) {
                return { rows: [{ symbol: 'AEHR', quantity: '1', average_price: '102.47', current_price: '96' }] };
            }
            return { rows: [], rowCount: 0 };
        });

        axios.get.mockImplementation(async (url) => {
            if (/\/positions/.test(url)) return { data: [] }; // broker: position gone (stop filled)
            if (/\/account\/activities/.test(url)) {
                return { data: [{ symbol: 'AEHR', side: 'sell', price: '96.1009', transaction_time: '2026-10-06T19:01:49Z', order_id: 'fill-order-90c16d7f' }] };
            }
            if (/\/orders\//.test(url)) return { data: { type: 'stop', filled_qty: '1' } };
            return { data: [] };
        });
    });

    test('two runs at once record exactly one SELL', async () => {
        await Promise.all([reconcilePositions(userId), reconcilePositions(userId)]);
        expect(inserts).toHaveLength(1);
        expect(tradeIntel.closeLatestOpenExecution).toHaveBeenCalledTimes(1);
    });

    test('the SELL carries the fill\'s broker order id and is guarded by the unique index', async () => {
        await reconcilePositions(userId);
        expect(inserts).toHaveLength(1);
        expect(inserts[0].params).toContain('fill-order-90c16d7f');
        expect(inserts[0].sql).toMatch(/ON CONFLICT \(user_id, broker_order_id\) WHERE broker_order_id IS NOT NULL DO NOTHING/);
    });

    test('a fill another path already recorded is not journaled again', async () => {
        insertConflict = true; // e.g. the live exit path recorded the same broker order first
        await reconcilePositions(userId);
        expect(inserts).toHaveLength(1);
        expect(tradeIntel.closeLatestOpenExecution).not.toHaveBeenCalled();
    });
});
