/** Daily prediction check + portfolio lab (2026-11-07). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const pc = require('../src/services/predictionCheckService');
const pl = require('../src/services/portfolioLabService');
const agent = require('../src/services/researchAgentService');

describe('prediction check', () => {
    test('spearman: perfect, inverse, ties', () => {
        expect(pc.spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
        expect(pc.spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
        expect(pc.spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    });
    test('measure: spread of score ≥80 vs the night average', () => {
        const rows = [{ score: 90, r5: 4 }, { score: 85, r5: 2 }, { score: 50, r5: -3 }, { score: 40, r5: -3 }];
        const m = pc.measure(rows);
        expect(m.meanR5).toBe(0);
        expect(m.spread80).toBe(3);
        expect(m.n80).toBe(2);
        expect(m.ic).toBeGreaterThan(0.9);
    });
    test('fading needs enough nights and both measures negative', () => {
        expect(pc.isFading({ nights: 10, avgIc: -0.02, avgSpread80: -0.3 })).toBe(true);
        expect(pc.isFading({ nights: 10, avgIc: 0.02, avgSpread80: -0.3 })).toBe(false);
        expect(pc.isFading({ nights: 5, avgIc: -0.02, avgSpread80: -0.3 })).toBe(false);
    });
});

describe('portfolio lab', () => {
    test('validateSpec fills from control, rejects unknown settings and bad ranges', () => {
        expect(pl.validateSpec({ slots: 10 })).toEqual({ ...pl.CONTROL, slots: 10 });
        expect(pl.validateSpec({ sectorCap: null }).sectorCap).toBeNull();
        expect(() => pl.validateSpec({ leverage: 2 })).toThrow('unknown setting leverage');
        expect(() => pl.validateSpec({ slots: 0 })).toThrow('bad slots');
    });

    // 6 trading days; one scan night picks A (score 90) and B (80, same sector).
    const cal = ['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05', '2026-06-08'];
    const px = new Map();
    const bar = (s, d, o, h, l, c) => px.set(`${s}|${d}`, { o, h, l, c });
    cal.forEach((d, i) => bar('SPY', d, 100, 100, 100, 100 + i));
    cal.forEach((d, i) => bar('A', d, 10 + i, 10 + i, 10 + i, 10 + i));   // rises 10/day
    cal.forEach(d => bar('B', d, 10, 10, 10, 10));                         // flat
    const data = { cal, px, byNight: new Map([['2026-06-01', [
        { d: '2026-06-01', symbol: 'A', score: 90, sector: 'Tech' },
        { d: '2026-06-01', symbol: 'B', score: 80, sector: 'Tech' },
    ]]]) };

    test('buys at the next open in score order, respects the sector cap, exits on time', () => {
        const spec = pl.validateSpec({ slots: 2, sectorCap: 1, stopPct: null, trailPct: null, takeProfitPct: null, holdDays: 3, reservePct: 0, minScore: 75 });
        const r = pl.simulate(spec, data, { fromIdx: 1 });
        expect(r.trades).toBe(1);                       // B blocked by the 1-per-sector cap
        // half the equity in A: bought 11 (+slippage) on 06-02, sold at the 06-04 close 13
        expect(r.avgTradePct).toBeCloseTo((13 * 0.999 / (11 * 1.001) - 1) * 100, 1);
        expect(r.spyPct).toBeCloseTo(5, 1);   // 100 → 105 over the period
    });

    test('min score filters picks', () => {
        const spec = pl.validateSpec({ minScore: 95, stopPct: null, trailPct: null });
        expect(pl.simulate(spec, data, { fromIdx: 1 }).trades).toBe(0);
    });

    test('starter grid is valid and names are unique', () => {
        const g = pl.starterSpecs();
        expect(new Set(g.map(x => x.name)).size).toBe(g.length);
        for (const x of g) expect(() => pl.validateSpec(x.spec)).not.toThrow();
    });
});

test('agent: portfolio ideas are validated separately and de-duplicated', () => {
    const reply = JSON.stringify([
        { type: 'portfolio', name: 'slots8_cap2', idea: 'more slots', spec: { slots: 8, sectorCap: 2 } },
        { type: 'portfolio', name: 'bad_one', idea: 'x', spec: { leverage: 3 } },
        { name: 'drift_5d', family: 'event', idea: 'y', spec: { when: [], event: 'buyback', hold: 5 } },
    ]);
    const { accepted, portfolio, rejected } = agent.acceptIdeas(reply, [], [{ name: 'old', spec: pl.validateSpec({ slots: 10 }) }]);
    expect(portfolio.map(p => p.name)).toEqual(['slots8_cap2']);
    expect(accepted.map(a => a.name)).toEqual(['drift_5d']);
    expect(rejected.map(r => r.why)).toContain('unknown setting leverage');
});
