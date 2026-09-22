jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const { query } = require('../src/config/database');
const { checkPrescreenDrift } = require('../src/services/precomputedUniverseService');

/**
 * 2026-09-21: this measured a single day exactly `lookbackDays` ago (an equality on
 * analysis_date, not a range), and called a symbol "traded" only once CLOSED with a
 * realized pnl — a bought-but-still-open swing position never counted. Confirmed live:
 * Sept 14 passed 717 symbols, 31 were genuinely bought within a week (4.3%, not the
 * reported 0.8%), 14 of those still open. Now aggregates the real window and reports
 * buy-conversion (from `trades`) separately from close-rate/win-rate (from the journal).
 */
describe('checkPrescreenDrift (2026-09-21 fix)', () => {
    beforeEach(() => query.mockReset());

    test('aggregates over the whole window (BETWEEN), not a single day', async () => {
        query.mockResolvedValue({ rows: [{ prescreen_count: 1054, bought_count: 35, closed_count: 8, avg_pnl: '-4.21', win_rate: '18.2' }] });
        await checkPrescreenDrift(7);
        expect(query.mock.calls[0][0]).toMatch(/BETWEEN CURRENT_DATE - \$1::int AND CURRENT_DATE/);
        expect(query.mock.calls[0][0]).not.toMatch(/analysis_date = CURRENT_DATE/);
        expect(query.mock.calls[0][1]).toEqual([7]);
    });

    test('conversionRate is bought/prescreened, not closed/prescreened', async () => {
        query.mockResolvedValue({ rows: [{ prescreen_count: 717, bought_count: 31, closed_count: 6, avg_pnl: null, win_rate: null }] });
        const r = await checkPrescreenDrift(7);
        expect(r).toMatchObject({ prescreenCount: 717, boughtCount: 31, closedCount: 6, conversionRate: 4.3 });
    });

    test('zero prescreened symbols -> 0% conversion, not a divide-by-zero throw', async () => {
        query.mockResolvedValue({ rows: [{ prescreen_count: 0, bought_count: 0, closed_count: 0, avg_pnl: null, win_rate: null }] });
        const r = await checkPrescreenDrift(7);
        expect(r.conversionRate).toBe(0);
        expect(r.avgPnl).toBe(0);
        expect(r.winRate).toBe(0);
    });

    test('a DB error resolves to null rather than throwing (never blocks the nightly scan)', async () => {
        query.mockRejectedValue(new Error('db down'));
        await expect(checkPrescreenDrift(7)).resolves.toBeNull();
    });
});
