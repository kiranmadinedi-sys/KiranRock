/**
 * Phase 1 stock-selection experiment (2026-10-12): paper-only "oversold" ordering.
 */
describe('selectionExperimentService', () => {
    let exp;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
        exp = require('../src/services/selectionExperimentService');
    });

    afterEach(() => { delete process.env.SELECTION_EXPERIMENT_USER_IDS; });

    test('only accounts listed in SELECTION_EXPERIMENT_USER_IDS are in the experiment', () => {
        expect(exp.isExperimentUser('paper-1')).toBe(false); // unset = nobody
        process.env.SELECTION_EXPERIMENT_USER_IDS = 'paper-1, other';
        expect(exp.isExperimentUser('paper-1')).toBe(true);
        expect(exp.isExperimentUser('kmadined-id')).toBe(false);
    });

    test('oversold score = mean-reversion points minus positive momentum points', () => {
        const log = [
            'WilliamsR: +6 (oversold -88)',
            'BB: +4 (LOWER_BAND)',
            'RelStrength20d: +4 (4.9pp vs SPY)',
            'TrendTemplate: -2 (1/5)',          // negative momentum is NOT added back
            'MACD: +6 (BULLISH)',               // neither group — ignored
            'News: +4.00 (sentiment 50) [unscored]',
        ];
        expect(exp.oversoldScore(log)).toBe(6 + 4 - 4);
    });

    test('an overbought stock that has already run scores low', () => {
        const chased = ['WilliamsR: -3 (near overbought)', 'BB: -2 (MILD_OVERBOUGHT)', '52wkHigh: +7', 'VISION: +8 (UP/HIGH)'];
        expect(exp.oversoldScore(chased)).toBe(-3 - 2 - 7 - 8);
        expect(exp.oversoldScore(null)).toBe(0);
    });

    test('steady trend = full uptrend, RSI 55-70, $50+ stock', () => {
        const up = ['TrendTemplate: +15 (5/5 MA conditions)'];
        expect(exp.isSteadyTrend({ scoringLog: up, rsi: 62, price: 390 })).toBe(true);   // Visa-like
        expect(exp.isSteadyTrend({ scoringLog: up, rsi: 74, price: 390 })).toBe(false);  // overbought
        expect(exp.isSteadyTrend({ scoringLog: up, rsi: 62, price: 12 })).toBe(false);   // cheap
        expect(exp.isSteadyTrend({ scoringLog: ['TrendTemplate: +6 (2/5)'], rsi: 62, price: 390 })).toBe(false);
        expect(exp.isSteadyTrend({ scoringLog: up, rsi: null, price: 390 })).toBe(false);
    });

    test('ordering: oversold score first, AI score breaks ties', () => {
        const xs = [
            { symbol: 'A', oversoldScore: 2, aiScore: 99 },
            { symbol: 'B', oversoldScore: 8, aiScore: 81 },
            { symbol: 'C', oversoldScore: 8, aiScore: 90 },
        ];
        expect(xs.sort(exp.compareOversold).map(x => x.symbol)).toEqual(['C', 'B', 'A']);
    });
});

describe('selectionExperimentService.runDailyPickLog', () => {
    let exp, query;
    const pool = [
        { row: {}, symbol: 'HOT', scanDate: '2026-10-12', aiScore: 100, oversoldScore: -20 },
        { row: {}, symbol: 'DIP', scanDate: '2026-10-12', aiScore: 84, oversoldScore: 10, steadyTrend: true },
    ];

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
        jest.doMock('../src/services/precomputedUniverseService', () => ({
            loadCandidates: jest.fn(async ({ onPool }) => { await onPool(pool); return []; }),
        }));
        jest.doMock('axios', () => ({ get: jest.fn().mockRejectedValue(new Error('no network in tests')) }));
        jest.doMock('../src/services/insiderSignalService', () => ({
            getActiveClusters: jest.fn().mockResolvedValue([{ symbol: 'SBLK', insiders: 5 }]),
        }));
        process.env.SELECTION_EXPERIMENT_USER_IDS = 'paper-1';
        exp = require('../src/services/selectionExperimentService');
        query = require('../src/config/database').query;
    });

    afterEach(() => { delete process.env.SELECTION_EXPERIMENT_USER_IDS; });

    const inserts = () => query.mock.calls.filter(c => /INSERT INTO selection_experiment_picks/.test(c[0]));

    test('logs both arms once per trading day, from 9:35 ET', async () => {
        await exp.runDailyPickLog(new Date('2026-10-13T13:32:00Z')); // 9:32 ET — too early
        expect(inserts()).toHaveLength(0);

        await exp.runDailyPickLog(new Date('2026-10-13T13:40:00Z')); // 9:40 ET
        await exp.runDailyPickLog(new Date('2026-10-13T13:45:00Z')); // next tick — skipped
        expect(inserts()).toHaveLength(1);
        const params = inserts()[0][1];
        expect(params.filter(p => p === 'control')).toHaveLength(2);
        expect(params.filter(p => p === 'oversold')).toHaveLength(2);
        expect(params.filter(p => p === 'steady')).toHaveLength(1); // only DIP qualifies
        expect(params.filter(p => p === 'insider')).toHaveLength(1); // active insider cluster, outside the score pool
        expect(params).toContain('SBLK');
    });

    test('does nothing on a weekend or with no experiment accounts', async () => {
        await exp.runDailyPickLog(new Date('2026-10-17T15:00:00Z')); // Saturday
        delete process.env.SELECTION_EXPERIMENT_USER_IDS;
        await exp.runDailyPickLog(new Date('2026-10-13T15:00:00Z'));
        expect(inserts()).toHaveLength(0);
    });
});

describe('precomputedUniverseService.loadCandidates — oversold ordering', () => {
    let svc, query;
    const row = (symbol, ai, log) => ({
        symbol, ai_score: String(ai), recommendation: 'BUY', setup_family: 'x', sector: 'Tech',
        market_cap: '5000000000', scan_date: '2026-10-12', scoring_log: log,
    });

    beforeEach(() => {
        jest.resetModules();
        jest.dontMock('../src/services/precomputedUniverseService'); // mocked by the block above
        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        svc = require('../src/services/precomputedUniverseService');
        query = require('../src/config/database').query;
    });

    test('keeps the most oversold of the same pool and hands the full pool to onPool', async () => {
        // Pool arrives in AI-score order, as the SQL returns it.
        query.mockResolvedValue({ rows: [
            row('HOT', 100, ['52wkHigh: +7', 'VISION: +8']),
            row('MID', 92, ['BB: +2']),
            row('DIP', 84, ['WilliamsR: +6', 'Wyckoff_VDU: +4']),
        ] });
        const seen = [];

        const out = await svc.loadCandidates({ minScore: 80, limit: 2, rankBy: 'oversold', onPool: p => seen.push(...p) });

        expect(out.map(c => c.symbol)).toEqual(['DIP', 'MID']);
        expect(out[0]).toMatchObject({ _preScreened: true, _precomputedScore: 84, _oversoldScore: 10 });
        expect(seen.map(p => p.symbol)).toEqual(['HOT', 'MID', 'DIP']); // control order intact
        expect(query.mock.calls[0][1]).toEqual([80]); // same ≥ minScore pool, no LIMIT
    });

    test('a failing onPool logger never blocks candidate loading', async () => {
        query.mockResolvedValue({ rows: [row('DIP', 84, ['WilliamsR: +6'])] });
        const out = await svc.loadCandidates({ minScore: 80, limit: 40, rankBy: 'oversold', onPool: () => { throw new Error('db down'); } });
        expect(out.map(c => c.symbol)).toEqual(['DIP']);
    });

    test('the jump guard (>5% scan-day rise) is in both candidate queries', async () => {
        query.mockResolvedValue({ rows: [] });
        await svc.loadCandidates({ minScore: 80, limit: 40 });
        await svc.loadCandidates({ minScore: 80, limit: 40, rankBy: 'oversold' });
        for (const [sql] of query.mock.calls) expect(sql).toContain("COALESCE((metadata->>'change')::float, 0) <= 5");
    });

    test('pool rows carry the steady-trend flag', async () => {
        query.mockResolvedValue({ rows: [
            { ...row('V', 87, ['TrendTemplate: +15 (5/5 MA conditions)']), rsi: 64, price: 385 },
            { ...row('HOT', 99, ['TrendTemplate: +15 (5/5 MA conditions)']), rsi: 78, price: 385 }, // overbought
        ] });
        const seen = [];
        await svc.loadCandidates({ minScore: 80, limit: 40, rankBy: 'oversold', onPool: p => seen.push(...p) });
        expect(seen.find(p => p.symbol === 'V').steadyTrend).toBe(true);
        expect(seen.find(p => p.symbol === 'HOT').steadyTrend).toBe(false);
    });

    test('default ordering is unchanged (no oversold fields)', async () => {
        query.mockResolvedValue({ rows: [row('HOT', 100, [])] });
        const out = await svc.loadCandidates({ minScore: 80, limit: 40 });
        expect(out[0]).not.toHaveProperty('_oversoldScore');
        expect(query.mock.calls[0][0]).toMatch(/LIMIT \$2/);
    });
});

describe('orderByMethod — oil → energy tilt and sector strength (2026-10-17)', () => {
    let exp, axios;
    const acc = { log: x => x.log, sector: x => x.sector, score: x => x.score, rsi: () => null, price: () => null, symbol: x => x.symbol };
    const items = [
        { symbol: 'NVDA', sector: 'Technology', score: 100, log: ['SectorRotation: -8 (Tech rotating out — COMPASS)'] },
        { symbol: 'XOM', sector: 'Energy', score: 90, log: ['SectorRotation: +6 (Energy rotating in — COMPASS)'] },
        { symbol: 'JPM', sector: 'Financials', score: 95, log: [] },
    ];
    const bno = closes => ({ data: { bars: { BNO: closes.map((c, i) => ({ t: `2026-09-${String(i + 1).padStart(2, '0')}T04:00:00Z`, c })) } } });

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
        jest.doMock('axios', () => ({ get: jest.fn() }));
        exp = require('../src/services/selectionExperimentService');
        axios = require('axios');
    });

    test('oil up over ~20 days → Energy first; ties keep the incoming order', async () => {
        axios.get.mockResolvedValue(bno(Array.from({ length: 25 }, (_, i) => 30 + i * 0.2)));
        expect((await exp.orderByMethod(items, 'oil', acc)).map(x => x.symbol)).toEqual(['XOM', 'NVDA', 'JPM']);
    });

    test('oil down → order unchanged', async () => {
        axios.get.mockResolvedValue(bno(Array.from({ length: 25 }, (_, i) => 35 - i * 0.2)));
        expect((await exp.orderByMethod(items, 'oil', acc)).map(x => x.symbol)).toEqual(['NVDA', 'XOM', 'JPM']);
    });

    test('oil feed unavailable → order unchanged (never throws)', async () => {
        axios.get.mockRejectedValue(new Error('network'));
        expect((await exp.orderByMethod(items, 'oil', acc)).map(x => x.symbol)).toEqual(['NVDA', 'XOM', 'JPM']);
    });

    test('sector strength: rotating-in sectors first, rotating-out last', async () => {
        expect((await exp.orderByMethod(items, 'sector', acc)).map(x => x.symbol)).toEqual(['XOM', 'JPM', 'NVDA']);
    });

    test('control leaves the order alone', async () => {
        expect((await exp.orderByMethod(items, 'control', acc)).map(x => x.symbol)).toEqual(['NVDA', 'XOM', 'JPM']);
    });
});
