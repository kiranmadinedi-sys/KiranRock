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
        test('combines actual-BUY and per-gate rejected data into one object', async () => {
            tradeForwardTrackingService.getActualBuyAttribution.mockResolvedValue({
                n: 10, avg_return_5d_pct: '1.5', avg_return_10d_pct: '2.5', avg_return_20d_pct: '3.5', would_have_won: 7,
            });
            query.mockImplementation((sql) => {
                if (sql.includes('FROM shadow_trades')) {
                    return Promise.resolve({
                        rows: [{
                            rejection_reason: 'sector_count_cap', n: 20,
                            avg_mfe_pct: '5', avg_mae_pct: '-3',
                            avg_return_5d_pct: '0.5', avg_return_10d_pct: '1.0', avg_return_20d_pct: '1.5',
                            would_have_won: 12, missed_upside_pct: '10.0', avoided_downside_pct: '4.0',
                        }],
                    });
                }
                return Promise.resolve({ rows: [] });
            });

            const result = await shadowTradeService.getGateAlphaAttribution({ days: 90 });

            expect(result.actualBuy.n).toBe(10);
            expect(result.rejectedByGate).toHaveLength(1);
            expect(result.rejectedByGate[0].rejection_reason).toBe('sector_count_cap');
            // net_gate_value_pct still computed correctly on the merged path
            expect(result.rejectedByGate[0].net_gate_value_pct).toBeCloseTo(-6.0, 5);
        });
    });

    describe('formatGateAlphaAttribution', () => {
        test('renders Actual BUY and each gate on its own line in the requested format', () => {
            const data = {
                actualBuy: { n: 10, avg_return_5d_pct: '1.50', avg_return_10d_pct: '2.50', avg_return_20d_pct: '3.50', would_have_won: 7 },
                rejectedByGate: [
                    { rejection_reason: 'correlation', n: 5, avg_return_5d_pct: '-0.5', avg_return_10d_pct: '-1.0', avg_return_20d_pct: '-2.0', would_have_won: 1 },
                    { rejection_reason: 'sector_count_cap', n: 20, avg_return_5d_pct: '0.5', avg_return_10d_pct: '1.0', avg_return_20d_pct: '1.5', would_have_won: 12 },
                ],
            };

            const message = shadowTradeService.formatGateAlphaAttribution(data, 90);

            expect(message).toContain('Gate Alpha Attribution');
            expect(message).toContain('Actual BUY');
            expect(message).toContain('+1.50% 5D');
            expect(message).toContain('+2.50% 10D');
            expect(message).toContain('+3.50% 20D');
            expect(message).toContain('Rejected — correlation');
            expect(message).toContain('Rejected — sector_count_cap');
            expect(message).toContain('-0.5% 5D'); // negative sign preserved, not double-prefixed
        });

        test('handles an empty actual-BUY population without throwing', () => {
            const data = { actualBuy: { n: 0 }, rejectedByGate: [] };
            const message = shadowTradeService.formatGateAlphaAttribution(data, 90);
            expect(message).toContain('not enough fully-tracked trades yet');
            expect(message).toContain('No fully-tracked rejected candidates yet');
        });

        test('formats a null return checkpoint as n/a rather than crashing', () => {
            const data = {
                actualBuy: { n: 3, avg_return_5d_pct: null, avg_return_10d_pct: '1.0', avg_return_20d_pct: '2.0', would_have_won: 2 },
                rejectedByGate: [],
            };
            const message = shadowTradeService.formatGateAlphaAttribution(data, 90);
            expect(message).toContain('n/a 5D');
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
