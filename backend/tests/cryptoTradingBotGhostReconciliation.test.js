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
    hasRealPosition: jest.fn(),
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
 * Added 2026-09-13 alongside the fix: a held position can close for real at
 * Alpaca (its resting stop firing) without price ever again crossing OUR
 * recorded stop_loss_price/take_profit_price, so the existing threshold check
 * never had a reason to call sellCrypto and notice — found live, BCH/USD sat
 * as a stale $500 "open position" in crypto_positions for 2+ days this way.
 * runCycleForUser now checks hasRealPosition for any held symbol that didn't
 * already trigger a normal exit this cycle, and reconciles it via the same
 * sellCrypto stale_skip path if the real position is gone.
 */
describe('cryptoTradingBot.runCycleForUser — ghost-position reconciliation', () => {
    const user = { id: 'user-1', max_open_positions: 4, max_daily_trades: 10, daily_loss_limit: '-100', min_score: 60 };

    const bars = (close) => [{ Open: close, Close: close, Volume: 100 }, { Open: close, Close: close, Volume: 100 }];

    beforeEach(() => {
        jest.clearAllMocks();
        userDb.getUserAlpacaCredentials.mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true });
        userCycleMutex.withUserLock.mockImplementation((key, fn) => fn());
        Alpaca.mockImplementation(() => ({
            getCryptoBars: jest.fn().mockResolvedValue(new Map()),
            getLatestCryptoTrades: jest.fn().mockResolvedValue(new Map()),
        }));
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

    function mockHeldPosition(pos, closePrice) {
        cryptoDb.getPositions.mockResolvedValue([pos]);
        // Confirms whatever the bar says by default — this file exercises the
        // ghost-reconciliation path, not the separate live-trade confirmation
        // guard (see cryptoTradingBotExitConfirmation.test.js).
        Alpaca.mockImplementation(() => ({
            getCryptoBars: jest.fn().mockResolvedValue(new Map([[pos.symbol, bars(closePrice)]])),
            getLatestCryptoTrades: jest.fn().mockResolvedValue(new Map([[pos.symbol, { Price: closePrice }]])),
        }));
    }

    test('reconciles a ghost position — price never crossed either threshold, but Alpaca shows it gone', async () => {
        mockHeldPosition({ symbol: 'BCH/USD', stop_loss_price: '221.5', take_profit_price: '235.1' }, 226.75);
        cryptoBroker.hasRealPosition.mockResolvedValue(false);

        await runCycleForUser(user);

        expect(cryptoBroker.hasRealPosition).toHaveBeenCalledWith('user-1', 'BCH/USD');
        expect(cryptoBroker.sellCrypto).toHaveBeenCalledWith('user-1', 'BCH/USD', { exitReason: 'reconciliation_ghost' });
    });

    test('does not reconcile a position that is genuinely still open', async () => {
        mockHeldPosition({ symbol: 'ETH/USD', stop_loss_price: '2410', take_profit_price: '2558' }, 2513.08);
        cryptoBroker.hasRealPosition.mockResolvedValue(true);

        await runCycleForUser(user);

        expect(cryptoBroker.hasRealPosition).toHaveBeenCalledWith('user-1', 'ETH/USD');
        expect(cryptoBroker.sellCrypto).not.toHaveBeenCalled();
    });

    test('a normal stop-loss-backstop exit skips the ghost check entirely (no redundant lookup)', async () => {
        mockHeldPosition({ symbol: 'DOT/USD', stop_loss_price: '1.029', take_profit_price: '1.092' }, 1.027);

        await runCycleForUser(user);

        expect(cryptoBroker.sellCrypto).toHaveBeenCalledWith('user-1', 'DOT/USD', { exitReason: 'stop-loss-backstop' });
        expect(cryptoBroker.hasRealPosition).not.toHaveBeenCalled();
    });

    test('a normal take-profit exit also skips the ghost check', async () => {
        mockHeldPosition({ symbol: 'UNI/USD', stop_loss_price: '5.9', take_profit_price: '6.26' }, 6.30);

        await runCycleForUser(user);

        expect(cryptoBroker.sellCrypto).toHaveBeenCalledWith('user-1', 'UNI/USD', { exitReason: 'take-profit' });
        expect(cryptoBroker.hasRealPosition).not.toHaveBeenCalled();
    });

    test('a hasRealPosition lookup failure fails safe — treated as still real, no reconciliation attempted', async () => {
        mockHeldPosition({ symbol: 'BCH/USD', stop_loss_price: '221.5', take_profit_price: '235.1' }, 226.75);
        cryptoBroker.hasRealPosition.mockRejectedValue(new Error('network error'));

        await expect(runCycleForUser(user)).resolves.toBeDefined();

        expect(cryptoBroker.sellCrypto).not.toHaveBeenCalled();
    });
});
