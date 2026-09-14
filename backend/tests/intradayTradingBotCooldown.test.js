jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/dataProvider', () => ({
    getQuote: jest.fn(),
}));
jest.mock('../src/services/intradayDatabaseService', () => ({
    getPositions: jest.fn(),
    getTodayTradeCount: jest.fn(),
    getTodayPnl: jest.fn(),
    getCommittedCapital: jest.fn(),
    logCycle: jest.fn(),
}));
jest.mock('../src/services/capitalCoordinator', () => ({
    getSwingCommittedCapital: jest.fn(),
    getIntradayCommittedCapital: jest.fn(),
}));
jest.mock('../src/services/intradayBrokerService', () => ({
    buyIntraday: jest.fn(),
}));
jest.mock('../src/services/userCycleMutex', () => ({
    withUserLock: jest.fn((key, fn) => fn()),
}));
jest.mock('../src/services/brokerService', () => ({
    getAccountInfo: jest.fn(),
}));
jest.mock('../src/services/dynamicUniverseService', () => ({
    getIntradayMovers: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { query } = require('../src/config/database');
const dataProvider = require('../src/services/dataProvider');
const intradayDb = require('../src/services/intradayDatabaseService');
const capitalCoordinator = require('../src/services/capitalCoordinator');
const intradayBroker = require('../src/services/intradayBrokerService');
const brokerService = require('../src/services/brokerService');
const dynamicUniverseService = require('../src/services/dynamicUniverseService');
const userCycleMutex = require('../src/services/userCycleMutex');
const { scanForUser } = require('../src/services/intradayTradingBot');

/**
 * Added 2026-09-14: Blitz (intraday momentum) and the swing bot
 * (enhancedAITradingBot.js) trade the same account's real capital as fully
 * independent pipelines. Found live: Blitz bought SOXL and ORCL back within
 * 30-60 minutes of the swing bot hard-stopping out of the exact same
 * symbols, immediately losing again, because Blitz never checked the
 * swing bot's stop-loss cooldown (asset_blacklist, COOLDOWN_<userId>_<symbol>).
 * scanForUser now batch-loads that same cooldown set and skips any symbol
 * on it, mirroring the cross-strategy capital check that already exists
 * (capitalCoordinator.getSwingCommittedCapital).
 */
describe('intradayTradingBot.scanForUser — cross-strategy cooldown check', () => {
    const user = {
        id: 'user-1', max_open_positions: 5, max_daily_trades: 10, daily_loss_limit: '-500',
        min_score: 50, max_position_notional: 1000, allocation_amount: 5000,
        stop_loss_percent: 2, take_profit_percent: 3,
    };

    beforeEach(() => {
        jest.clearAllMocks();
        query.mockResolvedValue({ rows: [] });
        intradayDb.getPositions.mockResolvedValue([]);
        intradayDb.getTodayTradeCount.mockResolvedValue(0);
        intradayDb.getTodayPnl.mockResolvedValue(0);
        intradayDb.getCommittedCapital.mockResolvedValue(0);
        intradayDb.logCycle.mockResolvedValue();
        userCycleMutex.withUserLock.mockImplementation((key, fn) => fn());
        capitalCoordinator.getSwingCommittedCapital.mockResolvedValue(0);
        intradayBroker.buyIntraday.mockResolvedValue({});
        brokerService.getAccountInfo.mockResolvedValue({ buyingPower: 100000, cashBalance: 100000 });
        dynamicUniverseService.getIntradayMovers.mockReturnValue([]);
        dataProvider.getQuote.mockResolvedValue({ price: 100, changePercent: 5, volume: 5e6, avgVolume: 1e6 });
    });

    test('skips a symbol currently under the swing bot\'s stop-loss cooldown', async () => {
        query.mockResolvedValue({ rows: [{ symbol: `COOLDOWN_${user.id}_AAPL` }] });

        await scanForUser(user);

        const buyCalls = intradayBroker.buyIntraday.mock.calls.map(c => c[1]);
        expect(buyCalls).not.toContain('AAPL');
    });

    test('still trades a symbol with no active cooldown', async () => {
        query.mockResolvedValue({ rows: [{ symbol: `COOLDOWN_${user.id}_SOMEOTHERSTOCK` }] });

        const result = await scanForUser(user);

        expect(result.trades).toBeGreaterThan(0);
        const buyCalls = intradayBroker.buyIntraday.mock.calls.map(c => c[1]);
        expect(buyCalls).toContain('AAPL');
    });

    test('a cooldown belonging to a DIFFERENT user does not block this user', async () => {
        query.mockResolvedValue({ rows: [] }); // the LIKE query is scoped by user id prefix, so a different user's row never matches

        const result = await scanForUser(user);

        expect(result.trades).toBeGreaterThan(0);
    });

    test('falls back to trading normally if the cooldown lookup itself fails', async () => {
        query.mockRejectedValue(new Error('db down'));

        await expect(scanForUser(user)).resolves.toBeDefined();
        const buyCalls = intradayBroker.buyIntraday.mock.calls.map(c => c[1]);
        expect(buyCalls).toContain('AAPL');
    });

    test('an expired cooldown (past expires_at) does not block — enforced by the SQL filter, not app logic', async () => {
        // The query itself filters `expires_at > NOW()`, so an expired row simply
        // never comes back — simulate that by returning no rows.
        query.mockResolvedValue({ rows: [] });

        const result = await scanForUser(user);

        expect(result.trades).toBeGreaterThan(0);
    });
});
