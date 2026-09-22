jest.mock('axios');
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/userDatabaseService', () => ({ getUserAlpacaCredentials: jest.fn() }));
jest.mock('../src/services/tradesDatabaseService', () => ({ recordTrade: jest.fn(), ensureBrokerOrderIdColumn: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/tradeIntelligenceService', () => ({}));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const axios = require('axios');
const { query } = require('../src/config/database');
const userDb = require('../src/services/userDatabaseService');
const { reconcilePositions, reconcileFillHistory, _getBlitzManagedSymbols } = require('../src/services/positionReconciliationService');

/**
 * 2026-09-21: Blitz (intraday bot) trades the SAME Alpaca account as swing but keeps its
 * own complete, correct records in intraday_positions/intraday_trades - never the shared
 * holdings/trades this reconciler compares against, same isolation as crypto_positions/
 * crypto_trades a few lines away in the source. Real incident: META round-tripped 5 times
 * in one day under Blitz (all correctly logged in intraday_trades); this reconciler had no
 * way to know that, so it (a) auto-created a phantom holdings row double-counting
 * portfolio value against intraday_positions' own row, and (b) via reconcileFillHistory,
 * flagged all 8 fills "missing" and the DRIFT-decrease backfill wrote a wrong-priced row
 * into trades for a symbol Blitz alone owned.
 */
describe('Blitz/swing isolation in position reconciliation (2026-09-21)', () => {
    const userId = 'user-1';

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.BROKER = 'alpaca';
        userDb.getUserAlpacaCredentials.mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true });
    });

    describe('_getBlitzManagedSymbols', () => {
        test('unions currently-open Blitz positions with recently-closed Blitz trades', async () => {
            query.mockResolvedValue({ rows: [{ symbol: 'META' }, { symbol: 'WBD' }] });
            const s = await _getBlitzManagedSymbols(userId, 26);
            expect(s).toEqual(new Set(['META', 'WBD']));
            expect(query.mock.calls[0][0]).toMatch(/intraday_positions/);
            expect(query.mock.calls[0][0]).toMatch(/intraday_trades/);
            expect(query.mock.calls[0][1]).toEqual([userId, 26]);
        });
    });

    describe('reconcilePositions', () => {
        function setup({ dbHoldings = [], alpacaPositions = [], blitzSymbols = [] }) {
            query.mockImplementation(async (sql) => {
                if (/FROM holdings/.test(sql)) return { rows: dbHoldings };
                if (/intraday_positions|intraday_trades/.test(sql)) return { rows: blitzSymbols.map(symbol => ({ symbol })) };
                return { rows: [] };
            });
            axios.get.mockResolvedValue({ data: alpacaPositions });
        }

        test('a real Alpaca fill for a Blitz-held symbol is NOT flagged SHADOW (Blitz already tracks it correctly)', async () => {
            setup({
                dbHoldings: [],
                alpacaPositions: [{ symbol: 'META', qty: '1', asset_class: 'us_equity', avg_entry_price: '747.21' }],
                blitzSymbols: ['META'],
            });
            const result = await reconcilePositions(userId);
            expect(result.shadows).toEqual([]);
        });

        test('a genuinely-untracked (non-Blitz) symbol is still caught as SHADOW', async () => {
            setup({
                dbHoldings: [],
                alpacaPositions: [{ symbol: 'IOVA', qty: '57', asset_class: 'us_equity', avg_entry_price: '10' }],
                blitzSymbols: ['META'],
            });
            const result = await reconcilePositions(userId);
            expect(result.shadows).toEqual(['IOVA']);
        });

        test('a swing holding on a symbol Blitz never touched is compared normally (PHANTOM still fires)', async () => {
            setup({
                dbHoldings: [{ symbol: 'AAPL', quantity: '10', average_price: '150' }],
                alpacaPositions: [],
                blitzSymbols: [],
            });
            const result = await reconcilePositions(userId);
            expect(result.phantoms).toEqual(['AAPL']);
        });

        test('crypto and Blitz exclusions compose - neither interferes with the other', async () => {
            setup({
                dbHoldings: [],
                alpacaPositions: [
                    { symbol: 'META', qty: '1', asset_class: 'us_equity' },
                    { symbol: 'BTCUSD', qty: '0.01', asset_class: 'crypto' },
                    { symbol: 'IOVA', qty: '57', asset_class: 'us_equity' },
                ],
                blitzSymbols: ['META'],
            });
            const result = await reconcilePositions(userId);
            expect(result.shadows).toEqual(['IOVA']);
        });

        test('a failure loading Blitz symbols fails open - reconciliation still runs (not blocked)', async () => {
            query.mockImplementation(async (sql) => {
                if (/FROM holdings/.test(sql)) return { rows: [] };
                if (/intraday_positions|intraday_trades/.test(sql)) throw new Error('db hiccup');
                return { rows: [] };
            });
            axios.get.mockResolvedValue({ data: [{ symbol: 'IOVA', qty: '57', asset_class: 'us_equity' }] });
            const result = await reconcilePositions(userId);
            expect(result.ok).toBe(true);
            expect(result.shadows).toEqual(['IOVA']);
        });
    });

    describe('reconcileFillHistory', () => {
        test('a real fill for a Blitz-managed symbol is never reported as missing', async () => {
            query.mockImplementation(async (sql) => {
                if (/intraday_positions|intraday_trades/.test(sql)) return { rows: [{ symbol: 'META' }] };
                return { rows: [] };
            });
            axios.get.mockImplementation((url) => url.includes('/orders')
                ? Promise.resolve({ data: [{ symbol: 'META', side: 'sell', filled_qty: '1', filled_avg_price: '706.71', filled_at: '2026-09-21T15:01:33.578448Z', id: 'ord-1' }] })
                : Promise.resolve({ data: [] }));

            const result = await reconcileFillHistory(userId);
            expect(result.missing).toEqual([]);
        });

        test('a real fill for a non-Blitz symbol is still reported as missing', async () => {
            query.mockImplementation(async (sql) => {
                if (/intraday_positions|intraday_trades/.test(sql)) return { rows: [{ symbol: 'META' }] };
                return { rows: [] };
            });
            axios.get.mockImplementation((url) => url.includes('/orders')
                ? Promise.resolve({ data: [{ symbol: 'SOXL', side: 'sell', filled_qty: '9', filled_avg_price: '121.70', filled_at: '2026-09-11T19:28:46.000Z', id: 'ord-2' }] })
                : Promise.resolve({ data: [] }));

            const result = await reconcileFillHistory(userId);
            expect(result.missing).toEqual(['SOXL SELL 9@$121.70 (2026-09-11T19:28:46.000Z)']);
        });
    });
});
