const { query } = require('../src/config/database');

jest.mock('../src/config/database');
jest.mock('../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

const tradeIntelligenceService = require('../src/services/tradeIntelligenceService');

/**
 * 2026-09-19: getExpectancyAdjustment used to query cross-account only, which
 * diluted exactly the signal it exists to catch — see
 * project_kmadined_stoploss_diagnosis_2026_09_18 memory. It now tries the
 * requesting account's own 180-day history first (source: 'user-exact'), and
 * only falls back to the cross-account tiers ('exact' then 'strategy-fallback')
 * when that account doesn't have >= MIN_SAMPLE_SIZE (5) of its own closed trades
 * for that exact strategy/setup/regime combination.
 */
describe('tradeIntelligenceService expectancy — per-user scoping (2026-09-19)', () => {
    beforeEach(() => {
        query.mockReset();
    });

    function mockRowsBySql({ userExact, globalExact, strategyFallback }) {
        query.mockImplementation((sql, params) => {
            if (sql.includes('user_id = $1')) {
                return Promise.resolve({ rows: [userExact] });
            }
            if (sql.includes('setup_family = $3')) {
                return Promise.resolve({ rows: [globalExact] });
            }
            return Promise.resolve({ rows: [strategyFallback] });
        });
    }

    test('uses the account\'s own history when it has enough samples (user-exact)', async () => {
        mockRowsBySql({
            userExact: { sample_size: 9, win_rate: 44.4, avg_return: -0.736, expectancy: -0.736 },
            globalExact: { sample_size: 16, win_rate: 50, avg_return: -0.435, expectancy: -0.435 },
            strategyFallback: { sample_size: 97, win_rate: 45.4, avg_return: 0.6, expectancy: 0.6 },
        });

        const result = await tradeIntelligenceService.getExpectancyAdjustment({
            botType: 'stock', strategyFamily: 'equity_long', setupFamily: 'news_momentum',
            regime: 'BULL', userId: 'kmadined-id',
        });

        expect(result.lookupSource).toBe('user-exact');
        expect(result.sampleSize).toBe(9);
        // The per-user query must actually be scoped to this user, not any user.
        const userQueryCall = query.mock.calls.find(c => c[0].includes('user_id = $1'));
        expect(userQueryCall[1][0]).toBe('kmadined-id');
    });

    test('falls back to the global exact tier when the account has too few of its own trades', async () => {
        mockRowsBySql({
            userExact: { sample_size: 2, win_rate: 50, avg_return: 1, expectancy: 1 }, // below MIN_SAMPLE_SIZE
            globalExact: { sample_size: 16, win_rate: 50, avg_return: -0.435, expectancy: -0.435 },
            strategyFallback: { sample_size: 97, win_rate: 45.4, avg_return: 0.6, expectancy: 0.6 },
        });

        const result = await tradeIntelligenceService.getExpectancyAdjustment({
            botType: 'stock', strategyFamily: 'equity_long', setupFamily: 'news_momentum',
            regime: 'BULL', userId: 'new-user',
        });

        expect(result.lookupSource).toBe('exact');
        expect(result.sampleSize).toBe(16);
    });

    test('falls back all the way to strategy-fallback when neither per-user nor global exact has enough', async () => {
        mockRowsBySql({
            userExact: { sample_size: 1, win_rate: 0, avg_return: 0, expectancy: 0 },
            globalExact: { sample_size: 3, win_rate: 0, avg_return: 0, expectancy: 0 },
            strategyFallback: { sample_size: 97, win_rate: 45.4, avg_return: 0.6, expectancy: 0.6 },
        });

        const result = await tradeIntelligenceService.getExpectancyAdjustment({
            botType: 'stock', strategyFamily: 'equity_long', setupFamily: 'news_momentum',
            regime: 'BULL', userId: 'new-user',
        });

        expect(result.lookupSource).toBe('strategy-fallback');
        expect(result.sampleSize).toBe(97);
    });

    test('backward compatible: omitting userId skips the per-user tier entirely (no user_id query issued)', async () => {
        mockRowsBySql({
            userExact: { sample_size: 999, win_rate: 100, avg_return: 100, expectancy: 100 }, // must never be reached
            globalExact: { sample_size: 16, win_rate: 50, avg_return: -0.435, expectancy: -0.435 },
            strategyFallback: { sample_size: 97, win_rate: 45.4, avg_return: 0.6, expectancy: 0.6 },
        });

        const result = await tradeIntelligenceService.getExpectancyAdjustment({
            botType: 'stock', strategyFamily: 'equity_long', setupFamily: 'news_momentum', regime: 'BULL',
            // no userId
        });

        expect(result.lookupSource).toBe('exact');
        expect(query.mock.calls.some(c => c[0].includes('user_id = $1'))).toBe(false);
    });

    test('a numeric-looking userId is stringified before being used as a query param', async () => {
        mockRowsBySql({
            userExact: { sample_size: 5, win_rate: 40, avg_return: -1, expectancy: -1 },
            globalExact: { sample_size: 16, win_rate: 50, avg_return: -0.435, expectancy: -0.435 },
            strategyFallback: { sample_size: 97, win_rate: 45.4, avg_return: 0.6, expectancy: 0.6 },
        });

        await tradeIntelligenceService.getExpectancyAdjustment({
            botType: 'stock', strategyFamily: 'equity_long', setupFamily: 'news_momentum',
            regime: 'BULL', userId: 12345,
        });

        const userQueryCall = query.mock.calls.find(c => c[0].includes('user_id = $1'));
        expect(typeof userQueryCall[1][0]).toBe('string');
    });
});
