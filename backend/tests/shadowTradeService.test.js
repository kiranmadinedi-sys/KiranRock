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
jest.mock('../src/services/tradeForwardTrackingService', () => ({
    getActualBuyAttribution: jest.fn(),
}));

const tradeForwardTrackingService = require('../src/services/tradeForwardTrackingService');
const shadowTradeService = require('../src/services/shadowTradeService');

describe('shadowTradeService — Gate Alpha Attribution', () => {
    beforeEach(() => {
        query.mockClear();
        query.mockResolvedValue({ rows: [] });
        tradeForwardTrackingService.getActualBuyAttribution.mockClear();
    });

    describe('getGateAlphaAttribution', () => {
        test('combines actual-BUY and per-gate rejected data into one object, not gated on closed_at', async () => {
            tradeForwardTrackingService.getActualBuyAttribution.mockResolvedValue({
                n: 10, n_5d: 10, n_10d: 6, n_20d: 2,
                avg_return_5d_pct: '1.5', avg_return_10d_pct: '2.5', avg_return_20d_pct: '3.5', would_have_won: 7,
            });
            query.mockImplementation((sql) => {
                if (sql.includes('FROM shadow_trades')) {
                    // getRejectedAttributionProgressive's query must NOT filter on closed_at —
                    // that's the whole point of the 2026-09-08 revision.
                    expect(sql).not.toMatch(/closed_at IS NOT NULL/);
                    return Promise.resolve({
                        rows: [{
                            rejection_reason: 'sector_count_cap', n: 20, n_5d: 20, n_10d: 15, n_20d: 3,
                            avg_mfe_pct: '5', avg_mae_pct: '-3',
                            avg_return_5d_pct: '0.5', avg_return_10d_pct: '1.0', avg_return_20d_pct: '1.5',
                            would_have_won: 12,
                        }],
                    });
                }
                return Promise.resolve({ rows: [] });
            });

            const result = await shadowTradeService.getGateAlphaAttribution({ days: 90 });

            expect(result.actualBuy.n).toBe(10);
            expect(result.rejectedByGate).toHaveLength(1);
            expect(result.rejectedByGate[0].rejection_reason).toBe('sector_count_cap');
        });
    });

    describe('formatGateAlphaAttribution', () => {
        test('renders Actual BUY and each gate with maturity-labeled checkpoints', () => {
            const data = {
                actualBuy: { n: 10, n_5d: 10, n_10d: 10, n_20d: 10, avg_return_5d_pct: '1.50', avg_return_10d_pct: '2.50', avg_return_20d_pct: '3.50', would_have_won: 7 },
                rejectedByGate: [
                    { rejection_reason: 'correlation', n: 5, n_5d: 5, n_10d: 5, n_20d: 5, avg_return_5d_pct: '-0.5', avg_return_10d_pct: '-1.0', avg_return_20d_pct: '-2.0', would_have_won: 1 },
                    { rejection_reason: 'sector_count_cap', n: 20, n_5d: 20, n_10d: 20, n_20d: 20, avg_return_5d_pct: '0.5', avg_return_10d_pct: '1.0', avg_return_20d_pct: '1.5', would_have_won: 12 },
                ],
            };

            const message = shadowTradeService.formatGateAlphaAttribution(data, 90);

            expect(message).toContain('Gate Alpha Attribution');
            expect(message).toContain('Actual BUY');
            expect(message).toContain('+1.50% 5D (preliminary, n=10)');
            expect(message).toContain('+2.50% 10D (accumulating, n=10)');
            expect(message).toContain('+3.50% 20D (maturing, n=10)');
            expect(message).toContain('Rejected — correlation');
            expect(message).toContain('Rejected — sector_count_cap');
            expect(message).toContain('-0.5% 5D'); // negative sign preserved, not double-prefixed
        });

        test('computes Gate Value as rejected-minus-ActualBUY per checkpoint', () => {
            const data = {
                actualBuy: { n: 10, n_5d: 10, n_10d: 0, n_20d: 0, avg_return_5d_pct: '2.0', avg_return_10d_pct: null, avg_return_20d_pct: null },
                rejectedByGate: [
                    { rejection_reason: 'sector_count_cap', n: 8, n_5d: 8, n_10d: 0, n_20d: 0, avg_return_5d_pct: '3.1', avg_return_10d_pct: null, avg_return_20d_pct: null, would_have_won: 5 },
                ],
            };
            const message = shadowTradeService.formatGateAlphaAttribution(data, 90);
            // 3.1 - 2.0 = +1.1pp -- sector cap's rejects outperformed what was bought
            expect(message).toContain('Gate Value vs Actual BUY: +1.1pp 5D');
        });

        test('omits the Gate Value line when the two sides do not share a matured checkpoint', () => {
            const data = {
                actualBuy: { n: 10, n_5d: 0, n_10d: 0, n_20d: 10, avg_return_5d_pct: null, avg_return_10d_pct: null, avg_return_20d_pct: '2.0' },
                rejectedByGate: [
                    { rejection_reason: 'correlation', n: 8, n_5d: 8, n_10d: 0, n_20d: 0, avg_return_5d_pct: '1.0', avg_return_10d_pct: null, avg_return_20d_pct: null, would_have_won: 3 },
                ],
            };
            const message = shadowTradeService.formatGateAlphaAttribution(data, 90);
            expect(message).not.toContain('Gate Value vs Actual BUY');
        });

        test('handles an empty actual-BUY population without throwing', () => {
            const data = { actualBuy: { n: 0, n_5d: 0, n_10d: 0, n_20d: 0 }, rejectedByGate: [] };
            const message = shadowTradeService.formatGateAlphaAttribution(data, 90);
            expect(message).toContain('insufficient sample');
            expect(message).toContain('No rejected candidates tracked yet');
        });

        test('omits a checkpoint entirely (rather than showing null/n-a) when it has zero observations', () => {
            const data = {
                actualBuy: { n: 3, n_5d: 0, n_10d: 3, n_20d: 0, avg_return_5d_pct: null, avg_return_10d_pct: '1.0', avg_return_20d_pct: null, would_have_won: 2 },
                rejectedByGate: [],
            };
            const message = shadowTradeService.formatGateAlphaAttribution(data, 90);
            expect(message).toContain('+1.0% 10D (accumulating, n=3)');
            expect(message).not.toContain('5D');
            expect(message).not.toContain('20D');
        });
    });

    describe('SHADOW_TRADE_MIN_SCORE threshold (regression guard)', () => {
        test('recordShadowTrade still works unchanged after the enhancedAITradingBot threshold was lowered', async () => {
            const opportunity = { symbol: 'DELL', entry: 520, aiScore: 70, sector: 'Technology', setupFamily: 'news_momentum', regime: 'BULL' };
            await shadowTradeService.recordShadowTrade(opportunity, 'user-1', 'sector_count_cap', 'Technology: 1/1');

            const insertCall = query.mock.calls.find(c => c[0].includes('INSERT INTO shadow_trades'));
            expect(insertCall).toBeDefined();
            expect(insertCall[1][0]).toBe('DELL');
            expect(insertCall[1][5]).toBe(70); // ai_score passed through unchanged regardless of the caller's threshold
        });
    });
});
