jest.mock('../src/services/tradingService', () => ({ getHoldings: jest.fn(), getTradeHistory: jest.fn() }));
jest.mock('../src/services/marketQuoteService', () => ({ getCurrentPrice: jest.fn() }));
jest.mock('../src/services/tradingAccountService', () => ({ getTradingAccount: jest.fn() }));
jest.mock('../src/services/tradesDatabaseService', () => ({ getFirstBuyDates: jest.fn(), getSymbolTrades: jest.fn() }));
jest.mock('../src/services/portfolioSnapshotService', () => ({
    savePortfolioSnapshot: jest.fn().mockResolvedValue(),
    getRecentSnapshots: jest.fn(),
}));
jest.mock('../src/services/portfolioHistoryService', () => ({ buildPortfolioHistory: jest.fn() }));
jest.mock('../src/services/brokerService', () => ({
    getPositions: jest.fn(), getAccountInfo: jest.fn(), getOpenOrders: jest.fn().mockResolvedValue([]),
    getRecentActivity: jest.fn().mockResolvedValue([]),
}));
jest.mock('../src/services/userDatabaseService', () => ({}));
jest.mock('../src/services/ledgerService', () => ({ getLedgerSummary: jest.fn().mockResolvedValue(null) }));
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));

const tradingService = require('../src/services/tradingService');
const tradingAccountService = require('../src/services/tradingAccountService');
const tradesDb = require('../src/services/tradesDatabaseService');
const brokerService = require('../src/services/brokerService');
const { getRecentSnapshots } = require('../src/services/portfolioSnapshotService');
const tg = require('../src/services/telegramAlertService');

/**
 * 2026-09-21, kmadined (real incident): cash briefly misread ~$413 low for ~5 minutes
 * (Alpaca cash $5,475.43 -> $5,062.28), then correct again. The existing guard only checked
 * totalPortfolioValue deviation -- with $1,989.95 of this account now in holdings untouched
 * by the bad read, the swing was only 5.5% of total value, under the 7% threshold, so it
 * slipped through and got saved to history (visible on the chart as a sharp V-shaped dip
 * the user could see live). The SAME kind of glitch was 9.4% back when this guard's
 * threshold was tuned (2026-08-27), before this account held any real positions. Verified
 * directly against the real production baseline/bad values before writing this fix (5.53%
 * on total value alone -> would miss; 7.55% using cash too -> catches it).
 */
describe('portfolioTrackingService - cash-deviation guard (2026-09-21)', () => {
    const { _median, getPortfolioSummary, clearUserCache } = require('../src/services/portfolioTrackingService');

    describe('_median', () => {
        test('odd length -> the middle value', () => {
            expect(_median([3, 1, 2])).toBe(2);
        });
        test('even length -> average of the two middle values', () => {
            expect(_median([10, 20, 30, 40])).toBe(25);
        });
        test('filters non-positive values, and returns null when nothing is left', () => {
            expect(_median([0, -5, 7])).toBe(7);
            expect(_median([0, -1])).toBeNull();
            expect(_median([])).toBeNull();
        });
        test('matches the real 2026-09-21 kmadined incident baseline exactly', () => {
            const tenCleanReadings = Array(10).fill(7465.38);
            expect(_median(tenCleanReadings)).toBe(7465.38);
        });
    });

    describe('getPortfolioSummary guard integration', () => {
        const userId = 'kmadined-id';
        const HOLDINGS_VALUE = 1989.95; // matches the real incident's $1,989.95 of holdings

        // One fixed-price holding worth exactly HOLDINGS_VALUE, and Alpaca "equity" left
        // unset (sidesteps the open/closed-market equity-vs-fallback branch entirely, same
        // as this account after hours) -> totalPortfolioValue = cashBalance + HOLDINGS_VALUE
        // deterministically. That gap between cash and total is what a cash-only glitch
        // exploits, and what this fix closes.
        function baseMocks({ alpacaCash, recentSnapshots, forUserId = userId }) {
            clearUserCache(forUserId); // _getAlpacaData's per-user cache must not leak between tests
            tradingService.getHoldings.mockResolvedValue([
                { id: '1', symbol: 'AMT', quantity: 2, averagePrice: 176.58, currentPrice: HOLDINGS_VALUE / 2 },
            ]);
            tradingService.getTradeHistory.mockResolvedValue([]);
            tradingAccountService.getTradingAccount.mockResolvedValue({ balance: alpacaCash, totalDeposited: 7500, totalWithdrawn: 0 });
            tradesDb.getFirstBuyDates.mockResolvedValue([]);
            tradesDb.getSymbolTrades.mockResolvedValue([]);
            brokerService.getPositions.mockResolvedValue([]); // no live Alpaca position price -> falls back to holding.currentPrice
            brokerService.getAccountInfo.mockResolvedValue({ portfolioValue: null, cashBalance: alpacaCash });
            brokerService.getOpenOrders.mockResolvedValue([]);
            brokerService.getRecentActivity.mockResolvedValue([]); // jest.clearAllMocks() wipes the factory default each test
            getRecentSnapshots.mockResolvedValue(recentSnapshots);
        }

        const cleanHistory = () => Array(10).fill(0).map((_, i) => ({
            totalPortfolioValue: '7465.38', cashBalance: '5475.43',
            capturedAt: new Date(Date.now() - i * 15 * 60 * 1000).toISOString(),
        }));

        beforeEach(() => {
            jest.clearAllMocks();
        });

        test('real incident replay: a cash-only glitch (5.5% of total, 7.5% of cash) triggers the guard via cash deviation', async () => {
            baseMocks({ alpacaCash: 5062.28, recentSnapshots: cleanHistory() }); // total ends up 7052.23 -- matches the real bad reading

            await getPortfolioSummary(userId);

            // No corroborating activity and retries return the same bad value (getAccountInfo
            // mock is unchanged) -> the guard gives up and alerts, exactly what the user saw.
            expect(tg.sendMessage).toHaveBeenCalledWith(userId, expect.stringContaining('Portfolio Data Guard'));
        });

        test('a genuine swing corroborated by real activity is accepted without alerting', async () => {
            baseMocks({ alpacaCash: 5062.28, recentSnapshots: cleanHistory() });
            brokerService.getRecentActivity.mockResolvedValue([
                { activity_type: 'FILL', symbol: 'VLO', net_amount: '-413.15', transaction_time: new Date().toISOString() },
            ]);

            await getPortfolioSummary(userId);

            expect(tg.sendMessage).not.toHaveBeenCalled();
        });

        test('everything matches the baseline -> guard never engages, no alert', async () => {
            baseMocks({ alpacaCash: 5475.43, recentSnapshots: cleanHistory() }); // total = 7465.38, matches baseline exactly

            await getPortfolioSummary(userId);

            expect(tg.sendMessage).not.toHaveBeenCalled();
            expect(brokerService.getRecentActivity).not.toHaveBeenCalled();
        });

        test('backward compatible: a holdings-driven total-value deviation (cash itself is fine) still triggers as before', async () => {
            // Different user id -- the guard's 1-alert-per-hour dedup (real, intentional
            // production behavior) would otherwise suppress this test's alert after the
            // "real incident replay" test already alerted for kmadined-id in this same run.
            const otherUserId = 'other-user-id';
            baseMocks({ alpacaCash: 5475.43, recentSnapshots: cleanHistory(), forUserId: otherUserId });
            // Override just the equity fallback contribution by shrinking the priced holding
            // for this one call, so cash stays at baseline while total drops >7%.
            tradingService.getHoldings.mockResolvedValue([
                { id: '1', symbol: 'AMT', quantity: 2, averagePrice: 176.58, currentPrice: 262.31 }, // total holdings ~524.62 -> total ~6000.05, ~19.6% off baseline
            ]);

            await getPortfolioSummary(otherUserId);

            expect(tg.sendMessage).toHaveBeenCalledWith(otherUserId, expect.stringContaining('Portfolio Data Guard'));
        });
    });
});
