/** Research lab: spec validation, features, trade returns and the fixed pass rule (2026-11-07). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const lab = require('../src/services/researchLabService');

const bar = (d, o, h, l, c, v = 1000) => ({ d, o, h, l, c, v });

describe('validateSpec', () => {
    test('accepts a good spec and fills defaults', () => {
        expect(lab.validateSpec({ when: [['ret1', '>=', 4]] })).toEqual({ when: [['ret1', '>=', 4]], hold: 5, stopPct: null });
    });
    test.each([
        [{ when: [] }, /non-empty/],
        [{ when: [['magic', '>', 1]] }, /unknown feature/],
        [{ when: [['ret1', '~', 1]] }, /unknown op/],
        [{ when: [['ret1', 'between', 3]] }, /bad value/],
        [{ when: [['ret1', '>', 1]], hold: 0 }, /hold/],
        [{ when: [['ret1', '>', 1]], stopPct: 80 }, /stopPct/],
    ])('rejects %j', (spec, msg) => expect(() => lab.validateSpec(spec)).toThrow(msg));
});

test('matches needs every condition and treats missing features as no match', () => {
    const when = [['ret1', '>=', 4], ['rsi14', 'between', [50, 70]]];
    expect(lab.matches(when, { ret1: 5, rsi14: 60 })).toBe(true);
    expect(lab.matches(when, { ret1: 5, rsi14: 75 })).toBe(false);
    expect(lab.matches(when, { ret1: 5, rsi14: null })).toBe(false);
});

test('rollingExtreme matches a brute-force window', () => {
    const a = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
    const mx = lab.rollingExtreme(a, 3, true), mn = lab.rollingExtreme(a, 3, false);
    for (let i = 2; i < a.length; i++) {
        expect(mx[i]).toBe(Math.max(...a.slice(i - 2, i + 1)));
        expect(mn[i]).toBe(Math.min(...a.slice(i - 2, i + 1)));
    }
    expect(mx[1]).toBeNull();
});

describe('tradeReturn', () => {
    const bars = [bar('d0', 10, 10, 10, 10), bar('d1', 10, 11, 9.8, 10.5), bar('d2', 10.5, 11, 9, 9.2), bar('d3', 9, 12, 9, 12)];
    test('buys next open, sells the close `hold` days later', () => {
        expect(lab.tradeReturn(bars, 0, 3, null)).toBeCloseTo(20);
    });
    test('a stop exits at the stop price', () => {
        expect(lab.tradeReturn(bars, 0, 3, 5)).toBeCloseTo(-5);
    });
    test('a gap below the stop exits at the open, not the stop', () => {
        const gap = [bar('d0', 10, 10, 10, 10), bar('d1', 10, 10, 10, 10), bar('d2', 8, 8.5, 7.5, 8)];
        expect(lab.tradeReturn(gap, 0, 2, 5)).toBeCloseTo(-20);
    });
    test('not enough bars → null', () => expect(lab.tradeReturn(bars, 1, 5, null)).toBeNull());
});

test('computeFeatures: ret1, volume ratio and 52-week distance on a simple series', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(`2024-01-${String(i + 1).padStart(2, '0')}`, 100, 101, 99, 100, 1000));
    bars[29] = bar('2024-01-30', 100, 106, 100, 105, 3000);
    const f = lab.computeFeatures(bars)[29];
    expect(f.ret1).toBeCloseTo(5);
    expect(f.volRatio).toBeCloseTo(3);
    expect(f.rangePos).toBeCloseTo(5 / 6);
    expect(f.high52Dist).toBeNull(); // fewer than 252 bars
});

test('computeFeatures: nextGap is the next open vs today\'s close (the entry price), null on the last bar', () => {
    const bars = Array.from({ length: 30 }, (_, i) => bar(`2024-01-${String(i + 1).padStart(2, '0')}`, 100, 101, 99, 100, 1000));
    bars[29] = bar('2024-01-30', 87, 95, 86, 94, 5000); // gaps down 13% from the prior 100 close
    const feats = lab.computeFeatures(bars);
    expect(feats[28].nextGap).toBeCloseTo(-13);
    expect(feats[29].nextGap).toBeNull();
    // the trade the spec selects buys exactly that gapped open
    expect(lab.tradeReturn(bars, 28, 1, null)).toBeCloseTo((94 / 87 - 1) * 100);
    expect(lab.matches([['nextGap', '<=', -8]], feats[28])).toBe(true);
});

describe('scoreIdea pass rule', () => {
    const days = (from, n) => Array.from({ length: n }, (_, i) => {
        const d = new Date(`${from}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10);
    });
    const build = (dates, edgeFn) => {
        const sig = new Map(), base = new Map();
        dates.forEach((d, i) => { const e = edgeFn(i); sig.set(d, { s: e * 2, n: 2, w: e > 0 ? 2 : 0 }); base.set(d, { s: 0, n: 10, w: 5 }); });
        return [sig, base];
    };
    const dates = [...days('2023-02-01', 300), ...days('2025-08-01', 80)];

    test('steady edge in train and holdout, every year positive → pass', () => {
        const r = lab.scoreIdea(...build(dates, i => 0.8 + (i % 2 ? 0.3 : -0.3)));
        expect(r.verdict).toBe('pass');
        expect(r.train.edgePp).toBeCloseTo(0.8, 1);
    });
    test('edge that vanishes in the holdout → fail', () => {
        const r = lab.scoreIdea(...build(dates, i => (dates[i] < lab.HOLDOUT_START ? 0.8 : -0.2) + (i % 2 ? 0.3 : -0.3)));
        expect(r.verdict).toBe('fail');
        expect(r.why).toMatch(/holdout/);
    });
    test('too few dates → fail', () => {
        const r = lab.scoreIdea(...build(days('2023-02-01', 20), () => 1));
        expect(r.verdict).toBe('fail');
        expect(r.why).toMatch(/train dates/);
    });
});

describe('news events in specs', () => {
    const cal = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09'];
    const idx = new Map(cal.map((d, i) => [d, i]));
    test('pre-open news on a trading day → buy that open (signal = day before)', () => {
        expect(lab.eventSignalDay('2026-11-04', true, cal, idx)).toBe('2026-11-03');
    });
    test('news during or after the session → buy the next open (signal = news day)', () => {
        expect(lab.eventSignalDay('2026-11-04', false, cal, idx)).toBe('2026-11-04');
    });
    test('weekend news → buy Monday open (signal = Friday)', () => {
        expect(lab.eventSignalDay('2026-11-07', true, cal, idx)).toBe('2026-11-06');
        expect(lab.eventSignalDay('2026-11-08', false, cal, idx)).toBe('2026-11-06');
    });
    test('no later open in the calendar → null', () => {
        expect(lab.eventSignalDay('2026-11-09', false, cal, idx)).toBeNull();
    });
    test('an event-only spec is valid; unknown or noise events are not', () => {
        expect(lab.validateSpec({ when: [], event: 'analyst_upgrade' }).event).toEqual(['analyst_upgrade']);
        expect(() => lab.validateSpec({ when: [], event: 'magic' })).toThrow(/unknown event/);
        expect(() => lab.validateSpec({ when: [], event: 'noise' })).toThrow(/unknown event/);
    });
});
