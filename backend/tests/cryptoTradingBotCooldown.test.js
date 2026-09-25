jest.mock('@alpacahq/alpaca-trade-api');
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
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
const { query } = require('../src/config/database');
const userDb = require('../src/services/userDatabaseService');
const cryptoDb = require('../src/services/cryptoDatabaseService');
const cryptoBroker = require('../src/services/cryptoBrokerService');
const userCycleMutex = require('../src/services/userCycleMutex');
const { runCycleForUser, _setStopLossCooldown, _getCooldownSymbols } = require('../src/services/cryptoTradingBot');

/**
 * 2026-09-24 real incident: UNI/USD stopped out 3 times in 24h in the paper
 * account. Unlike swing/Blitz (intradayTradingBot.js already respects a
 * cross-strategy cooldown after a stop-loss, via asset_blacklist rows keyed
 * COOLDOWN_{userId}_{symbol}), crypto had nothing stopping it from re-entering
 * the exact same symbol the very next 5-min cycle. Added the same mechanism,
 * scaled to crypto's much faster cadence (hours, not trading days).
 */
describe('cryptoTradingBot — stop-loss re-entry cooldown (2026-09-24)', () => {
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
        query.mockResolvedValue({ rows: [] });
    });

    describe('_setStopLossCooldown', () => {
        test('inserts an asset_blacklist row keyed COOLDOWN_{userId}_{symbol}, expiring in 2 hours', async () => {
            await _setStopLossCooldown('user-1', 'UNI/USD');
            expect(query).toHaveBeenCalledWith(
                expect.stringContaining('INSERT INTO asset_blacklist'),
                ['COOLDOWN_user-1_UNI/USD', expect.stringContaining('UNI/USD'), 2]
            );
        });

        test('a DB failure is swallowed — never blocks the exit that already happened', async () => {
            query.mockRejectedValue(new Error('db down'));
            await expect(_setStopLossCooldown('user-1', 'UNI/USD')).resolves.toBeUndefined();
        });
    });

    describe('_getCooldownSymbols', () => {
        test('returns the set of currently-cooling-down symbols for this user, stripping the prefix', async () => {
            query.mockResolvedValue({ rows: [{ symbol: 'COOLDOWN_user-1_UNI/USD' }, { symbol: 'COOLDOWN_user-1_BTC/USD' }] });
            const s = await _getCooldownSymbols('user-1');
            expect(s).toEqual(new Set(['UNI/USD', 'BTC/USD']));
        });

        test('a lookup failure fails open — returns an empty set rather than throwing', async () => {
            query.mockRejectedValue(new Error('db down'));
            const s = await _getCooldownSymbols('user-1');
            expect(s).toEqual(new Set());
        });
    });

    describe('runCycleForUser integration', () => {
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

        test('a confirmed stop-loss-backstop exit sets a cooldown on that symbol', async () => {
            const pos = { symbol: 'UNI/USD', stop_loss_price: '9.43544', take_profit_price: '10.01312' };
            mockHeldPosition(pos, 9.40, 9.39); // both bar and live price agree it dropped through the stop

            await runCycleForUser(user);

            expect(cryptoBroker.sellCrypto).toHaveBeenCalledWith('user-1', 'UNI/USD', { exitReason: 'stop-loss-backstop' });
            expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO asset_blacklist'), ['COOLDOWN_user-1_UNI/USD', expect.any(String), 2]);
        });

        test('a confirmed take-profit exit does NOT set a cooldown', async () => {
            const pos = { symbol: 'UNI/USD', stop_loss_price: '9.43544', take_profit_price: '10.01312' };
            mockHeldPosition(pos, 10.05, 10.06); // both agree it genuinely cleared the take-profit target

            await runCycleForUser(user);

            expect(cryptoBroker.sellCrypto).toHaveBeenCalledWith('user-1', 'UNI/USD', { exitReason: 'take-profit' });
            expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO asset_blacklist'), expect.anything());
        });

        test('a ghost-reconciliation close at a real loss sets a cooldown (the dominant real-world stop-out path)', async () => {
            const pos = { symbol: 'UNI/USD', stop_loss_price: '9.0', take_profit_price: '11.0' };
            cryptoDb.getPositions.mockResolvedValue([pos]);
            const bars = [{ Timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(), Close: 9.5 }]; // between thresholds -- no in-band trigger
            Alpaca.mockImplementation(() => ({
                getCryptoBars: jest.fn().mockResolvedValue(new Map([[pos.symbol, bars]])),
                getLatestCryptoTrades: jest.fn().mockResolvedValue(new Map()),
            }));
            cryptoBroker.hasRealPosition.mockResolvedValue(false); // closed for real at Alpaca already
            cryptoBroker.sellCrypto.mockResolvedValue({ pnl: '-10.16', exitReason: 'reconciliation_ghost_stale_skip' });

            await runCycleForUser(user);

            expect(cryptoBroker.sellCrypto).toHaveBeenCalledWith('user-1', 'UNI/USD', { exitReason: 'reconciliation_ghost' });
            expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO asset_blacklist'), ['COOLDOWN_user-1_UNI/USD', expect.any(String), 2]);
        });

        test('a ghost-reconciliation close at a gain does NOT set a cooldown', async () => {
            const pos = { symbol: 'UNI/USD', stop_loss_price: '9.0', take_profit_price: '11.0' };
            cryptoDb.getPositions.mockResolvedValue([pos]);
            const bars = [{ Timestamp: new Date(Date.now() - 6 * 60 * 1000).toISOString(), Close: 9.5 }];
            Alpaca.mockImplementation(() => ({
                getCryptoBars: jest.fn().mockResolvedValue(new Map([[pos.symbol, bars]])),
                getLatestCryptoTrades: jest.fn().mockResolvedValue(new Map()),
            }));
            cryptoBroker.hasRealPosition.mockResolvedValue(false);
            cryptoBroker.sellCrypto.mockResolvedValue({ pnl: '3.20', exitReason: 'reconciliation_ghost_stale_skip' });

            await runCycleForUser(user);

            expect(query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO asset_blacklist'), expect.anything());
        });

        test('a symbol on cooldown is skipped during the entry scan even though it would otherwise clearly qualify', async () => {
            cryptoDb.getPositions.mockResolvedValue([]); // nothing held -- pure entry-scan test
            query.mockResolvedValue({ rows: [{ symbol: 'COOLDOWN_user-1_UNI/USD' }] });
            // A strong, clearly-qualifying uptrend + volume spike for UNI/USD specifically --
            // if the cooldown skip were missing/broken, this would score well above min_score
            // (60) and get bought. Every other UNIVERSE symbol has no bars at all, so they
            // fall out via the normal "!bars" guard rather than the cooldown path.
            const qualifyingBars = [
                { Open: 10, Close: 10, Volume: 100 },
                { Open: 10, Close: 11, Volume: 500 },
            ];
            Alpaca.mockImplementation(() => ({
                getCryptoBars: jest.fn().mockResolvedValue(new Map([['UNI/USD', qualifyingBars]])),
                getLatestCryptoTrades: jest.fn().mockResolvedValue(new Map()),
            }));

            const result = await runCycleForUser(user);

            expect(cryptoBroker.buyCrypto).not.toHaveBeenCalled();
            expect(result).toEqual({ opportunities: 0, trades: 0 });
        });
    });
});
