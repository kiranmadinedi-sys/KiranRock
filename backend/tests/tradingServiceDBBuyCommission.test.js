const { transaction } = require('../src/config/database');

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

const dataProvider = require('../src/services/dataProvider');
const tradingServiceDB = require('../src/services/tradingServiceDB');

/**
 * Companion to tradingServiceDBSellCommission.test.js -- the buy side had the
 * identical synthetic 0.1% commission bug, found the same night but only
 * fixed on the sell side at the time. Fixed here 2026-09-09: a broker-
 * confirmed (real Alpaca fill) buy now pays Alpaca's real $0 commission,
 * matching the sell-side fix and the internal-balance skip that already
 * existed on this path.
 */
describe('tradingServiceDB.executeBuyOrder — commission accuracy', () => {
    let fakeClient;
    let queries;

    beforeEach(() => {
        dataProvider.getQuote.mockResolvedValue({ price: 100 });
        queries = [];
        fakeClient = { query: jest.fn() };
        fakeClient.query.mockImplementation((sql, params) => {
            queries.push({ sql, params });
            if (sql.includes('SELECT * FROM holdings')) return Promise.resolve({ rows: [] });
            if (sql.includes('INSERT INTO holdings')) return Promise.resolve({ rows: [] });
            if (sql.includes('INSERT INTO trades')) {
                return Promise.resolve({ rows: [{ id: 1, symbol: 'NVDA', price: '100', ai_score: 90, sector: 'Technology' }] });
            }
            if (sql.includes('INSERT INTO trade_lots')) return Promise.resolve({ rows: [] });
            return Promise.resolve({ rows: [] });
        });
        transaction.mockImplementation(async (callback) => callback(fakeClient));
    });

    test('a broker-confirmed buy (real fill price) charges zero commission and skips the internal balance debit', async () => {
        await tradingServiceDB.executeBuyOrder('user-1', 'NVDA', 5, 'AI_BOT', 90, 'Technology', null, 100 /* fillPrice */);

        const insertTrade = queries.find(q => q.sql.includes('INSERT INTO trades'));
        expect(insertTrade.params[5]).toBe(0); // commission column

        const balanceUpdate = queries.find(q => q.sql.includes('UPDATE trading_accounts SET balance'));
        expect(balanceUpdate).toBeUndefined();
    });

    test('a paper/manual buy (no fill price) still simulates the 0.1% commission and debits the internal balance', async () => {
        fakeClient.query.mockImplementation((sql, params) => {
            queries.push({ sql, params });
            if (sql.includes('SELECT balance FROM trading_accounts')) return Promise.resolve({ rows: [{ balance: '10000' }] });
            if (sql.includes('SELECT * FROM holdings')) return Promise.resolve({ rows: [] });
            if (sql.includes('INSERT INTO holdings')) return Promise.resolve({ rows: [] });
            if (sql.includes('INSERT INTO trades')) {
                return Promise.resolve({ rows: [{ id: 1, symbol: 'NVDA', price: '100', ai_score: 90, sector: 'Technology' }] });
            }
            if (sql.includes('INSERT INTO trade_lots')) return Promise.resolve({ rows: [] });
            return Promise.resolve({ rows: [] });
        });

        await tradingServiceDB.executeBuyOrder('user-1', 'NVDA', 5, 'MANUAL', 90, 'Technology', null, null /* no fillPrice */);

        const insertTrade = queries.find(q => q.sql.includes('INSERT INTO trades'));
        expect(insertTrade.params[5]).toBeCloseTo(0.50, 5); // 100*5*0.001

        const balanceUpdate = queries.find(q => q.sql.includes('UPDATE trading_accounts SET balance'));
        expect(balanceUpdate).toBeDefined();
        expect(balanceUpdate.params[0]).toBeCloseTo(500.50, 5); // totalWithCommission
    });
});
