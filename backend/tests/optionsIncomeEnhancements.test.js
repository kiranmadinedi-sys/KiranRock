/** Options income fixes (2026-10-26): assignment P&L and step-down entry pricing. */
const { assignmentPnl, stepDownLimit } = require('../src/services/optionsIncomeService');

describe('assignmentPnl', () => {
    test('stock above strike at assignment → keep the whole premium', () => {
        expect(assignmentPnl({ premium: 2.7, strike: 65, price: 66 })).toBe(270);
    });
    test('SHAK-style: assigned at $65 with the stock at $58 is a loss, not a win', () => {
        expect(assignmentPnl({ premium: 2.7, strike: 65, price: 58 })).toBe(-430);
    });
    test('scales with contracts', () => expect(assignmentPnl({ premium: 1, strike: 50, price: 49, qty: 2 })).toBe(0));
});

describe('stepDownLimit', () => {
    const base = { mid: 1.0, bid: 0.7, steps: 3, floor: 0.5, current: 1.0 };
    test('steps a third of the mid−bid gap each time', () => {
        expect(stepDownLimit({ ...base, step: 1 })).toBe(0.9);
        expect(stepDownLimit({ ...base, step: 2, current: 0.9 })).toBe(0.8);
        expect(stepDownLimit({ ...base, step: 3, current: 0.8 })).toBe(0.7);
    });
    test('never below the minimum premium floor', () => {
        expect(stepDownLimit({ ...base, step: 3, floor: 0.85, current: 0.9 })).toBe(0.85);
    });
    test('no move after the last step, without quotes, or if it would not lower the price', () => {
        expect(stepDownLimit({ ...base, step: 4 })).toBeNull();
        expect(stepDownLimit({ ...base, bid: 0, step: 1 })).toBeNull();
        expect(stepDownLimit({ ...base, step: 1, current: 0.85 })).toBeNull();
    });
});
