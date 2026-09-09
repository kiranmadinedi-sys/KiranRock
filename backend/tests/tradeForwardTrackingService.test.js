const { query } = require('../src/config/database');
const { logger } = require('../src/utils/logger');

jest.mock('../src/config/database');
jest.mock('../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));
jest.mock('../src/services/dataProvider', () => ({
    getBars: jest.fn(),
}));

const dataProvider = require('../src/services/dataProvider');
const tradeForwardTrackingService = require('../src/services/tradeForwardTrackingService');

describe('tradeForwardTrackingService', () => {
    beforeEach(() => {
        query.mockClear();
        query.mockResolvedValue({ rows: [] });
        dataProvider.getBars.mockClear();
        logger.debug.mockClear();
    });

    describe('recordTradeEntry', () => {
        test('inserts a tracking row anchored to the real entry price', async () => {
            await tradeForwardTrackingService.recordTradeEntry({
                tradeId: 42,
                symbol: 'NVDA',
                userId: 'user-1',
                entryDate: '2026-09-08',
                entryPrice: 180.5,
                aiScore: 91,
                sector: 'Technology',
                regime: 'BULL_MILD',
            });

            const insertCall = query.mock.calls.find(c => c[0].includes('INSERT INTO trade_forward_tracking'));
            expect(insertCall).toBeDefined();
            expect(insertCall[1]).toEqual([42, 'NVDA', 'user-1', '2026-09-08', 180.5, 91, 'Technology', 'BULL_MILD']);
        });

        test('does nothing (no INSERT attempted) when entry price is missing or zero', async () => {
            await tradeForwardTrackingService.recordTradeEntry({
                tradeId: 1, symbol: 'AAPL', userId: 'user-1', entryDate: '2026-09-08', entryPrice: 0,
            });
            const insertCall = query.mock.calls.find(c => c[0].includes('INSERT INTO trade_forward_tracking'));
            expect(insertCall).toBeUndefined();
        });

        test('swallows a DB failure rather than throwing — this must never affect a real trade', async () => {
            query.mockRejectedValue(new Error('connection lost'));
            await expect(tradeForwardTrackingService.recordTradeEntry({
                tradeId: 1, symbol: 'AAPL', userId: 'user-1', entryDate: '2026-09-08', entryPrice: 190,
            })).resolves.toBeUndefined();
            expect(logger.debug).toHaveBeenCalled();
        });
    });

    describe('updateTradeForwardTracking', () => {
        test('computes and stores forward metrics for an open tracking row using real bars', async () => {
            query.mockImplementation((sql) => {
                if (sql.includes('SELECT id, symbol, entry_price, recorded_at')) {
                    return Promise.resolve({
                        rows: [{
                            id: 7, symbol: 'AMD', entry_price: '100',
                            recorded_at: new Date(Date.now() - 6 * 86400000).toISOString(),
                        }],
                    });
                }
                return Promise.resolve({ rows: [] });
            });
            dataProvider.getBars.mockResolvedValue([
                { time: new Date(Date.now() - 5 * 86400000).toISOString(), high: 105, low: 99,  close: 104 },
                { time: new Date(Date.now() - 4 * 86400000).toISOString(), high: 108, low: 100, close: 107 },
                { time: new Date(Date.now() - 3 * 86400000).toISOString(), high: 110, low: 101, close: 109 },
                { time: new Date(Date.now() - 2 * 86400000).toISOString(), high: 112, low: 103, close: 111 },
                { time: new Date(Date.now() - 1 * 86400000).toISOString(), high: 115, low: 104, close: 113 },
            ]);

            const result = await tradeForwardTrackingService.updateTradeForwardTracking();

            expect(result.updated).toBe(1);
            const updateCall = query.mock.calls.find(c => c[0].includes('UPDATE trade_forward_tracking'));
            expect(updateCall).toBeDefined();
            // 5th bar close (113) vs entry (100) -> +13%
            expect(updateCall[1][2]).toBeCloseTo(13, 5);
        });

        test('skips a row gracefully when no bars are available (does not throw)', async () => {
            query.mockImplementation((sql) => {
                if (sql.includes('SELECT id, symbol, entry_price, recorded_at')) {
                    return Promise.resolve({ rows: [{ id: 1, symbol: 'ZZZZ', entry_price: '10', recorded_at: new Date().toISOString() }] });
                }
                return Promise.resolve({ rows: [] });
            });
            dataProvider.getBars.mockResolvedValue([]);

            const result = await tradeForwardTrackingService.updateTradeForwardTracking();
            expect(result.failed).toBe(1);
            expect(result.updated).toBe(0);
        });
    });

    describe('getActualBuyAttribution', () => {
        test('returns the single aggregate row for the given day window, not gated on closed_at', async () => {
            const mockRow = {
                n: 12, n_5d: 12, n_10d: 8, n_20d: 2,
                avg_return_5d_pct: '1.20', avg_return_10d_pct: '2.10', avg_return_20d_pct: '3.40', would_have_won: 8,
            };
            query.mockImplementation((sql) => {
                if (sql.includes('FROM trade_forward_tracking')) {
                    // 2026-09-08 revision: no full 20-day close-out required to see a 5D/10D read.
                    expect(sql).not.toMatch(/closed_at IS NOT NULL/);
                    return Promise.resolve({ rows: [mockRow] });
                }
                return Promise.resolve({ rows: [] });
            });

            const result = await tradeForwardTrackingService.getActualBuyAttribution({ days: 30 });
            expect(result).toEqual(mockRow);
            const aggCall = query.mock.calls.find(c => c[0].includes('FROM trade_forward_tracking'));
            expect(aggCall[1]).toEqual([30]);
        });
    });
});
