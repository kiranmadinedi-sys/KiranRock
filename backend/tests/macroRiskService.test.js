jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { query } = require('../src/config/database');
const macroRiskService = require('../src/services/macroRiskService');

/**
 * Added 2026-09-14 alongside the feature: a daily LLM news digest (Fed
 * calendar + geopolitical developments, researched by a scheduled cloud
 * agent) now feeds a soft position-size dampener into the live trading bot.
 * Deliberately optional — getRiskSizeMultiplier must NEVER throw and must
 * resolve to 1.0 (no adjustment) whenever the flag is missing or anything
 * goes wrong, since the bot depends on this being safe to call every cycle.
 */
describe('macroRiskService', () => {
    beforeEach(() => {
        query.mockReset();
    });

    describe('getRiskSizeMultiplier', () => {
        test.each([
            ['Calm', 1.0],
            ['Elevated', 0.9],
            ['High', 0.75],
            ['Extreme', 0.6],
            ['Panic', 0.5],
        ])('maps %s to multiplier %s', async (level, expected) => {
            query.mockResolvedValue({ rows: [{ risk_level: level }] });
            await expect(macroRiskService.getRiskSizeMultiplier()).resolves.toBe(expected);
        });

        test('returns 1.0 when there is no row for today', async () => {
            query.mockResolvedValue({ rows: [] });
            await expect(macroRiskService.getRiskSizeMultiplier()).resolves.toBe(1.0);
        });

        test('returns 1.0 and never throws when the query itself fails (e.g. table does not exist yet)', async () => {
            query.mockRejectedValue(new Error('relation "macro_risk_flags" does not exist'));
            await expect(macroRiskService.getRiskSizeMultiplier()).resolves.toBe(1.0);
        });

        test('returns 1.0 for an unrecognized risk_level value rather than throwing', async () => {
            query.mockResolvedValue({ rows: [{ risk_level: 'SomethingUnexpected' }] });
            await expect(macroRiskService.getRiskSizeMultiplier()).resolves.toBe(1.0);
        });
    });

    describe('recordDailyRiskFlag', () => {
        test('rejects an invalid risk level without ever touching the database', async () => {
            await expect(macroRiskService.recordDailyRiskFlag({ riskLevel: 'Nonsense', message: 'x' }))
                .rejects.toThrow(/Invalid risk level/);
            expect(query).not.toHaveBeenCalled();
        });

        test('upserts a valid risk level', async () => {
            query.mockResolvedValue({ rows: [] });
            await macroRiskService.recordDailyRiskFlag({ riskLevel: 'High', message: 'Iran/Hormuz escalation' });
            const upsertCall = query.mock.calls.find(c => c[0].includes('INSERT INTO macro_risk_flags'));
            expect(upsertCall).toBeDefined();
            expect(upsertCall[1]).toEqual(expect.arrayContaining(['High', 'Iran/Hormuz escalation']));
        });
    });
});
