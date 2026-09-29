jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const { query } = require('../src/config/database');
const { loadCandidates } = require('../src/services/precomputedUniverseService');

/**
 * 2026-09-27/28, investigating a real "missed opportunity" alert (10 symbols scored
 * STRONG BUY for 3+ of 6 days, real 8%+ moves, zero buys anywhere): loadCandidates()'s
 * ORDER BY ai_score DESC had no tie-breaker. On 2026-09-24, 68 symbols tied at the exact
 * maximum score of 100.00 for a LIMIT of 40 — Postgres fell back to physical row order,
 * confirmed live to be stable/repeatable (not random), so the SAME ~40-of-68 winners got
 * selected every single cycle that day, and the other 28 (including ORBS, DLXY, SOAR —
 * all of which hit exactly 100.00 on days they were never bought anywhere) never had a
 * chance, day after day. Fixed with a hash-of-(symbol, date) tie-breaker: fair within a
 * tied cluster, stable across repeated calls the SAME day (no intra-day flapping), but
 * rotates which tied candidates win as the date changes.
 */
describe('precomputedUniverseService.loadCandidates — tie-break fairness', () => {
    beforeEach(() => query.mockReset());

    test('the query includes a deterministic tie-breaker after ai_score DESC', async () => {
        query.mockResolvedValue({ rows: [] });

        await loadCandidates({ minScore: 85, limit: 40 });

        const sql = query.mock.calls[0][0];
        expect(sql).toMatch(/ORDER BY ai_score DESC, md5\(symbol \|\| analysis_date::text\) ASC/);
    });

    test('real rows pass through with the same shape as before (no result-mapping change)', async () => {
        query.mockResolvedValue({
            rows: [{
                symbol: 'ORBS', ai_score: '100.00', recommendation: 'STRONG BUY',
                setup_family: 'breakout_leader', sector: null, market_cap: '0', metadata: {},
            }],
        });

        const result = await loadCandidates({ minScore: 85, limit: 40 });

        expect(result).toEqual([{
            symbol: 'ORBS',
            marketCap: 2_000_000_000, // falls back when market_cap is 0/falsy, unchanged behavior
            sector: 'Unknown',
            _preScreened: true,
            _precomputedScore: 100,
            _precomputedRec: 'STRONG BUY',
            _precomputedFamily: 'breakout_leader',
        }]);
    });

    test('minScore and limit are still passed through as query parameters unchanged', async () => {
        query.mockResolvedValue({ rows: [] });

        await loadCandidates({ minScore: 80, limit: 40 });

        expect(query.mock.calls[0][1]).toEqual([80, 40]);
    });
});
