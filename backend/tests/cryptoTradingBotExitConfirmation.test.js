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
const { runCycleForUser, _confirmExitTrigger } = require('../src/services/cryptoTradingBot');

/**
 * 2026-09-23 real incident: UNI/USD whipsawed 9 times across ~2 hours in the
 * paper account, 6 of 9 exits tagged "take-profit" but actually closing at a
 * real loss (net -$15.95 for the day). Logs confirmed take_profit_price was
 * always correctly fillPrice*1.04 (e.g. entry 9.628 -> 10.01312), yet the
 * real sell filled far below that (9.71378) — the fully-CLOSED bar's Close
 * used for the trigger check carried a bad/synthetic tick that had already
 * reverted by the time the market order executed a few seconds later. This is
 * a different manifestation of the same bug class fixed 2026-09-15 in
 * _getBars (that fix only guards the still-FORMING bar case). Fix: before
 * committing to an exit, re-verify the trigger against a fresh, independent
 * getLatestCryptoTrades() price and skip the exit (re-evaluate next cycle) if
 * that doesn't also confirm it.
 */
describe('cryptoTradingBot — exit-trigger confirmation via live trade price', () => {
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

    function mockHeldPosition(pos, barClose, latestTradePrice) {
        cryptoDb.getPositions.mockResolvedValue([pos]);
        const bars = [
            { Timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(), Close: barClose },
            { Timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(), Close: barClose },
        ];
        Alpaca.mockImplementation(() => ({
            getCryptoBars: jest.fn().mockResolvedValue(new Map([[pos.symbol, bars]])),
            getLatestCryptoTrades: jest.fn().mockResolvedValue(new Map([[pos.symbol, { Price: latestTradePrice }]])),
        }));
    }

    test('real incident replay: bar Close spuriously crosses take-profit, but the live trade price does not -> exit is skipped', async () => {
        const pos = { symbol: 'UNI/USD', stop_loss_price: '9.43544', take_profit_price: '10.01312' };
        mockHeldPosition(pos, 10.05, 9.71378); // bar says 10.05 (past target), real live trade says 9.714 (nowhere near)

        await runCycleForUser(user);

        expect(cryptoBroker.sellCrypto).not.toHaveBeenCalled();
    });

    test('a genuine take-profit is confirmed by the live trade price and exits normally', async () => {
        const pos = { symbol: 'UNI/USD', stop_loss_price: '9.43544', take_profit_price: '10.01312' };
        mockHeldPosition(pos, 10.05, 10.06); // both the bar and a fresh live trade agree it's genuinely past target

        await runCycleForUser(user);

        expect(cryptoBroker.sellCrypto).toHaveBeenCalledWith('user-1', 'UNI/USD', { exitReason: 'take-profit' });
    });

    test('a genuine stop-loss-backstop is confirmed by the live trade price and exits normally', async () => {
        const pos = { symbol: 'UNI/USD', stop_loss_price: '9.43544', take_profit_price: '10.01312' };
        mockHeldPosition(pos, 9.40, 9.39); // both agree price genuinely dropped through the backstop

        await runCycleForUser(user);

        expect(cryptoBroker.sellCrypto).toHaveBeenCalledWith('user-1', 'UNI/USD', { exitReason: 'stop-loss-backstop' });
    });

    test('a spurious stop-loss-backstop trigger not confirmed by the live trade price is skipped', async () => {
        const pos = { symbol: 'UNI/USD', stop_loss_price: '9.43544', take_profit_price: '10.01312' };
        mockHeldPosition(pos, 9.40, 9.80); // bar dipped below the stop, but the real live price never did

        await runCycleForUser(user);

        expect(cryptoBroker.sellCrypto).not.toHaveBeenCalled();
    });

    test('a failed confirmation lookup fails closed (skips the exit rather than trusting the unconfirmed bar)', async () => {
        const pos = { symbol: 'UNI/USD', stop_loss_price: '9.43544', take_profit_price: '10.01312' };
        cryptoDb.getPositions.mockResolvedValue([pos]);
        const bars = [{ Timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(), Close: 10.05 }];
        Alpaca.mockImplementation(() => ({
            getCryptoBars: jest.fn().mockResolvedValue(new Map([[pos.symbol, bars]])),
            getLatestCryptoTrades: jest.fn().mockRejectedValue(new Error('data API hiccup')),
        }));

        await runCycleForUser(user);

        expect(cryptoBroker.sellCrypto).not.toHaveBeenCalled();
    });

    describe('_confirmExitTrigger unit behavior', () => {
        const pos = { stop_loss_price: '9.43544', take_profit_price: '10.01312' };

        test('take-profit path checks the live price against take_profit_price', async () => {
            const client = { getLatestCryptoTrades: jest.fn().mockResolvedValue(new Map([['UNI/USD', { Price: 10.02 }]])) };
            expect(await _confirmExitTrigger(client, 'UNI/USD', true, pos)).toBe(true);
        });

        test('stop-loss path checks the live price against stop_loss_price', async () => {
            const client = { getLatestCryptoTrades: jest.fn().mockResolvedValue(new Map([['UNI/USD', { Price: 9.40 }]])) };
            expect(await _confirmExitTrigger(client, 'UNI/USD', false, pos)).toBe(true);
        });

        test('a missing symbol in the response fails closed', async () => {
            const client = { getLatestCryptoTrades: jest.fn().mockResolvedValue(new Map()) };
            expect(await _confirmExitTrigger(client, 'UNI/USD', true, pos)).toBe(false);
        });
    });
});
