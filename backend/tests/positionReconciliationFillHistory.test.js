jest.mock('axios');
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/userDatabaseService', () => ({
    getUserAlpacaCredentials: jest.fn(),
}));
jest.mock('../src/services/tradesDatabaseService', () => ({
    recordTrade: jest.fn(),
    ensureBrokerOrderIdColumn: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/services/tradeIntelligenceService', () => ({}));
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const axios = require('axios');
const { query } = require('../src/config/database');
const userDb = require('../src/services/userDatabaseService');
const tradesDb = require('../src/services/tradesDatabaseService');
const { reconcileFillHistory } = require('../src/services/positionReconciliationService');

/**
 * Added 2026-09-17 alongside the fix. Real incident: a SOXL position went
 * 9→0→9→0→9 shares within about an hour on 2026-09-11 (a real stop-loss then
 * an immediate re-entry-and-exit) — both intermediate fills were completely
 * missing from `trades`, and reconcilePositions' PHANTOM/DRIFT/SHADOW checks
 * structurally could never have caught them, since they only ever compare
 * the CURRENT quantity snapshot and the share count matched at every check.
 *
 * reconcileFillHistory walks every real closed ORDER and matches it against
 * an existing trades row (by broker_order_id, or a symbol/action/qty/price/
 * time fuzzy match for older rows) — DETECT-AND-ALERT ONLY, never
 * auto-backfilled. Two live runs against real data while building this each
 * produced false positives before being caught and rolled back:
 *   1. Matching against raw per-partial-fill activities instead of
 *      per-order aggregates — one 189-share MEDS order that filled across 7
 *      partial executions looked like 7 separate missing trades.
 *   2. Even after switching to /v2/orders, a genuinely fragmented real order
 *      sequence (VEEA, an already-known messy multi-whipsaw day) produced a
 *      fill whose quantity (194) didn't line up with the nearest recorded
 *      trade (189) despite matching time and price closely.
 * A fuzzy match this imprecise is good enough to flag for a human; it is not
 * good enough to trust with an unattended write of real financial data.
 */
describe('positionReconciliationService.reconcileFillHistory', () => {
    const userId = 'user-1';

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.BROKER = 'alpaca';
        userDb.getUserAlpacaCredentials.mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true });
    });

    // `orders` are Alpaca /v2/orders-shaped: {symbol, side, filled_qty, filled_avg_price, filled_at, id}
    function mockOrders(orders) {
        axios.get.mockImplementation((url) => {
            if (url.includes('/orders')) return Promise.resolve({ data: orders });
            return Promise.resolve({ data: [] });
        });
    }

    test('a single order with multiple partial fills is treated as ONE fill, not several', async () => {
        // Real incident shape: one 189-share order, filled in 7 partial executions
        // at slightly different prices — Alpaca's /v2/orders reports it as a single
        // aggregated object (filled_qty: 189, filled_avg_price: the weighted avg),
        // exactly matching what recordTrade() already wrote.
        mockOrders([
            { symbol: 'MEDS', side: 'buy', filled_qty: '189', filled_avg_price: '5.8724', filled_at: '2026-09-16T14:01:06.131Z', id: 'ord-meds' },
        ]);
        query.mockResolvedValueOnce({
            rows: [{ id: 1, symbol: 'MEDS', action: 'BUY', quantity: '189', price: '5.90', broker_order_id: null, trade_date_utc: '2026-09-16T14:01:06.131Z' }],
        });

        const result = await reconcileFillHistory(userId);

        expect(result.missing).toEqual([]);
    });

    test('a fill with a matching trades row (fuzzy match) is left alone', async () => {
        mockOrders([
            { symbol: 'AAPL', side: 'buy', filled_qty: '10', filled_avg_price: '150.00', filled_at: '2026-09-11T19:01:10.000Z', id: 'ord-1' },
        ]);
        query.mockResolvedValueOnce({
            rows: [{ id: 1, symbol: 'AAPL', action: 'BUY', quantity: '10', price: '150.01', broker_order_id: null, trade_date_utc: '2026-09-11T19:01:11.000Z' }],
        });

        const result = await reconcileFillHistory(userId);

        expect(result.missing).toEqual([]);
    });

    test('matches by exact broker_order_id even outside the fuzzy tolerance', async () => {
        mockOrders([
            { symbol: 'AAPL', side: 'buy', filled_qty: '10', filled_avg_price: '150.00', filled_at: '2026-09-11T19:01:10.000Z', id: 'ord-1' },
        ]);
        query.mockResolvedValueOnce({
            // Price wildly outside tolerance, but the order id matches exactly.
            rows: [{ id: 1, symbol: 'AAPL', action: 'BUY', quantity: '10', price: '999.00', broker_order_id: 'ord-1', trade_date_utc: '2026-01-01T00:00:00.000Z' }],
        });

        const result = await reconcileFillHistory(userId);

        expect(result.missing).toEqual([]);
    });

    test('a real fill with no matching trades row is reported, never written', async () => {
        mockOrders([
            { symbol: 'SOXL', side: 'sell', filled_qty: '9', filled_avg_price: '121.70', filled_at: '2026-09-11T19:28:46.000Z', id: 'ord-2' },
        ]);
        query.mockResolvedValueOnce({ rows: [] });

        const result = await reconcileFillHistory(userId);

        expect(tradesDb.recordTrade).not.toHaveBeenCalled();
        expect(result.missing).toEqual(['SOXL SELL 9@$121.70 (2026-09-11T19:28:46.000Z)']);
        expect(result.ok).toBe(true);
    });

    test('a fill outside price tolerance for its nearest same-qty/time row is still reported (no silent false match)', async () => {
        mockOrders([
            { symbol: 'XYZ', side: 'buy', filled_qty: '10', filled_avg_price: '100.00', filled_at: '2026-09-11T19:01:10.000Z', id: 'ord-9' },
        ]);
        query.mockResolvedValueOnce({
            // Same qty/time, but price is 5% off — outside the widened 2%/$0.10 tolerance.
            rows: [{ id: 1, symbol: 'XYZ', action: 'BUY', quantity: '10', price: '105.00', broker_order_id: null, trade_date_utc: '2026-09-11T19:01:10.000Z' }],
        });

        const result = await reconcileFillHistory(userId);

        expect(result.missing).toEqual(['XYZ BUY 10@$100.00 (2026-09-11T19:01:10.000Z)']);
    });

    test('crypto symbols are never reconciled here — they have their own ledger', async () => {
        mockOrders([
            { symbol: 'BTC/USD', side: 'buy', filled_qty: '0.01', filled_avg_price: '60000', filled_at: '2026-09-11T19:01:10.000Z', id: 'ord-4' },
        ]);
        query.mockResolvedValueOnce({ rows: [] });

        const result = await reconcileFillHistory(userId);

        expect(result.missing).toEqual([]);
    });

    test('a transient network error fails open — ok, no errors, nothing reported', async () => {
        axios.get.mockRejectedValue({ code: 'ETIMEDOUT', message: 'timeout' });

        const result = await reconcileFillHistory(userId);

        expect(result.ok).toBe(true);
        expect(result.errors).toEqual([]);
        expect(result.missing).toEqual([]);
    });

    test('a schema-check failure is reported but does not throw', async () => {
        mockOrders([
            { symbol: 'AAPL', side: 'buy', filled_qty: '10', filled_avg_price: '150.00', filled_at: '2026-09-11T19:01:10.000Z', id: 'ord-1' },
        ]);
        tradesDb.ensureBrokerOrderIdColumn.mockRejectedValueOnce(new Error('column check failed'));

        const result = await reconcileFillHistory(userId);

        expect(result.ok).toBe(false);
        expect(result.errors).toEqual(['Schema check failed: column check failed']);
    });

    test('skips entirely when BROKER is not alpaca', async () => {
        process.env.BROKER = 'simulated';

        const result = await reconcileFillHistory(userId);

        expect(result).toEqual({ ok: true, missing: [], fixes: [], errors: [] });
        expect(axios.get).not.toHaveBeenCalled();
    });
});
