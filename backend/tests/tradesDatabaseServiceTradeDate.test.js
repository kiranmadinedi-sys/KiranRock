jest.mock('../src/config/database', () => ({ query: jest.fn() }));

const { query } = require('../src/config/database');
const { recordTrade } = require('../src/services/tradesDatabaseService');

/**
 * Added 2026-09-14: recordTrade gained an optional tradeDate override so the
 * position reconciler's SHADOW backfill (positionReconciliationService.js)
 * can record a trade's REAL historical fill time instead of always getting
 * NOW() (when the reconciler happened to run, which can be days after the
 * real fill). Confirmed live: this made 3-4-day-old positions look like
 * same-day re-entries. Every other caller omits tradeDate and must keep
 * getting the column's own NOW() default, unchanged from before this fix.
 */
describe('tradesDatabaseService.recordTrade — tradeDate override', () => {
    beforeEach(() => {
        query.mockResolvedValue({ rows: [{ id: 1 }] });
    });

    test('passes a provided tradeDate through as the 12th bind param', async () => {
        await recordTrade({
            userId: 'u1', symbol: 'ORCL', action: 'BUY', quantity: 1, price: 156.57, total: 156.57,
            executedBy: 'reconciler', tradeDate: '2026-09-10T14:00:23.467Z'
        });

        const [sql, params] = query.mock.calls[0];
        expect(sql).toContain('COALESCE($12, NOW())');
        expect(params[11]).toBe('2026-09-10T14:00:23.467Z');
    });

    test('omitting tradeDate passes null, so the column keeps its own NOW() default', async () => {
        await recordTrade({
            userId: 'u1', symbol: 'AAPL', action: 'BUY', quantity: 1, price: 200, total: 200
        });

        const [, params] = query.mock.calls[0];
        expect(params[11]).toBeNull();
    });
});
