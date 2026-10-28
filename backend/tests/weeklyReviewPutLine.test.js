/** Options review per-put line (2026-10-27). */
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
const { putLine } = require('../src/services/weeklyStrategyReviewService');

const base = { underlying: 'SHAK', strike: 65, entry_premium: 2.7, collateral: 6500, crossed: true,
    opened_at: '2026-10-20T14:00:00Z', closed_at: '2026-11-06T15:00:00Z' };

test('stop that gapped past its trigger shows the overshoot', () => {
    const l = putLine({ ...base, status: 'closed', close_reason: 'stop (3× premium)', close_premium: 9.6, pnl: -690 });
    expect(l).toContain('SHAK $65P (earnings): stop (3× premium)');
    expect(l).toContain('sold $2.70 → bought back $9.60');
    expect(l).toContain('fill vs trigger $8.10: +$1.50/sh');
    expect(l).toContain('17d held');
});

test('time exit has no trigger level; return on collateral per year', () => {
    const l = putLine({ ...base, underlying: 'HPQ', strike: 30, entry_premium: 0.71, collateral: 3000, crossed: false,
        status: 'closed', close_reason: 'close near expiry (7d)', close_premium: 0.11, pnl: 60,
        opened_at: '2026-10-22T14:00:00Z', closed_at: '2026-11-13T15:00:00Z' });
    expect(l).not.toContain('trigger');
    expect(l).toContain('22d held');
    expect(l).toContain('+33.18%/yr on collateral vs T-bills 4%');
});

test('assignment shows the stock price instead of a buyback', () => {
    const l = putLine({ ...base, status: 'assigned', close_reason: 'assigned — 100 shares at $65.00', close_premium: 0, assigned_price: 58, pnl: -430 });
    expect(l).toContain('assigned, stock $58.00');
    expect(l).toContain('−$430.00');
});
