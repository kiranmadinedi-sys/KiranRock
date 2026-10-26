/** Core add-ons (2026-10-26): cash sweep + drawdown alert decisions. */
const { sweepDecision, drawdownDecision } = require('../src/services/coreAddonsService');

describe('sweepDecision (reserve 25%, sweep in above reserve+5%, out below reserve−2%)', () => {
    const base = { equity: 100000, reservePct: 25, sweptValue: 0 };
    test('cash between the lines → nothing', () => expect(sweepDecision({ ...base, cash: 27000 })).toBe(0));
    test('excess cash above 30% → sweep the excess in', () => expect(sweepDecision({ ...base, cash: 40000 })).toBe(10000));
    test('tiny excess below $100 → nothing', () => expect(sweepDecision({ ...base, cash: 30050 })).toBe(0));
    test('cash below 23% with swept shares → sweep out back to the reserve', () => {
        expect(sweepDecision({ ...base, cash: 20000, sweptValue: 15000 })).toBe(-5000);
    });
    test('never sweeps out more than was swept in (core SGOV untouched)', () => {
        expect(sweepDecision({ ...base, cash: 10000, sweptValue: 3000 })).toBe(-3000);
    });
    test('low cash but nothing swept → nothing to sell', () => expect(sweepDecision({ ...base, cash: 10000 })).toBe(0));
});

describe('drawdownDecision (alerts at 10/15/20%, reset under 5%)', () => {
    test('first reading sets the peak, no alert', () => expect(drawdownDecision({ index: 1.05, peak: null, alertedLevel: 0 })).toMatchObject({ newPeak: 1.05, alert: null }));
    test('new high moves the peak up', () => expect(drawdownDecision({ index: 1.2, peak: 1.1, alertedLevel: 0 }).newPeak).toBe(1.2));
    test('12% below peak → alert 10 once', () => {
        const d = drawdownDecision({ index: 0.88, peak: 1.0, alertedLevel: 0 });
        expect(d.alert).toBe(10); expect(d.level).toBe(10);
        expect(drawdownDecision({ index: 0.87, peak: 1.0, alertedLevel: 10 }).alert).toBeNull();
    });
    test('deeper to 16% → alert 15; 21% → alert 20', () => {
        expect(drawdownDecision({ index: 0.84, peak: 1.0, alertedLevel: 10 }).alert).toBe(15);
        expect(drawdownDecision({ index: 0.79, peak: 1.0, alertedLevel: 15 }).alert).toBe(20);
    });
    test('recovery to within 5% resets so a later drop alerts again', () => {
        expect(drawdownDecision({ index: 0.97, peak: 1.0, alertedLevel: 15 }).level).toBe(0);
    });
});
