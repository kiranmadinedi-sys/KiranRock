/** Drawdown breaker (2026-10-29): one bad account reading must not become the peak. */
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn(async () => {}), alertAll: jest.fn(async () => {}) }), { virtual: false });
const { _test } = require('../src/services/enhancedAITradingBot');
const dd = (u, v) => _test.checkMaxDrawdown(u, v);
beforeEach(() => { require('../src/services/telegramAlertService').sendMessage.mockImplementation(async () => {}); });

test('kmadined 10-29: a one-off $10,697 reading is ignored, the next real reading is not a 30% drawdown', async () => {
    await dd('k', 7506);
    expect((await dd('k', 10697)).halt).toBe(false);
    const r = await dd('k', 7515);
    expect(r.halt).toBe(false);
    expect(r.drawdownPct).toBe(0);
});

test('a confirmed jump (real deposit) is accepted on the next reading', async () => {
    await dd('d', 1000);
    await dd('d', 2000);          // unconfirmed
    await dd('d', 2010);          // confirms → peak 2010
    const r = await dd('d', 1700); // real 15.4% drop from the new peak
    expect(r.halt).toBe(true);
});

test('real drawdowns still halt', async () => {
    await dd('r', 10000);
    expect((await dd('r', 9400)).reduceSizing).toBe(true);
    expect((await dd('r', 8400)).halt).toBe(true);
});
