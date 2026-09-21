jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { _backfillPartialExit } = require('../src/services/positionReconciliationService');

/**
 * 2026-09-21 (AMD, paper): a partial take-profit sell filled 3 minutes after the bot's 15s
 * wait gave up. The reconciler's DRIFT fix corrected the share count (4 -> 2) but wrote no
 * SELL row (P&L lost) and never set partial_profit_taken, so the bot retried the same partial
 * exit next cycle. _backfillPartialExit records the real fill behind such a decrease.
 */
const fill = (id, qty, px, at = '2026-09-21T13:34:16.775895Z', side = 'sell') =>
    ({ id, side, filled_qty: String(qty), filled_avg_price: String(px), filled_at: at });

function run(orders, { qtyGone = 2, avgCost = 531.35, existing = () => false, recordResult = { id: 1 } } = {}) {
    const tradesDb = { recordTrade: jest.fn().mockResolvedValue(recordResult) };
    const p = _backfillPartialExit('u1', 'AMD', qtyGone, avgCost, {
        tradesDb, fetchOrders: async () => orders, findExisting: async o => existing(o),
    });
    return { tradesDb, p };
}

describe('_backfillPartialExit', () => {
    test('records the unrecorded real fill with broker order id, real fill time, and P&L vs cost basis', async () => {
        const { tradesDb, p } = run([fill('bc119081', 2, 586.055)]);
        expect((await p).recorded).toBe(1);
        const arg = tradesDb.recordTrade.mock.calls[0][0];
        expect(arg).toMatchObject({ userId: 'u1', symbol: 'AMD', action: 'SELL', quantity: 2, price: 586.055,
            brokerOrderId: 'bc119081', tradeDate: '2026-09-21T13:34:16.775895Z', executedBy: 'reconciler' });
        expect(arg.pnl).toBeCloseTo((586.055 - 531.35) * 2, 3);
        expect(arg.pnlPercent).toBeCloseTo(((586.055 - 531.35) / 531.35) * 100, 3);
        expect(arg.notes).toContain('partial_profit_reconciled'); // matches the exit-category taxonomy
    });

    test('an order already recorded is not inserted again (and still explains its share of the gap)', async () => {
        const { tradesDb, p } = run([fill('bc119081', 2, 586.055)], { existing: () => true });
        expect((await p).recorded).toBe(0);
        expect(tradesDb.recordTrade).not.toHaveBeenCalled();
    });

    test('a fill bigger than the missing quantity is not ours and is skipped', async () => {
        const { tradesDb, p } = run([fill('big', 10, 500)], { qtyGone: 2 });
        expect((await p).recorded).toBe(0);
        expect(tradesDb.recordTrade).not.toHaveBeenCalled();
    });

    test('buys and zero-qty orders are ignored', async () => {
        const { tradesDb, p } = run([fill('b1', 2, 500, undefined, 'buy'), { ...fill('z', 0, 500) }]);
        expect((await p).recorded).toBe(0);
        expect(tradesDb.recordTrade).not.toHaveBeenCalled();
    });

    test('two partial fills covering the gap are both recorded, newest first, stopping once covered', async () => {
        const { tradesDb, p } = run([
            fill('o1', 1, 590, '2026-09-21T13:40:00Z'),
            fill('o2', 1, 588, '2026-09-21T13:35:00Z'),
            fill('o3', 1, 587, '2026-09-21T13:30:00Z'),
        ], { qtyGone: 2 });
        expect((await p).recorded).toBe(2);
        expect(tradesDb.recordTrade.mock.calls.map(c => c[0].brokerOrderId)).toEqual(['o1', 'o2']);
    });

    test('a duplicate caught by the unique order-id index is not counted as newly recorded', async () => {
        const { p } = run([fill('bc119081', 2, 586.055)], { recordResult: { id: 9, _duplicate: true } });
        expect((await p).recorded).toBe(0);
    });

    test('unknown cost basis -> records the sale with null P&L rather than a wrong one', async () => {
        const { tradesDb, p } = run([fill('bc119081', 2, 586.055)], { avgCost: 0 });
        await p;
        expect(tradesDb.recordTrade.mock.calls[0][0].pnl).toBeNull();
        expect(tradesDb.recordTrade.mock.calls[0][0].pnlPercent).toBeNull();
    });

    test('reports how much of the gap it could not explain', async () => {
        const { p } = run([], { qtyGone: 2 });
        expect(await p).toEqual({ recorded: 0, unexplained: 2 });
    });
});
