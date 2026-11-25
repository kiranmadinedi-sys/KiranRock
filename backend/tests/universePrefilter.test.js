/**
 * Universe build: Polygon first, Yahoo as backup (docs/UNIVERSE_BUILD_POLYGON_PREFILTER.md).
 * The owner's hard requirement: the present nightly Yahoo build must not break. The
 * "identical output" tests run the REAL build code with Yahoo/DB/Polygon mocked and prove
 * shadow mode (the default) produces exactly what off mode produces, with the same Yahoo calls.
 */
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// Batch pauses (2s) fire at once; per-call timeouts (10s/15s) never fire → fast, no open handles.
const realSetTimeout = global.setTimeout;
beforeEach(() => {
    jest.spyOn(global, 'setTimeout').mockImplementation((fn, ms, ...a) => {
        if (ms >= 10000) return { unref() {} };
        return realSetTimeout(fn, 0, ...a);
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

const { previousTradingDay } = require('../src/utils/marketCalendar');

describe('pure helpers', () => {
    const pf = require('../src/services/universePrefilterService');
    const base = { tier: 6, isVelocity: false, poly: { avg: 50000, days: 20 }, realAvg: 0, hermesFloor: 300000, cut: 150000 };

    test('skips only bulk tier-6, non-velocity, Polygon-known, clearly illiquid names', () => {
        expect(pf.shouldSkip(base)).toBe(true);
        for (const tier of [1, 2, 3, 4, 5]) expect(pf.shouldSkip({ ...base, tier })).toBe(false);
        expect(pf.shouldSkip({ ...base, isVelocity: true })).toBe(false);
        expect(pf.shouldSkip({ ...base, poly: undefined })).toBe(false);                 // unknown → Yahoo
        expect(pf.shouldSkip({ ...base, poly: { avg: 50000, days: 9 } })).toBe(false);   // too few days
        expect(pf.shouldSkip({ ...base, poly: { avg: 150000, days: 20 } })).toBe(false); // at the cut
        expect(pf.shouldSkip({ ...base, realAvg: 400000 })).toBe(false);                 // own bars say liquid
    });

    test('window = last 20 completed trading days; today only once its EOD rows exist', () => {
        const w = pf.windowDays('2026-11-27', false);
        expect(w).toHaveLength(20);
        expect(w[0]).toBe('2026-11-25');            // Thanksgiving 11-26 skipped, today excluded
        expect(w).not.toContain('2026-11-26');
        expect(w.some(d => [0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay()))).toBe(false);
        expect(pf.windowDays('2026-11-25', true)[0]).toBe('2026-11-25');
    });

    test('cached-row classes', () => {
        expect(pf.classifyCached(undefined)).toBe('miss');
        expect(pf.classifyCached({ passed: true, fail_reason: null, rs_score: 0.9, market_cap: 5e9 })).toBe('hit');
        expect(pf.classifyCached({ passed: true, fail_reason: null, rs_score: null, market_cap: 1e10 })).toBe('miss'); // placeholder cap / pre-migration
        for (const r of ['volume', 'cap', 'both', 'volume_prefilter'])
            expect(pf.classifyCached({ passed: false, fail_reason: r })).toBe('reject');
        expect(pf.classifyCached({ passed: true, fail_reason: 'quote_error_fallback' })).toBe('miss');
        expect(pf.classifyCached({ passed: false, fail_reason: 'velocity_quote_error' })).toBe('miss');
    });

    test('a cached stock never carries IEX volume and passes the quick filter on real fields', () => {
        const { passesQuickFilter } = require('../src/services/marketScreenerService');
        const s = pf.stockFromCache('ABC', { market_cap: '5e9', avg_volume: '2000000', price: '50', rs_score: '0.9', week52_high: '55' }, 51);
        expect(s.volume).toBe(0);
        expect(s.price).toBe(51);
        expect(s.rsScore).toBeCloseTo(0.9);
        expect(passesQuickFilter(s)).toBe(true);
        expect(passesQuickFilter({ ...s, week52High: 120 })).toBe(false); // proximity check still applies
    });

    test('mode off never touches the database; load failure → inactive (full Yahoo)', async () => {
        process.env.UNIVERSE_PREFILTER = 'off';
        const query = jest.fn();
        expect((await pf.prepareHermesPrefilter('2026-11-25', { query })).active).toBe(false);
        expect(query).not.toHaveBeenCalled();
        process.env.UNIVERSE_PREFILTER = 'shadow';
        const bad = jest.fn(async () => { throw new Error('db down'); });
        expect((await pf.prepareHermesPrefilter('2026-11-25', { query: bad })).active).toBe(false);
        delete process.env.UNIVERSE_PREFILTER;
    });

    test('health gate: fewer than 15 good days → inactive', async () => {
        const query = jest.fn(async (sql, p) => {
            if (/trade_date = \$1::date/.test(sql)) return { rows: [{ n: 0 }] };
            if (/GROUP BY 1/.test(sql)) return { rows: p[0].slice(0, 14).map(d => ({ d, n: 12000 })) };
            return { rows: [] };
        });
        const r = await pf.prepareHermesPrefilter('2026-11-25', { query });
        expect(r.active).toBe(false);
        expect(r.reason).toMatch(/only 14 of 20/);
    });

    test('storing an empty Polygon day writes nothing', async () => {
        const query = jest.fn();
        expect(await pf.storeMarketDailyVolume('2026-11-24', [], { query })).toBe(0);
        expect(query).not.toHaveBeenCalled();
    });

    test('jaccard / top-N overlap', () => {
        expect(pf.jaccard(['A', 'B'], ['A', 'B'])).toBe(1);
        expect(pf.jaccard(['A', 'B'], ['B', 'C'])).toBeCloseTo(1 / 3);
        expect(pf.topOverlap(['A', 'B', 'C'], ['A', 'B', 'X'], 3)).toBeCloseTo(2 / 3);
    });
});

// ── Full HERMES build with mocks ──────────────────────────────────────────────

const BULK = ['ILLQA', 'ILLQB', 'LIQA', 'NOPOLY', 'OWNBARS'];          // tier 6 pool
const POLY = { ILLQA: 40000, ILLQB: 100000, LIQA: 2000000, OWNBARS: 60000 };
const YAHOO_VOL = { ILLQA: 30000, ILLQB: 90000, LIQA: 1800000, NOPOLY: 900000, OWNBARS: 80000 };

function hermesHarness() {
    const calls = { quote: [], logRows: [] };
    jest.doMock('yahoo-finance2', () => ({
        default: class {
            async quote(s) { calls.quote.push(s); return {
                marketCap: 5e9, averageDailyVolume3Month: YAHOO_VOL[s] ?? 3000000, regularMarketVolume: 1000000,
                regularMarketPrice: 50, fiftyTwoWeekHigh: 55, fiftyTwoWeekLow: 30, fiftyDayAverage: 48, twoHundredDayAverage: 45,
                sector: 'Tech', industry: 'Software' }; }
            async quoteSummary() { return {}; }
            async trendingSymbols() { return { quotes: [] }; }
            async screener() { return { quotes: [] }; }
        },
    }));
    jest.doMock('../src/utils/yahooFinanceRateLimiter', () => ({ execute: (fn) => fn() }));
    jest.doMock('../src/services/dataProvider', () => ({ getGainers: async () => [], getMostActive: async () => [] }));
    jest.doMock('../src/services/assetUniverseService', () => ({ getDailyUniverseSymbols: async () => BULK }));
    jest.doMock('../src/config/database', () => ({
        query: (async (sql, p) => {
            if (/FROM daily_bars/.test(sql)) return { rows: [{ symbol: 'OWNBARS', av: 500000 }] };
            if (/market_daily_volume WHERE trade_date = \$1::date/.test(sql)) return { rows: [{ n: 0 }] };
            if (/FROM market_daily_volume[\s\S]*GROUP BY 1/.test(sql)) return { rows: p[0].map(d => ({ d, n: 12000 })) };
            if (/FROM market_daily_volume[\s\S]*GROUP BY symbol/.test(sql))
                return { rows: Object.entries(POLY).map(([symbol, avg]) => ({ symbol, avg, days: 20 })) };
            if (/INSERT INTO hermes_symbol_log/.test(sql)) { calls.logRows.push({ symbol: p[1], passed: p[6], reason: p[7], ext: p.length > 10 }); return { rows: [] }; }
            if (/alpaca_assets|FROM assets/i.test(sql)) throw new Error('no asset table in test'); // dropInactive fails open
            return { rows: [] };
        }),
    }));
    return calls;
}

async function runHermes(modeValue) {
    jest.resetModules();
    if (modeValue) process.env.UNIVERSE_PREFILTER = modeValue; else delete process.env.UNIVERSE_PREFILTER;
    const calls = hermesHarness();
    const ms = require('../src/services/marketScreenerService');
    const list = await ms.getStockUniverse();
    await new Promise(r => realSetTimeout(r, 20)); // let fire-and-forget log inserts settle
    return { list, calls };
}

describe('HERMES nightly build — present Yahoo build unchanged', () => {
    afterEach(() => { delete process.env.UNIVERSE_PREFILTER; });

    test('shadow (default) output and Yahoo calls are identical to off', async () => {
        const off = await runHermes('off');
        const shadow = await runHermes(undefined); // default = shadow
        expect(shadow.list.map(s => s.symbol)).toEqual(off.list.map(s => s.symbol));
        expect(shadow.list).toEqual(off.list);
        expect([...shadow.calls.quote].sort()).toEqual([...off.calls.quote].sort());
        const key = r => `${r.symbol}:${r.passed}:${r.reason}`;
        expect(shadow.calls.logRows.map(key).sort()).toEqual(off.calls.logRows.map(key).sort());
        expect(off.calls.quote).toEqual(expect.arrayContaining(['ILLQA', 'ILLQB', 'NOPOLY', 'OWNBARS']));
    }, 60000);

    test('passed rows now carry the stored quote fields (both modes)', async () => {
        const { calls } = await runHermes('off');
        const liq = calls.logRows.find(r => r.symbol === 'LIQA');
        expect(liq.passed).toBe(true);
        expect(liq.ext).toBe(true);
    }, 60000);

    test('on: skips only the clearly illiquid bulk names; Polygon-unknown and own-bars-liquid still quoted; same list', async () => {
        const off = await runHermes('off');
        const on = await runHermes('on');
        expect(on.calls.quote).not.toContain('ILLQA');
        expect(on.calls.quote).not.toContain('ILLQB');
        expect(on.calls.quote).toContain('NOPOLY');   // not in Polygon → Yahoo
        expect(on.calls.quote).toContain('OWNBARS');  // daily_bars says liquid → Yahoo
        expect(on.calls.quote).toContain('LIQA');
        expect(on.calls.logRows.find(r => r.symbol === 'ILLQA').reason).toBe('volume_prefilter');
        expect(on.list.map(s => s.symbol)).toEqual(off.list.map(s => s.symbol)); // dropped names failed anyway
    }, 60000);
});

// ── Blitz pre-market build with mocks ─────────────────────────────────────────

function blitzHarness({ hermesRows, buildDate = '2026-11-24' }) {
    const calls = { quote: [] };
    jest.doMock('yahoo-finance2', () => ({
        default: class {
            async quote(s) { calls.quote.push(s); return {
                marketCap: 5e9, averageDailyVolume3Month: 2000000, regularMarketVolume: 0, regularMarketPrice: 50,
                fiftyTwoWeekHigh: 55, fiftyTwoWeekLow: 30, fiftyDayAverage: 48, twoHundredDayAverage: 45 }; }
            async trendingSymbols() { return { quotes: [] }; }
            async screener() { return { quotes: [] }; }
        },
    }));
    jest.doMock('../src/utils/yahooFinanceRateLimiter', () => ({ execute: (fn) => fn() }));
    jest.doMock('../src/services/assetUniverseService', () => ({ getDailyUniverseSymbols: async () => ['HITA', 'HITB', 'REJA', 'MISSA'], addDynamicSymbol: async () => {} }));
    jest.doMock('@alpacahq/alpaca-trade-api', () => class { async getSnapshots() { return []; } });
    jest.doMock('../src/config/database', () => ({
        query: (async (sql) => {
            if (/FROM hermes_build_status/.test(sql)) return { rows: buildDate ? [{ d: buildDate }] : [] };
            if (/FROM hermes_symbol_log/.test(sql)) return { rows: hermesRows };
            return { rows: [] };
        }),
    }));
    return calls;
}

const HERMES_ROWS = [
    { symbol: 'HITA', passed: true, fail_reason: null, market_cap: '5000000000', avg_volume: '2000000', price: '50', rs_score: '0.95', week52_high: '55' },
    { symbol: 'HITB', passed: true, fail_reason: null, market_cap: '5000000000', avg_volume: '2000000', price: '50', rs_score: '0.85', week52_high: '55' },
    { symbol: 'REJA', passed: false, fail_reason: 'volume', market_cap: '5000000000', avg_volume: '1000' },
];

async function runBlitz(modeValue, opts = {}) {
    jest.resetModules();
    if (modeValue) process.env.UNIVERSE_PREFILTER = modeValue; else delete process.env.UNIVERSE_PREFILTER;
    const calls = blitzHarness({ hermesRows: HERMES_ROWS, ...opts });
    const du = require('../src/services/dynamicUniverseService');
    await du.buildPreMarketCache();
    return { list: du.getScanUniverse() || [], calls };
}

describe('Blitz pre-market build', () => {
    afterEach(() => { delete process.env.UNIVERSE_PREFILTER; });

    test('shadow (default) list and Yahoo calls identical to off', async () => {
        const off = await runBlitz('off');
        const shadow = await runBlitz(undefined);
        expect(shadow.list).toEqual(off.list);
        expect([...shadow.calls.quote].sort()).toEqual([...off.calls.quote].sort());
        expect(off.calls.quote).toEqual(expect.arrayContaining(['HITA', 'HITB', 'REJA', 'MISSA']));
    }, 60000);

    test('on: hits and rejects skip Yahoo, misses still quoted; cached stocks have volume 0', async () => {
        const on = await runBlitz('on');
        expect(on.calls.quote).not.toContain('HITA');
        expect(on.calls.quote).not.toContain('REJA');
        expect(on.calls.quote).toContain('MISSA');
        const hit = on.list.find(s => s.symbol === 'HITA');
        expect(hit).toBeDefined();
        expect(hit.volume).toBe(0);
        expect(on.list.find(s => s.symbol === 'REJA')).toBeUndefined();
    }, 60000);

    test('a holiday build is never reused', async () => {
        const pf = require('../src/services/universePrefilterService');
        const query = async (sql) => (/hermes_build_status/.test(sql)
            ? { rows: [{ d: '2026-11-26' }, { d: '2026-11-25' }] }
            : { rows: [] });
        expect((await pf.loadHermesCache('2026-11-27', { query })).date).toBe('2026-11-25');
    });

    test('on with no completed HERMES build → full Yahoo build (fallback)', async () => {
        const on = await runBlitz('on', { buildDate: null });
        expect(on.calls.quote).toEqual(expect.arrayContaining(['HITA', 'HITB', 'REJA', 'MISSA']));
    }, 60000);
});
