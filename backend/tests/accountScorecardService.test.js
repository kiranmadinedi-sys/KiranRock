jest.mock('axios');
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/userDatabaseService', () => ({ getUserAlpacaCredentials: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const axios = require('axios');
const { query } = require('../src/config/database');
const userDb = require('../src/services/userDatabaseService');
const { getAccountScorecard, formatScorecard } = require('../src/services/accountScorecardService');

/**
 * 2026-09-26, from a cross-validated ChatGPT review: normalize each live account's
 * performance by its own real capital and trade count instead of comparing raw
 * dollar swings — directly answers "is kmadined always the one with problems?"
 * (no: its win rate/expectancy are in line with the other two, it just trades far
 * more). Net capital is read from real Alpaca activities (CSD/CSW), not the app's
 * own "total deposited" field, which is known to miss real transfers made directly
 * at the broker (found 2026-09-23 on Parvataneni).
 *
 * Does NOT test the max-drawdown calculation — it's deliberately left unwired
 * after three real data-quality issues turned up while building it (see
 * _maxDrawdownExperimentalDoNotUse's docstring in the source).
 */
describe('accountScorecardService', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        userDb.getUserAlpacaCredentials.mockResolvedValue({ isPaper: false, keyId: 'k', secretKey: 's' });
    });

    function mockAlpaca({ equity, activities }) {
        axios.get.mockImplementation((url) => {
            if (url.endsWith('/account')) return Promise.resolve({ data: { equity: String(equity) } });
            if (url.endsWith('/account/activities')) return Promise.resolve({ data: activities });
            return Promise.reject(new Error(`unexpected URL ${url}`));
        });
    }

    describe('getAccountScorecard', () => {
        test('derives net capital from real CSD/CSW activities, not any app-side deposited field', async () => {
            query.mockResolvedValueOnce({ rows: [{ id: 'u1', username: 'kmadined' }] }); // users lookup
            mockAlpaca({
                equity: 7445.28,
                activities: [
                    { activity_type: 'CSD', net_amount: '2115', created_at: '2026-08-24T22:05:30Z' },
                    { activity_type: 'CSW', net_amount: '-1719.78', created_at: '2026-09-17T22:05:19Z' },
                    { activity_type: 'FILL', net_amount: '0', created_at: '2026-09-01T00:00:00Z' },
                ],
            });
            query.mockResolvedValueOnce({ // all-time trade stats
                rows: [{ sells: '26', wins: '14', losses: '11', realized_pnl: '-4.57', avg_pnl_pct: '174' }],
            });
            query.mockResolvedValueOnce({ // last-30d trade stats
                rows: [{ sells: '26', wins: '14', losses: '11', realized_pnl: '-4.57', avg_pnl_pct: '174' }],
            });
            query.mockResolvedValueOnce({ rows: [] }); // trade_rejection_log

            const result = await getAccountScorecard();

            expect(result.cards[0].netCapital).toBeCloseTo(395.22, 2); // 2115 - 1719.78, NOT any $1,000 app-side figure
            expect(result.cards[0].equity).toBe(7445.28);
        });

        test('one account failing to build does not block the others', async () => {
            // Promise.all runs _getRealCapitalAndEquity and both _tradeStats calls
            // concurrently per user -- "broken"'s two trade-stats queries still fire
            // (and consume a mock slot each) even though its credentials call rejects
            // and fails the whole card. Both users' trade-stats query mocks are needed.
            const tradeStatsRow = { rows: [{ sells: '0', wins: '0', losses: '0', realized_pnl: '0', avg_pnl_pct: '0' }] };
            query
                .mockResolvedValueOnce({ rows: [{ id: 'u1', username: 'broken' }, { id: 'u2', username: 'fine' }] }) // users lookup
                .mockResolvedValueOnce(tradeStatsRow) // broken: all-time
                .mockResolvedValueOnce(tradeStatsRow) // broken: last-30d
                .mockResolvedValueOnce(tradeStatsRow) // fine: all-time
                .mockResolvedValueOnce(tradeStatsRow) // fine: last-30d
                .mockResolvedValueOnce({ rows: [] }); // trade_rejection_log
            userDb.getUserAlpacaCredentials
                .mockRejectedValueOnce(new Error('no credentials'))
                .mockResolvedValueOnce({ isPaper: false, keyId: 'k', secretKey: 's' });
            mockAlpaca({ equity: 1000, activities: [{ activity_type: 'CSD', net_amount: '1000', created_at: '2026-07-01T00:00:00Z' }] });

            const result = await getAccountScorecard();

            expect(result.cards).toHaveLength(2);
            expect(result.cards[0]).toEqual(expect.objectContaining({ username: 'broken', error: 'no credentials' }));
            expect(result.cards[1]).toEqual(expect.objectContaining({ username: 'fine', netCapital: 1000 }));
        });

        test('an account with zero sells reports null win rate/expectancy rather than dividing by zero', async () => {
            query.mockResolvedValueOnce({ rows: [{ id: 'u1', username: 'quiet' }] });
            mockAlpaca({ equity: 1000, activities: [{ activity_type: 'CSD', net_amount: '1000', created_at: '2026-07-01T00:00:00Z' }] });
            query.mockResolvedValueOnce({ rows: [{ sells: '0', wins: '0', losses: '0', realized_pnl: '0', avg_pnl_pct: '0' }] });
            query.mockResolvedValueOnce({ rows: [{ sells: '0', wins: '0', losses: '0', realized_pnl: '0', avg_pnl_pct: '0' }] });
            query.mockResolvedValueOnce({ rows: [] });

            const result = await getAccountScorecard();

            expect(result.cards[0].allTime.winRate).toBeNull();
            expect(result.cards[0].allTime.expectancyUsd).toBeNull();
        });
    });

    describe('formatScorecard', () => {
        test('renders a card and the rejection breakdown into readable text', () => {
            const text = formatScorecard({
                cards: [{
                    username: 'kmadined', netCapital: 7500, equity: 7445.28,
                    allTimeReturn: -54.72, allTimeReturnPct: -0.0073, pnlPer1kCapital: -7.30,
                    allTime: { trades: 100, winRate: 0.5, expectancyUsd: 0.21 },
                    last30d: { trades: 44, winRate: 0.455, realizedPnl: -23.98 },
                }],
                dataQualityRejects: [{ reason: 'heat_gate', count: 240 }],
            });

            expect(text).toContain('kmadined');
            expect(text).toContain('50.0%');
            expect(text).toContain('heat_gate: 240');
        });

        test('renders a failed-to-build card without crashing', () => {
            const text = formatScorecard({ cards: [{ username: 'broken', error: 'no credentials' }], dataQualityRejects: [] });
            expect(text).toContain('broken');
            expect(text).toContain('no credentials');
        });
    });
});
