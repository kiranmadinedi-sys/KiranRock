/** 2026-11-26: the nightly scan must never START on a weekend or NYSE holiday. */
jest.mock('../src/config/database', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../src/services/marketScreenerService', () => ({}));
jest.mock('../src/services/marketRegimeService', () => ({}));
jest.mock('../src/services/telegramAlertService', () => ({}));
jest.mock('../src/services/precomputedUniverseService', () => ({}));
jest.mock('../src/services/enhancedAITradingBot', () => ({ analyzeStockWithAI: async () => null, getVixLevel: async () => 15, getSkipReasonFamily: () => null, SKIP_REASONS: {} }));

const svc = require('../src/services/nightlyUniverseScanService');

afterEach(() => jest.useRealTimers());

test('weekend and NYSE holidays are non-trading days; normal weekdays are not', () => {
    expect(svc._isNonTradingDayET(new Date('2026-11-26T21:16:00Z'))).toBe(true);  // Thanksgiving 4:16 PM ET
    expect(svc._isNonTradingDayET(new Date('2026-11-28T21:16:00Z'))).toBe(true);  // Saturday
    expect(svc._isNonTradingDayET(new Date('2026-11-25T21:16:00Z'))).toBe(false); // Wednesday
    expect(svc._isNonTradingDayET(new Date('2026-11-27T21:16:00Z'))).toBe(false); // Friday (early close, still trading)
    // 11 PM ET Wednesday is 04:00Z Thursday — must still count as Wednesday (ET date, not UTC)
    expect(svc._isNonTradingDayET(new Date('2026-11-26T04:00:00Z'))).toBe(false);
});

test('Thanksgiving evening: runNightlyUniverseScan refuses to start and is not left "running"', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-26T21:16:00Z'), doNotFake: ['nextTick', 'setImmediate'] });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    expect(await svc.runNightlyUniverseScan()).toBeNull();
    expect(await svc.runNightlyUniverseScan({ missingOnly: true })).toBeNull();
    expect(svc.isScanRunning()).toBe(false);
    const logs = console.log.mock.calls.map(c => c[0]).filter(m => /market holiday/.test(m));
    expect(logs).toHaveLength(1); // logged once per day, not every 5-min tick
});
