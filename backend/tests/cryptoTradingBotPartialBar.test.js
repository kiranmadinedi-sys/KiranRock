jest.mock('@alpacahq/alpaca-trade-api');
jest.mock('../src/services/userDatabaseService', () => ({
    getUserAlpacaCredentials: jest.fn().mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true }),
}));
jest.mock('../src/services/cryptoDatabaseService', () => ({
    getPositions: jest.fn(),
    updatePositionPrice: jest.fn().mockResolvedValue(),
    getCommittedCapital: jest.fn().mockResolvedValue(0),
    getTodayTradeCount: jest.fn().mockResolvedValue(0),
    getTodayPnl: jest.fn().mockResolvedValue(0),
    logCycle: jest.fn().mockResolvedValue(),
    savePriceBars: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/services/cryptoBrokerService', () => ({
    sellCrypto: jest.fn().mockResolvedValue({}),
    buyCrypto: jest.fn().mockResolvedValue({}),
    hasRealPosition: jest.fn().mockResolvedValue(true),
}));
jest.mock('../src/services/userCycleMutex', () => ({
    withUserLock: jest.fn((key, fn) => fn()),
}));
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const Alpaca = require('@alpacahq/alpaca-trade-api');
const userDb = require('../src/services/userDatabaseService');
const cryptoDb = require('../src/services/cryptoDatabaseService');
const cryptoBroker = require('../src/services/cryptoBrokerService');
const userCycleMutex = require('../src/services/userCycleMutex');
const { runCycleForUser } = require('../src/services/cryptoTradingBot');

/**
 * Added 2026-09-15/16. Real incident: UNI/USD whipsawed 7 times in just over
 * an hour, every single exit tagged "take-profit" despite price never
 * actually reaching the recorded +4% target — 6 of 7 lost money. Traced to
 * _getBars() blindly trusting bars[bars.length-1].Close. The monitor cycle
 * runs at :X0:03 — a few seconds after every 5-min boundary — so a query
 * made right then can get back the brand-new, not-yet-closed candle as the
 * newest bar, which for a thin pair can be seeded from a single stale tick
 * far from the real, settled price. Historical re-queries of the exact same
 * window later showed a smooth, much lower price the whole time. Fix: drop
 * any bar whose 5-min window hasn't fully elapsed yet before using it for any
 * trading decision.
 */
describe('cryptoTradingBot — partial (still-forming) bar exclusion', () => {
    const user = { id: 'user-1', max_open_positions: 4, max_daily_trades: 10, daily_loss_limit: '-100', min_score: 60 };

    beforeEach(() => {
        jest.clearAllMocks();
        userDb.getUserAlpacaCredentials.mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true });
        userCycleMutex.withUserLock.mockImplementation((key, fn) => fn());
        cryptoDb.getPositions.mockResolvedValue([]);
        cryptoDb.updatePositionPrice.mockResolvedValue();
        cryptoDb.getCommittedCapital.mockResolvedValue(0);
        cryptoDb.getTodayTradeCount.mockResolvedValue(0);
        cryptoDb.getTodayPnl.mockResolvedValue(0);
        cryptoDb.logCycle.mockResolvedValue();
        cryptoDb.savePriceBars.mockResolvedValue();
        cryptoBroker.sellCrypto.mockResolvedValue({});
        cryptoBroker.hasRealPosition.mockResolvedValue(true);
    });

    function mockHeldPosition(pos, bars) {
        cryptoDb.getPositions.mockResolvedValue([pos]);
        Alpaca.mockImplementation(() => ({
            getCryptoBars: jest.fn().mockResolvedValue(new Map([[pos.symbol, bars]])),
        }));
    }

    test('a still-forming last bar with a spiked Close does NOT trigger a false take-profit exit', async () => {
        const pos = { symbol: 'UNI/USD', stop_loss_price: '6.282094', take_profit_price: '6.666712' };
        const bars = [
            // fully closed bar, 5 min ago — the real, settled price
            { Timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(), Close: 6.39 },
            // just-started bar (queried ~3s into it) — a spiked/stale print above the take-profit level
            { Timestamp: new Date(Date.now() - 3 * 1000).toISOString(), Close: 6.70 },
        ];
        mockHeldPosition(pos, bars);

        await runCycleForUser(user);

        expect(cryptoBroker.sellCrypto).not.toHaveBeenCalled();
        // the settled bar's price is still the one recorded for the position
        expect(cryptoDb.updatePositionPrice).toHaveBeenCalledWith('user-1', 'UNI/USD', 6.39);
    });

    test('a fully-closed last bar that genuinely crosses take-profit still exits normally', async () => {
        const pos = { symbol: 'UNI/USD', stop_loss_price: '6.282094', take_profit_price: '6.666712' };
        const bars = [
            { Timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), Close: 6.60 },
            { Timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(), Close: 6.70 },
        ];
        mockHeldPosition(pos, bars);

        await runCycleForUser(user);

        expect(cryptoBroker.sellCrypto).toHaveBeenCalledWith('user-1', 'UNI/USD', { exitReason: 'take-profit' });
    });

    test('a bar with no timestamp field at all is used as-is (fails open, matches pre-fix behavior)', async () => {
        const pos = { symbol: 'UNI/USD', stop_loss_price: '6.282094', take_profit_price: '6.666712' };
        const bars = [{ Close: 6.39 }, { Close: 6.70 }];
        mockHeldPosition(pos, bars);

        await runCycleForUser(user);

        expect(cryptoBroker.sellCrypto).toHaveBeenCalledWith('user-1', 'UNI/USD', { exitReason: 'take-profit' });
    });
});
