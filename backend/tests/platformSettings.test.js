/** Platform-wide switches set by approval (2026-11-06). */
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { query } = require('../src/config/database');
const ps = require('../src/services/platformSettingsService');
const { HANDLERS } = require('../src/services/approvalService');

beforeEach(() => { query.mockReset(); ps._clearCache(); });

test('defaults to scoring ATLAS penalties when nothing is stored', async () => {
    query.mockResolvedValue({ rows: [] });
    expect(await ps.get('atlas_penalties_scored')).toBe(true);
});

test('a database error falls back to the default', async () => {
    query.mockRejectedValue(new Error('down'));
    expect(await ps.get('atlas_penalties_scored')).toBe(true);
});

test('approving platform_setting stores the value', async () => {
    query.mockResolvedValue({ rows: [] });
    const msg = await HANDLERS.platform_setting('u1', { key: 'atlas_penalties_scored', value: false });
    expect(msg).toMatch(/no longer subtracts/);
    const insert = query.mock.calls.find(c => /INSERT INTO platform_settings/.test(c[0]));
    expect(insert[1].slice(0, 2)).toEqual(['atlas_penalties_scored', 'false']);
});

test('unknown keys are refused', async () => {
    await expect(ps.set('nope', 1, 'x')).rejects.toThrow(/Unknown/);
});
