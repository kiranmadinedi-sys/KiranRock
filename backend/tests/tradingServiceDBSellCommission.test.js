const { transaction } = require('../src/config/database');

jest.mock('../src/config/database', () => ({
    transaction: jest.fn(),
    query: jest.fn(),
}));
jest.mock('../src/services/dataProvider', () => ({
    getQuote: jest.fn(),
}));

const dataProvider = require('../src/services/dataProvider');
const tradingServiceDB = require('../src/services/tradingServiceDB');

/**
 * Alpaca charges $0 commission on US equities. The old code applied a flat
 * 0.1% synthetic commission to every sell unconditionally -- it never touched
 * the realized P&L (pure price math), but it WAS silently deducted from the
 * internal virtual trading_accounts.balance for broker-confirmed (live)
 * trades, drifting that number away from Alpaca's real cash for a fee that
 * was never actually charged. Fixed 2026-09-09 to mirror the buy side's
 * existing brokerConfirmed pattern: skip the synthetic commission AND the
 * internal balance update entirely when a real fill price is present.
 */
describe('tradingServiceDB.executeSellOrder — commission accuracy', () => {
    let fakeClient;
    let queries;

    beforeEach(() => {
        dataProvider.getQuote.mockResolvedValue({ price: 110 });
        queries = [];
        fakeClient = { query: jest.fn() };
        fakeClient.query.mockImplementation((sql, params) => {
            queries.push({ sql, params });
            if (sql.includes('SELECT * FROM holdings')) {
                return Promise.resolve({ rows: [{ quantity: 10, average_price: 100 }] });
            }
            if (sql.includes('SELECT ai_score')) return Promise.resolve({ rows: [] });
            if (sql.includes('INSERT INTO trades')) {
                return Promise.resolve({ rows: [{ id: 1, symbol: 'NVDA', pnl: '100.0000' }] });
            }
            return Promise.resolve({ rows: [] });
        });
        transaction.mockImplementation(async (callback) => callback(fakeClient));
    });

    test('a broker-confirmed sell (real fill price) charges zero commission and skips the internal balance credit', async () => {
        await tradingServiceDB.executeSellOrder('user-1', 'NVDA', 10, 'AI_BOT', null, 110 /* fillPrice */);

        const insertTrade = queries.find(q => q.sql.includes('INSERT INTO trades'));
        expect(insertTrade.params[5]).toBe(0); // commission column

        const balanceUpdate = queries.find(q => q.sql.includes('UPDATE trading_accounts SET balance'));
        expect(balanceUpdate).toBeUndefined();
    });

    test('a paper/manual sell (no fill price) still simulates the 0.1% commission and credits the internal balance', async () => {
        await tradingServiceDB.executeSellOrder('user-1', 'NVDA', 10, 'MANUAL', null, null /* no fillPrice */);

        const insertTrade = queries.find(q => q.sql.includes('INSERT INTO trades'));
        expect(insertTrade.params[5]).toBeCloseTo(1.10, 5); // 110*10*0.001

        const balanceUpdate = queries.find(q => q.sql.includes('UPDATE trading_accounts SET balance'));
        expect(balanceUpdate).toBeDefined();
        expect(balanceUpdate.params[0]).toBeCloseTo(1100 - 1.10, 5); // netProceeds
    });

    test('realized P&L is identical whether or not a commission is charged -- pnl is pure price math', async () => {
        await tradingServiceDB.executeSellOrder('user-1', 'NVDA', 10, 'AI_BOT', null, 110);
        let insertTrade = queries.find(q => q.sql.includes('INSERT INTO trades'));
        const pnlBrokerConfirmed = insertTrade.params[8]; // pnl column

        queries = [];
        await tradingServiceDB.executeSellOrder('user-1', 'NVDA', 10, 'MANUAL', null, null);
        insertTrade = queries.find(q => q.sql.includes('INSERT INTO trades'));
        const pnlPaper = insertTrade.params[8];

        // (110 - 100) * 10 = 100, regardless of commission model
        expect(pnlBrokerConfirmed).toBeCloseTo(100, 5);
        expect(pnlPaper).toBeCloseTo(100, 5);
    });
});
