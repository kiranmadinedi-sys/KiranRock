jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { rsiSeries, summarize, samplesForSymbol } = require('../src/services/historyBacktestService');

/** Multi-year rule tests on history_bars (2026-10-17). */
describe('historyBacktestService', () => {
    test('RSI is 100 on a straight rise and ~0 on a straight fall', () => {
        const up = Array.from({ length: 30 }, (_, i) => 100 + i);
        const down = Array.from({ length: 30 }, (_, i) => 100 - i);
        expect(rsiSeries(up)[29]).toBe(100);
        expect(rsiSeries(down)[29]).toBeLessThan(1);
        expect(rsiSeries(up)[5]).toBeNull(); // not enough history yet
    });

    test('a steady uptrend stock produces samples flagged steady, not oversold', () => {
        // 300 days of a smooth +0.15%/day climb with mild noise, $100+, liquid.
        const bars = [];
        let p = 100;
        for (let i = 0; i < 300; i++) {
            p *= 1.0015 + (i % 4 === 0 ? -0.004 : 0.001);
            const d = new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10);
            bars.push({ d, o: p, h: p * 1.01, l: p * 0.99, c: p, v: 100000 });
        }
        const dates = new Set(bars.map(b => b.d));
        const s = samplesForSymbol('UPCO', bars, dates);
        expect(s.length).toBeGreaterThan(0);
        expect(s.every(x => x.oversold === false)).toBe(true);
        expect(s.some(x => typeof x.trail5 === 'number' && typeof x.stop7hold === 'number')).toBe(true);
    });

    test('summarize: group excess is measured against the same day\'s candidates', () => {
        const mk = (d, jump, r) => ({ d, y: d.slice(0, 4), s: d + jump + r, jump, steady: false, oversold: false, chase: false, trail5: r, t5: r, t10: r, hold: r, trail7: r, stop7hold: r });
        const out = summarize([mk('2025-01-02', true, -2), mk('2025-01-02', false, 2), mk('2025-01-09', true, -1), mk('2025-01-09', false, 1)]);
        expect(out.years.all.jump.excessPp).toBe(-1.5); // −2 vs day mean 0, −1 vs day mean 0
        expect(out.years.all.exits.t5.vsTrailPp).toBe(0);
    });
});
