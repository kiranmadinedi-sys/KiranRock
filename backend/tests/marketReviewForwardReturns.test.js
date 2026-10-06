jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/**
 * 2026-10-06: forward returns were measured from price_at_scan (whatever quote the nightly
 * analysis saw — often the previous close or an intraday price), so part of the scan day's
 * own move leaked into the "forward" return. They're now measured from base_close, the last
 * daily close on or before scan_date.
 */
describe('marketReviewService.backfillForwardReturns — base_close', () => {
    let svc, query;

    function setup(pendingRows, { base, forward }) {
        jest.resetModules();
        query = jest.fn(async (sql, params) => {
            if (/ALTER TABLE/.test(sql)) return { rows: [] };
            if (/FROM market_review_snapshots/.test(sql) && /SELECT/.test(sql)) return { rows: pendingRows };
            if (/timestamp::date <= \$2/.test(sql)) return { rows: base == null ? [] : [{ close: String(base) }] };
            if (/timestamp::date > \$2/.test(sql)) return { rows: forward.map((c, i) => ({ day: `d${i}`, close: String(c) })) };
            return { rows: [] }; // UPDATEs
        });
        jest.doMock('../src/config/database', () => ({ query }));
        jest.doMock('../src/services/marketRegimeService', () => ({ getMarketRegime: jest.fn() }));
        svc = require('../src/services/marketReviewService');
    }

    test('returns are measured from the scan-day close, not price_at_scan', async () => {
        // The scan saw a stale 90.00; the stock actually closed the scan day at 100.00.
        setup([{ id: 1, scan_date: '2026-09-15', symbol: 'ABC', price_at_scan: '90.00', expired: false }],
              { base: 100, forward: [101, 102, 103, 104, 110] });
        await svc.backfillForwardReturns();
        const upd = query.mock.calls.find(([sql]) => /UPDATE market_review_snapshots\s+SET close_1d/.test(sql));
        const [c1, r1, c3, r3, c5, r5, baseClose, id] = upd[1];
        expect(baseClose).toBe(100);
        expect(r1).toBeCloseTo(1, 3);   // 101 vs 100 — not +12.2% vs the stale 90
        expect(r3).toBeCloseTo(3, 3);
        expect(r5).toBeCloseTo(10, 3);
        expect([c1, c3, c5, id]).toEqual([101, 103, 110, 1]);
    });

    test('an expired row with no price history is marked base_close = 0 so it is never re-picked', async () => {
        setup([{ id: 7, scan_date: '2026-08-01', symbol: 'GONE', price_at_scan: '5', expired: true }],
              { base: null, forward: [] });
        await svc.backfillForwardReturns();
        const mark = query.mock.calls.find(([sql]) => /SET base_close = 0/.test(sql));
        expect(mark[1]).toEqual([7]);
    });

    test('a recent row with no price history is left for a later retry', async () => {
        setup([{ id: 8, scan_date: '2026-10-01', symbol: 'NEW', price_at_scan: '5', expired: false }],
              { base: null, forward: [] });
        await svc.backfillForwardReturns();
        expect(query.mock.calls.some(([sql]) => /UPDATE market_review_snapshots/.test(sql))).toBe(false);
    });
});
