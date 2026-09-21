jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const { dropInactiveTickers } = require('../src/services/marketScreenerService');

/** 2026-09-20: hardcoded S&P/NASDAQ lists kept feeding acquired/delisted tickers (ANSS, JNPR...) into every scan. */
const list = ['AAPL', 'MSFT', 'ANSS', 'JNPR', 'NVDA'];
const q = (rows, health = { rows: [{ n: 13159, latest: '2026-09-19T00:00:00Z' }] }) =>
    jest.fn(async sql => sql.includes('COUNT(*)') ? health : { rows });

describe('dropInactiveTickers', () => {
    test('drops symbols not active+tradable in the asset table', async () => {
        const live = Array.from({ length: 18 }, (_, i) => `LIVE${i}`);
        const all = [...live, 'ANSS', 'JNPR'];            // 2 of 20 dead = 10%, under the safety valve
        const out = await dropInactiveTickers(all, { query: q(live.map(symbol => ({ symbol }))) });
        expect(out).toEqual(live);
    });

    test('fail-open: unhealthy/empty asset table leaves the list untouched', async () => {
        expect(await dropInactiveTickers(list, { query: q([], { rows: [{ n: 0, latest: null }] }) })).toEqual(list);
        expect(await dropInactiveTickers(list, { query: q([], { rows: [{ n: 300, latest: '2026-09-19' }] }) })).toEqual(list);
    });

    test('fail-open: a query error leaves the list untouched', async () => {
        expect(await dropInactiveTickers(list, { query: jest.fn().mockRejectedValue(new Error('db down')) })).toEqual(list);
    });

    test('safety valve: refuses to drop more than 25% of the pool', async () => {
        const out = await dropInactiveTickers(list, { query: q([{ symbol: 'AAPL' }]) }); // would drop 4 of 5
        expect(out).toEqual(list);
    });

    test('passes the latest refresh time so lingering stale rows are excluded', async () => {
        const query = q(list.map(symbol => ({ symbol })));
        await dropInactiveTickers(list, { query });
        const call = query.mock.calls.find(c => !c[0].includes('COUNT(*)'));
        expect(call[1][1]).toBe('2026-09-19T00:00:00Z');
        expect(call[0]).toContain("INTERVAL '3 days'");
    });
});

const { loadRealAvgVolumes } = require('../src/services/marketScreenerService');

/**
 * 2026-09-21: quote volume is a partial-feed figure (~22x too small), so ARM (real ~4.4M/day,
 * +17% on 2026-09-21) was recorded at 147,659 and cut by the 250k floor — as were PG, ANET, SNOW.
 * HERMES now takes max(quote volume, 20-day daily_bars average).
 */
describe('loadRealAvgVolumes', () => {
    test('returns a symbol -> average daily volume map from daily_bars', async () => {
        const query = jest.fn().mockResolvedValue({ rows: [{ symbol: 'ARM', av: 4410138 }, { symbol: 'AMD', av: 19621714 }] });
        const m = await loadRealAvgVolumes(['ARM', 'AMD', 'ZZZZ'], { query });
        expect(m.get('ARM')).toBe(4410138);
        expect(m.get('ZZZZ')).toBeUndefined();
        expect(query.mock.calls[0][0]).toContain('daily_bars');
        expect(query.mock.calls[0][1]).toEqual([['ARM', 'AMD', 'ZZZZ']]);
    });

    test('fail-open: a query error yields an empty map (screener keeps its previous behavior)', async () => {
        const m = await loadRealAvgVolumes(['ARM'], { query: jest.fn().mockRejectedValue(new Error('db down')) });
        expect(m.size).toBe(0);
    });

    test('the pool-wide max() rule lifts ARM over the 250k floor while never lowering a higher quote value', () => {
        const pick = (quote, real) => Math.max(quote, real || 0);
        expect(pick(147659, 4410138)).toBeGreaterThanOrEqual(250000);
        expect(pick(9000000, 4000000)).toBe(9000000);
        expect(pick(147659, undefined)).toBe(147659);
    });
});

describe('dropInactiveTickers — class-share tickers (BRK.B)', () => {
    test('a dotted class-share symbol absent from asset_universe is NOT dropped', async () => {
        const live = Array.from({ length: 30 }, (_, i) => `LIVE${i}`);
        const all = [...live, 'BRK.B', 'ANSS'];
        const query = jest.fn(async sql => sql.includes('COUNT(*)')
            ? { rows: [{ n: 13159, latest: '2026-09-19T00:00:00Z' }] }
            : { rows: live.map(symbol => ({ symbol })) });
        const out = await dropInactiveTickers(all, { query });
        expect(out).toContain('BRK.B');
        expect(out).not.toContain('ANSS');
    });
});

describe('loadRealAvgVolumes — whole-number volumes (regression 2026-09-21)', () => {
    test('rounds fractional averages: hermes_symbol_log.avg_volume is BIGINT and rejected "3090236.625"', async () => {
        const query = jest.fn().mockResolvedValue({ rows: [
            { symbol: 'A', av: 3090236.625 }, { symbol: 'B', av: 11714771.772727273 }, { symbol: 'C', av: 1731544.4583333333 },
        ] });
        const m = await loadRealAvgVolumes(['A', 'B', 'C'], { query });
        for (const v of m.values()) expect(Number.isInteger(v)).toBe(true);
        expect(m.get('A')).toBe(3090237);
        expect(m.get('B')).toBe(11714772);
    });
});
