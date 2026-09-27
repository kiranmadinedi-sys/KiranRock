jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const { query } = require('../src/config/database');
const { getExclusionSummary } = require('../src/services/precomputedUniverseService');

/**
 * 2026-09-27 real incident: getExclusionSummary's text-pattern categorization
 * predates the 2026-09-26 skip-reason taxonomy — none of the new exact codes
 * (WEINSTEIN_STAGE_4, RISK_FLAG_HARD_SKIP, ...) matched any of the old ILIKE
 * patterns, so every one fell into the generic 'error' bucket. That produced a
 * real false alarm the same night ("High error rate: 261 error failures") when
 * most of it was ordinary strategy/risk filtering, not errors. Fixed to prefer
 * the new taxonomy's own exact code (stored in metadata.skipCode) when present.
 */
describe('precomputedUniverseService.getExclusionSummary', () => {
    beforeEach(() => query.mockReset());

    test('the query prefers metadata.skipCode over text-pattern matching when present', async () => {
        query.mockResolvedValue({ rows: [] });

        await getExclusionSummary('2026-09-27');

        const sql = query.mock.calls[0][0];
        expect(sql).toMatch(/metadata->>'skipCode'/);
        // The metadata check must come FIRST in the CASE, ahead of the old text patterns.
        expect(sql.indexOf("metadata->>'skipCode'")).toBeLessThan(sql.indexOf("ILIKE '%STRONG BUY%'"));
    });

    test('real rows pass through with their category and count intact', async () => {
        query.mockResolvedValue({
            rows: [
                { category: 'WEINSTEIN_STAGE_4', count: 1843 },
                { category: 'RISK_FLAG_HARD_SKIP', count: 376 },
                { category: 'weak_signal', count: 1159 }, // legacy pre-taxonomy row, still falls back correctly
            ],
        });

        const result = await getExclusionSummary('2026-09-27');

        expect(result).toEqual([
            { category: 'WEINSTEIN_STAGE_4', count: 1843 },
            { category: 'RISK_FLAG_HARD_SKIP', count: 376 },
            { category: 'weak_signal', count: 1159 },
        ]);
    });

    test('a DB error resolves to an empty array rather than throwing', async () => {
        query.mockRejectedValue(new Error('db down'));
        await expect(getExclusionSummary('2026-09-27')).resolves.toEqual([]);
    });
});
