/** Options lab: Black-Scholes, IV solver, trade lifecycle and the safety guard (2026-11-14). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const ol = require('../src/services/optionsLabService');

describe('Black-Scholes', () => {
    test('put price matches a textbook value', () => {
        // S=100 K=100 T=1 r=5% σ=20% → put ≈ 5.57
        expect(ol.putPrice(100, 100, 1, 0.05, 0.2)).toBeCloseTo(5.57, 1);
    });
    test('implied vol recovers the volatility used to price', () => {
        const p = ol.putPrice(50, 45, 30 / 365, 0.04, 0.37);
        expect(ol.impliedVol(p, 50, 45, 30 / 365, 0.04)).toBeCloseTo(0.37, 3);
    });
    test('price below intrinsic has no IV', () => {
        expect(ol.impliedVol(1, 40, 50, 30 / 365)).toBeNull();
    });
    test('OTM put delta is between -0.5 and 0', () => {
        const d = ol.putDelta(100, 90, 30 / 365, 0.04, 0.3);
        expect(d).toBeLessThan(0); expect(d).toBeGreaterThan(-0.5);
    });
});

test('thirdFriday gives the standard monthly expiry', () => {
    expect(ol.thirdFriday(2024, 3)).toBe('2024-03-15');
    expect(ol.thirdFriday(2026, 11)).toBe('2026-11-20');
    expect(ol.thirdFriday(2026, 12)).toBe('2026-12-18');
});

describe('simulate one short put', () => {
    const stock = [
        { d: '2024-03-01', o: 100, c: 100 }, { d: '2024-03-04', o: 100, c: 99 }, { d: '2024-03-05', o: 99, c: 97 },
        { d: '2024-03-06', o: 97, c: 92 }, { d: '2024-03-15', o: 92, c: 88 }, { d: '2024-03-18', o: 87, c: 87 },
    ];
    const base = { entryDay: '2024-03-01', expiry: '2024-03-15', strike: 95, premium: 1, stock };
    test('take profit fires on the first close at or below 50% (after the spread allowance)', () => {
        const opt = new Map([['2024-03-04', { c: 0.4 }]]);
        const r = ol.simulate({ ...base, opt, exit: { tp: 0.5, stop: 3, closeDte: 7 } });
        expect(r.reason).toBe('take profit');
        expect(r.cost).toBeCloseTo(0.4 * 1.05 + 0.0005, 4);
    });
    test('stop fires at 3× premium', () => {
        const opt = new Map([['2024-03-05', { c: 3.2 }]]);
        expect(ol.simulate({ ...base, opt, exit: { tp: 0.5, stop: 3, closeDte: null } }).reason).toBe('stop');
    });
    test('days with no option trade are never checked (no invented marks)', () => {
        const r = ol.simulate({ ...base, opt: new Map(), exit: { tp: 0.5, stop: 3, closeDte: null } });
        expect(r.noTradeDays).toBeGreaterThan(0);
        expect(r.checked).toBe(0);
    });
    test('held to expiry in the money → assigned, shares sold at next open (full lifecycle loss)', () => {
        const r = ol.simulate({ ...base, opt: new Map(), exit: { tp: null, stop: null, closeDte: null } });
        expect(r.reason).toBe('assigned');
        expect(r.cost).toBeCloseTo(95 - 87);
        const t = ol.tradeResult(r, 1, 95);
        expect(t.pnl).toBeCloseTo((1 - 8) * 100);
    });
});

test('safety guard blocks anything but the two read-only market-data paths', async () => {
    await expect(ol.labGet('https://paper-api.alpaca.markets/v2/orders', {})).rejects.toThrow(/blocked/);
    await expect(ol.labGet('https://api.alpaca.markets/v2/positions', {})).rejects.toThrow(/blocked/);
});
