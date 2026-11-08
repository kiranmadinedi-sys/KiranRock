/**
 * Daily/weekly loss limits (2026-11-08): read the real day (broker equity change, else closed
 * trades incl. stop fills) and fail closed when the check can't run.
 */
jest.mock('../src/config/database', () => ({ query: jest.fn(), pool: { on: jest.fn() } }));
jest.mock('../src/services/telegramAlertService', () => ({
    sendMessage: jest.fn(async () => {}), alertAll: jest.fn(async () => {}),
    alertDailyLossLimitReached: jest.fn(async () => {}), alertDailyLossWarning: jest.fn(async () => {}),
}));
const { query } = require('../src/config/database');
const tg = require('../src/services/telegramAlertService');
const { _test } = require('../src/services/enhancedAITradingBot');

beforeEach(() => {
    query.mockReset();
    jest.clearAllMocks();
    for (const k of ['sendMessage', 'alertAll', 'alertDailyLossLimitReached', 'alertDailyLossWarning']) tg[k].mockImplementation(async () => {});
});

describe('daily loss limit', () => {
    test('uses the broker day change (open positions + stop fills): $7,500 account, −$80 → halt', async () => {
        const r = await _test.checkDailyLossLimit('u1', {}, 7500, -80);
        expect(r).toMatchObject({ halt: true, unavailable: false, source: 'broker', lossLimit: -75 });
        expect(query).not.toHaveBeenCalled();
        expect(tg.alertDailyLossLimitReached).toHaveBeenCalledTimes(1);
    });

    test('alerts once per day, not every 5-minute cycle', async () => {
        await _test.checkDailyLossLimit('u2', {}, 7500, -80);
        await _test.checkDailyLossLimit('u2', {}, 7500, -90);
        expect(tg.alertDailyLossLimitReached).toHaveBeenCalledTimes(1);
    });

    test('small loss → keep trading', async () => {
        const r = await _test.checkDailyLossLimit('u3', {}, 7500, -20);
        expect(r.halt).toBe(false);
    });

    test('no broker figure → falls back to closed trades today (includes stop fills)', async () => {
        query.mockResolvedValueOnce({ rows: [{ pnl: -100 }] });
        const r = await _test.checkDailyLossLimit('u4', {}, 7500, null);
        expect(r).toMatchObject({ halt: true, source: 'trades', dailyPnl: -100 });
        expect(query.mock.calls[0][0]).toMatch(/FROM trades/);
    });

    test('DB error with no broker figure → no new buys (fail closed)', async () => {
        query.mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'));
        const r = await _test.checkDailyLossLimit('u5', {}, 7500, null);
        expect(r).toMatchObject({ halt: true, unavailable: true });
        expect(tg.alertDailyLossLimitReached).not.toHaveBeenCalled();
    });
});

describe('weekly loss limit', () => {
    test('reads closed trades since Monday', async () => {
        query.mockResolvedValueOnce({ rows: [{ pnl: -800 }] });
        expect(await _test.checkWeeklyLossLimit('w1', 7500, {})).toBe(true);   // limit −$750
        expect(query.mock.calls[0][0]).toMatch(/date_trunc\('week'/);
    });
    test('DB error → halt new buys (fail closed)', async () => {
        query.mockRejectedValueOnce(new Error('connection terminated'));
        expect(await _test.checkWeeklyLossLimit('w2', 7500, {})).toBe(true);
    });
    test('normal week → keep trading', async () => {
        query.mockResolvedValueOnce({ rows: [{ pnl: -85 }] });
        expect(await _test.checkWeeklyLossLimit('w3', 7500, {})).toBe(false);
    });
});
