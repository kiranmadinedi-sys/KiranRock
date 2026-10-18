/** Momentum satellite — paper only (2026-10-18). */
describe('satelliteService', () => {
    test('computePicks: top-300 by dollar volume, $20+, funds excluded, ranked by 12-1 momentum', async () => {
        jest.resetModules();
        const rows = [
            { symbol: 'ROCKET', c0: 100, c21: 300, c252: 50, dv: 9e7 },  // +500%
            { symbol: 'STEADY', c0: 100, c21: 110, c252: 100, dv: 8e7 }, // +10%
            { symbol: 'CHEAP', c0: 8, c21: 9, c252: 1, dv: 9e7 },        // under $20
            { symbol: 'SPY', c0: 700, c21: 690, c252: 500, dv: 9e9 },    // the benchmark itself
            { symbol: 'HELD', c0: 50, c21: 200, c252: 20, dv: 9e7 },     // excluded (core/swing)
        ];
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows }) }));
        const sat = require('../src/services/satelliteService');
        const picks = await sat.computePicks({ exclude: new Set(['HELD']) });
        expect(picks.map(p => p.symbol)).toEqual(['ROCKET', 'STEADY']);
        expect(picks[0].mom).toBeCloseTo(5);
    });

    test('refuses a live account (PAPER ONLY guard)', async () => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
        jest.doMock('../src/services/userDatabaseService', () => ({
            getUserAlpacaCredentials: jest.fn().mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: false }),
        }));
        const sat = require('../src/services/satelliteService');
        await expect(sat.rebalance('live-user')).rejects.toThrow(/PAPER ONLY/);
    });

    test('satellite symbols are protected from the swing bot but kept out of the core list', async () => {
        jest.resetModules();
        const rows = [
            { symbol: 'SPY', targetPct: 40, note: null, sleeve: 'core' },
            { symbol: 'MU', targetPct: 0, note: 'momentum satellite', sleeve: 'satellite' },
        ];
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows }) }));
        const core = require('../src/services/coreHoldingsService');
        expect([...(await core.getCoreSymbols('u1'))].sort()).toEqual(['MU', 'SPY']); // swing bot leaves both alone
        expect((await core.getCoreRows('u1')).map(r => r.symbol)).toEqual(['SPY']);     // core list/settings: core only
    });
});
