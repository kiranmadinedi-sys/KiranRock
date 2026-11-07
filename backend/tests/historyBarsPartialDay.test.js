/** history_bars must never store the bar of a session that is still trading (2026-11-07). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { query } = require('../src/config/database');
const hb = require('../src/services/historyBarsService');

const bar = d => ({ t: `${d}T05:00:00Z`, o: 1, h: 2, l: 0.5, c: 1.5, v: 100 });

describe('_lastCompleteDay', () => {
    test('midday on a trading day → previous day', () => {
        expect(hb._lastCompleteDay(new Date('2026-11-02T17:00:00Z'))).toBe('2026-11-01'); // 12:00 ET
    });
    test('after 16:30 ET → today', () => {
        expect(hb._lastCompleteDay(new Date('2026-11-02T21:45:00Z'))).toBe('2026-11-02'); // 16:45 ET
    });
    test('just after midnight UTC is still the ET evening', () => {
        expect(hb._lastCompleteDay(new Date('2026-11-03T03:00:00Z'))).toBe('2026-11-02'); // 22:00 ET
    });
});

describe('_insert', () => {
    beforeEach(() => query.mockClear());

    test('drops the still-trading day and keeps finished ones', async () => {
        const n = await hb._insert({ SPY: [bar('2026-10-30'), bar('2026-11-02')] }, '2026-10-30');
        expect(n).toBe(1);
        expect(query.mock.calls[0][1]).toContain('2026-10-30');
        expect(query.mock.calls[0][1]).not.toContain('2026-11-02');
    });

    test('nothing to write → no query', async () => {
        expect(await hb._insert({ SPY: [bar('2026-11-02')] }, '2026-10-30')).toBe(0);
        expect(query).not.toHaveBeenCalled();
    });
});
