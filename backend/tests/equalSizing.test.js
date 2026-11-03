/** Equal swing sizing + blocked setups (2026-10-31 swing review). */
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn(async () => {}), alertAll: jest.fn(async () => {}) }));
const { _test } = require('../src/services/enhancedAITradingBot');

describe('equalPositionSize', () => {
    test('splits the swing sleeve into equal slots', () => {
        // kmadined on 10-31: cash $1,863 + swing positions $409, 6 slots
        expect(_test.equalPositionSize({ sleeve: 2272, slots: 6 })).toBeCloseTo(378.67);
    });

    test('market-wide risk scales it down; it never exceeds the cash left', () => {
        expect(_test.equalPositionSize({ sleeve: 2272, slots: 6, riskMult: 0.9 })).toBeCloseTo(340.8);
        expect(_test.equalPositionSize({ sleeve: 2272, slots: 6, remainingCapital: 150 })).toBe(150);
    });

    test('no sleeve or no slots means no position', () => {
        expect(_test.equalPositionSize({ sleeve: 0, slots: 6 })).toBe(0);
        expect(_test.equalPositionSize({ sleeve: 2272, slots: 0 })).toBe(0);
    });
});

describe('strategySettingsService sizing settings', () => {
    let svc, row;
    beforeEach(() => {
        jest.resetModules();
        row = null;
        jest.doMock('../src/config/database', () => ({
            query: jest.fn(async (sql, p) => {
                if (/SELECT sizing_method/.test(sql)) return { rows: row ? [row] : [] };
                if (/INSERT INTO strategy_settings \(user_id, sizing_method/.test(sql)) { row = { ...(row || {}), sizing_method: p[1], equal_weight_slots: p[2], blocked_setups: row?.blocked_setups || [] }; }
                if (/INSERT INTO strategy_settings \(user_id, blocked_setups/.test(sql)) { row = { sizing_method: 'conviction', ...(row || {}), blocked_setups: p[1] }; }
                if (/INSERT INTO strategy_settings \(user_id, scan_rotation/.test(sql)) { row = { sizing_method: 'conviction', blocked_setups: [], ...(row || {}), scan_rotation: p[1] }; }
                return { rows: [] };
            }),
        }));
        svc = require('../src/services/strategySettingsService');
    });

    test('defaults to conviction with nothing blocked', async () => {
        expect(await svc.getSizingSettings('u1')).toEqual({ method: 'conviction', slots: null, blockedSetups: [], scanRotation: false });
    });

    test('set and read back equal sizing and a blocked setup', async () => {
        await svc.setSizingMethod('u1', 'equal', 6, 'test');
        await svc.setBlockedSetups('u1', ['news_momentum', 'news_momentum'], 'test');
        expect(await svc.getSizingSettings('u1')).toEqual({ method: 'equal', slots: 6, blockedSetups: ['news_momentum'], scanRotation: false });
    });

    test('scan rotation is off by default and turns on per account', async () => {
        expect((await svc.getSizingSettings('u1')).scanRotation).toBe(false);
        await svc.setScanRotation('u1', true, 'test');
        expect((await svc.getSizingSettings('u1')).scanRotation).toBe(true);
    });

    test('rejects bad input', async () => {
        await expect(svc.setSizingMethod('u1', 'kelly')).rejects.toThrow(/Unknown sizing/);
        await expect(svc.setSizingMethod('u1', 'equal', 0)).rejects.toThrow(/Slots/);
        await expect(svc.setBlockedSetups('u1', ['News Momentum'])).rejects.toThrow(/Invalid/);
    });
});

describe('approval handlers', () => {
    test('sizing_method and blocked_setups apply through strategySettingsService', async () => {
        jest.resetModules();
        const strat = { setSizingMethod: jest.fn(async () => {}), setBlockedSetups: jest.fn(async () => {}) };
        jest.doMock('../src/services/strategySettingsService', () => strat);
        jest.doMock('../src/config/database', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
        const { HANDLERS } = require('../src/services/approvalService');
        expect(await HANDLERS.sizing_method('live-1', { method: 'equal', slots: 6 })).toMatch(/equal-sized.*6/);
        expect(strat.setSizingMethod).toHaveBeenCalledWith('live-1', 'equal', 6, 'approved');
        expect(await HANDLERS.blocked_setups('live-1', { setups: ['news_momentum'] })).toMatch(/No new news_momentum/);
        expect(strat.setBlockedSetups).toHaveBeenCalledWith('live-1', ['news_momentum'], 'approved');
        strat.setScanRotation = jest.fn(async () => {});
        expect(await HANDLERS.scan_rotation('live-1', { enabled: true })).toMatch(/all its candidates/);
        expect(strat.setScanRotation).toHaveBeenCalledWith('live-1', true, 'approved');
    });
});
