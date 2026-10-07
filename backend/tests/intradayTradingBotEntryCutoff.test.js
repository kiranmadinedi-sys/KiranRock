jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/services/dataProvider', () => ({ getQuote: jest.fn() }));
jest.mock('../src/services/intradayDatabaseService', () => ({
    getPositions: jest.fn(),
    getTodayTradeCount: jest.fn(),
    getTodayPnl: jest.fn(),
    getCommittedCapital: jest.fn(),
    logCycle: jest.fn(),
}));
jest.mock('../src/services/capitalCoordinator', () => ({ getSwingCommittedCapital: jest.fn(), getIntradayCommittedCapital: jest.fn() }));
jest.mock('../src/services/intradayBrokerService', () => ({ buyIntraday: jest.fn(), sellIntraday: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/userCycleMutex', () => ({ withUserLock: jest.fn((key, fn) => fn()) }));
jest.mock('../src/services/brokerService', () => ({ getAccountInfo: jest.fn() }));
jest.mock('../src/services/dynamicUniverseService', () => ({ getIntradayMovers: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const intradayDb = require('../src/services/intradayDatabaseService');
const intradayBroker = require('../src/services/intradayBrokerService');
const { scanForUser, forceFlattenUser } = require('../src/services/intradayTradingBot');

/**
 * 2026-10-06: Blitz had no entry time cutoff — it opened a fresh 102-share NOK position at
 * 15:59 ET, after the 15:50 EOD flatten, so it was held overnight.
 */
describe('Blitz end-of-day entry cutoff', () => {
    const user = { id: 'u1', force_flat_eod: true, max_open_positions: 3, max_daily_trades: 10, daily_loss_limit: '-100' };

    beforeEach(() => {
        jest.clearAllMocks();
        jest.useFakeTimers();
        intradayDb.getPositions.mockResolvedValue([]);
        intradayDb.getTodayTradeCount.mockResolvedValue(0);
        intradayDb.getTodayPnl.mockResolvedValue(0);
    });
    afterEach(() => jest.useRealTimers());

    test('no new entries at 15:59 ET (after the flatten window opened)', async () => {
        jest.setSystemTime(new Date('2026-10-06T19:59:00Z')); // 15:59 EDT
        const r = await scanForUser(user);
        expect(r).toEqual({ opportunities: 0, trades: 0 });
        expect(intradayDb.getPositions).not.toHaveBeenCalled();
    });

    test('no new entries from 15:45 ET', async () => {
        jest.setSystemTime(new Date('2026-10-06T19:45:00Z')); // 15:45 EDT
        await scanForUser(user);
        expect(intradayDb.getPositions).not.toHaveBeenCalled();
    });

    test('entries still evaluated at 15:44 ET', async () => {
        jest.setSystemTime(new Date('2026-10-06T19:44:00Z')); // 15:44 EDT
        await scanForUser(user).catch(() => {}); // downstream mocks are minimal; only the gate matters here
        expect(intradayDb.getPositions).toHaveBeenCalled();
    });

    test('an account that does not flatten at EOD is not cut off', async () => {
        jest.setSystemTime(new Date('2026-10-06T19:55:00Z'));
        await scanForUser({ ...user, force_flat_eod: false }).catch(() => {});
        expect(intradayDb.getPositions).toHaveBeenCalled();
    });

    test('forceFlattenUser is a no-op once flat, so per-minute retries are safe', async () => {
        intradayDb.getPositions.mockResolvedValue([]);
        await forceFlattenUser(user);
        await forceFlattenUser(user);
        expect(intradayBroker.sellIntraday).not.toHaveBeenCalled();
    });
});
