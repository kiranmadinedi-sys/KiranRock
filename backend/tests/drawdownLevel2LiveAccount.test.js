/** Drawdown Level 2 (2026-10-29): uses the account's own live flag, not the server-wide ALPACA_PAPER env. */
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn(async () => {}), alertAll: jest.fn(async () => {}) }));
const userDb = require('../src/services/userDatabaseService');
const { _test } = require('../src/services/enhancedAITradingBot');
const L2 = { halt: false, paperOnly: true, reduceSizing: true, drawdownPct: 11 };

afterEach(() => jest.restoreAllMocks());

test('live account at Level 2 → new buys blocked even though ALPACA_PAPER=true', async () => {
    process.env.ALPACA_PAPER = 'true';
    jest.spyOn(userDb, 'getUserAlpacaCredentials').mockResolvedValue({ isPaper: false });
    expect(await _test.drawdownBlocksLiveBuys('kmadined', L2)).toBe(true);
});

test('paper account at Level 2 keeps trading', async () => {
    jest.spyOn(userDb, 'getUserAlpacaCredentials').mockResolvedValue({ isPaper: true });
    expect(await _test.drawdownBlocksLiveBuys('paper', L2)).toBe(false);
});

test('unreadable credentials count as live (fail closed); below Level 2 never blocks', async () => {
    jest.spyOn(userDb, 'getUserAlpacaCredentials').mockRejectedValue(new Error('db down'));
    expect(await _test.drawdownBlocksLiveBuys('x', L2)).toBe(true);
    expect(await _test.drawdownBlocksLiveBuys('x', { ...L2, paperOnly: false })).toBe(false);
});
