/** Wash-sale tracker + weekly worst-trade look-back (2026-11-01). */
const { findWashSales } = require('../src/services/washSaleService');
const { classify } = require('../src/services/tradeLookbackService');

const T = (id, action, qty, date, pnl = null, symbol = 'ORCL') => ({ id, symbol, action, quantity: qty, pnl, trade_date: `${date}T15:00:00` });

describe('findWashSales', () => {
    test('loss sale re-bought within 30 days is washed', () => {
        const rows = findWashSales([T(1, 'BUY', 2, '2026-09-01'), T(2, 'SELL', 2, '2026-09-10', -12), T(3, 'BUY', 2, '2026-09-25')]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ symbol: 'ORCL', sharesMatched: 2, disallowed: -12 });
    });

    test('re-buy after 30 days, or a gain, is not a wash', () => {
        expect(findWashSales([T(1, 'BUY', 1, '2026-09-01'), T(2, 'SELL', 1, '2026-09-10', -5), T(3, 'BUY', 1, '2026-10-20')])).toEqual([]);
        expect(findWashSales([T(1, 'BUY', 1, '2026-09-01'), T(2, 'SELL', 1, '2026-09-10', 5), T(3, 'BUY', 1, '2026-09-12')])).toEqual([]);
    });

    test('the lot being sold is not its own replacement', () => {
        // bought 9/1, sold all at a loss 9/10, nothing bought after
        expect(findWashSales([T(1, 'BUY', 3, '2026-09-01'), T(2, 'SELL', 3, '2026-09-10', -9)])).toEqual([]);
    });

    test('shares bought before the sale and still held after it count', () => {
        // two lots, sell one at a loss; the other lot (bought within 30 days) is still held
        const rows = findWashSales([T(1, 'BUY', 1, '2026-09-01'), T(2, 'BUY', 1, '2026-09-05'), T(3, 'SELL', 1, '2026-09-10', -4)]);
        expect(rows[0]).toMatchObject({ sharesMatched: 1, disallowed: -4 });
    });

    test('partial replacement washes a proportional part; each share used once', () => {
        const rows = findWashSales([
            T(1, 'BUY', 4, '2026-09-01'), T(2, 'SELL', 4, '2026-09-10', -8),
            T(3, 'BUY', 1, '2026-09-15'), T(4, 'SELL', 1, '2026-09-20', -1),
        ]);
        expect(rows[0]).toMatchObject({ saleId: 2, sharesMatched: 1, disallowed: -2 });
        expect(rows).toHaveLength(1); // buy 3 was already used for sale 2; nothing replaces sale 4
    });

    test('options/crypto symbols and the year window are respected', () => {
        expect(findWashSales([T(1, 'BUY', 1, '2026-09-01', null, 'BTC/USD'), T(2, 'SELL', 1, '2026-09-02', -3, 'BTC/USD'), T(3, 'BUY', 1, '2026-09-03', null, 'BTC/USD')])).toEqual([]);
        const all = [T(1, 'BUY', 1, '2025-12-01'), T(2, 'SELL', 1, '2025-12-20', -3), T(3, 'BUY', 1, '2026-01-05')];
        expect(findWashSales(all, { from: '2026-01-01' })).toEqual([]);
        expect(findWashSales(all, { from: '2025-01-01', to: '2026-01-01' })).toHaveLength(1);
    });
});

describe('look-back classify', () => {
    test('overnight gap past the stop (PM 10-21) is not called a bug', () => {
        expect(classify({ pnlPct: -7.7, bestGainPct: 0.3, afterPct: 8.5, worstGapPct: -7.7 })).toMatch(/^Gapped down 7\.7%.*recovered \+8\.5%/);
    });
    test('one-session crash (VLO 10-27) vs a real overshoot', () => {
        expect(classify({ pnlPct: -6, bestGainPct: 1.4, afterPct: null, worstGapPct: 0.1, worstSessionPct: -8.5 })).toMatch(/^Fell 8\.5% within one session/);
        expect(classify({ pnlPct: -7, bestGainPct: 1, afterPct: null, worstGapPct: -0.5, worstSessionPct: -2 })).toMatch(/^Possible bug/);
    });
    test('bad entry, gave back a winner, normal stop', () => {
        expect(classify({ pnlPct: -2.5, bestGainPct: 0.7, afterPct: -3.5 })).toBe('Bad entry — never went up');
        expect(classify({ pnlPct: -3.5, bestGainPct: 3.8, afterPct: null })).toMatch(/^Gave back a winner — was up 3\.8%/);
        expect(classify({ pnlPct: -3.1, bestGainPct: 1.6, afterPct: 1 })).toBe('Normal stop — small rise, then stopped');
    });
});
