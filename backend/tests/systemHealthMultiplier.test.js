jest.mock('../src/config/database');
jest.mock('../src/utils/logger', () => ({
    logger: {
        info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trade: jest.fn(),
    },
}));

const { query } = require('../src/config/database');
const bot = require('../src/services/enhancedAITradingBot');
const { getSystemHealthMultiplier } = bot._test;

/**
 * 2026-09-19: getSystemHealthMultiplier's two queries filtered
 * `decision_phase = 'EXIT'` — a value that has never existed in
 * trade_decision_journal's CHECK constraint (CANDIDATE/EXECUTED/CLOSED
 * only), present since this function and that table were introduced
 * together on 2026-06-05. Every query always matched zero rows, so this
 * position-size safety brake (meant to cut size to as low as 0.5x when an
 * account is on a losing streak or a setup family is decaying) silently
 * never engaged for any account, ever — including through kmadined's
 * September losing stretch. These tests guard the fixed 'CLOSED' filter
 * and the actual penalty math now that real rows can reach it.
 */
describe('getSystemHealthMultiplier (2026-09-19 EXIT->CLOSED fix)', () => {
    beforeEach(() => {
        query.mockReset();
    });

    test('every query filters decision_phase = CLOSED, never the old invalid EXIT value', async () => {
        query.mockResolvedValue({ rows: [{}] });

        await getSystemHealthMultiplier('user-exit-fix-check');

        expect(query.mock.calls.length).toBeGreaterThan(0);
        for (const call of query.mock.calls) {
            expect(call[0]).not.toMatch(/decision_phase\s*=\s*'EXIT'/);
        }
        expect(query.mock.calls.some(c => /decision_phase\s*=\s*'CLOSED'/.test(c[0]))).toBe(true);
    });

    test('returns the full 1.0 multiplier when there is no matching history (old, always-broken behavior)', async () => {
        query.mockResolvedValue({ rows: [{}] }); // no wr_recent/wr_prior/etc — all undefined

        const multiplier = await getSystemHealthMultiplier('user-no-history');

        expect(multiplier).toBe(1.0);
    });

    test('cuts size when recent 7-day win rate has declined sharply from the prior week', async () => {
        query.mockImplementation((sql) => {
            if (sql.includes('wr_recent')) {
                return Promise.resolve({ rows: [{ wr_recent: '30.0', wr_prior: '60.0', wr_14d: '45.0', n_recent: '10' }] });
            }
            return Promise.resolve({ rows: [] }); // no decaying setup families
        });

        const multiplier = await getSystemHealthMultiplier('user-declining');

        // -0.15 penalty for recent WR < 40% AND prior WR >= 50% -> multiplier 0.85
        expect(multiplier).toBeCloseTo(0.85, 5);
    });

    test('floors at 0.5 even when every penalty condition stacks', async () => {
        query.mockImplementation((sql) => {
            if (sql.includes('wr_recent')) {
                return Promise.resolve({ rows: [{ wr_recent: '20.0', wr_prior: '55.0', wr_14d: '25.0', n_recent: '10' }] });
            }
            // 2+ setup families with alpha decay (30d WR down >15pts vs prior 60d)
            return Promise.resolve({
                rows: [
                    { setup_family: 'news_momentum', n_30d: '10', w_30d: '2', n_prior: '10', w_prior: '7' },
                    { setup_family: 'oversold_reversal', n_30d: '10', w_30d: '2', n_prior: '10', w_prior: '7' },
                ],
            });
        });

        const multiplier = await getSystemHealthMultiplier('user-everything-bad');

        expect(multiplier).toBe(0.5);
    });
});
