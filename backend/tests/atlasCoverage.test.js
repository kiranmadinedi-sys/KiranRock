/** ATLAS: ETF stand-ins via Alpaca + neutral when under half the weight is present (2026-11-05). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../src/connectors/globalMarketConnector', () => ({ fetchGlobalQuotes: jest.fn() }));

const connector = require('../src/connectors/globalMarketConnector');
const atlas = require('../src/services/globalSentimentService');

const q = (changePercent, price = 100) => ({ price, changePercent });

describe('ATLAS composite', () => {
    beforeEach(() => atlas.invalidateCache());

    test('only VIX + oil/gold (20% of weight) stays NEUTRAL instead of BEARISH', async () => {
        // The 11-04 case: VIX 17.3, oil -1.8% from FRED, everything else missing.
        connector.fetchGlobalQuotes.mockResolvedValue({
            '^VIX': { price: 17.3, changePercent: null }, 'CL=F': q(-1.79), 'GC=F': q(0.5),
        });
        const r = await atlas.getGlobalSentiment();
        expect(r.label).toBe('NEUTRAL');
        expect(r.baseAdj).toBe(0);
    });

    test('a broad global sell-off with full coverage reads bearish', async () => {
        connector.fetchGlobalQuotes.mockResolvedValue({
            '^N225': q(-5.9), '^HSI': q(-0.9), '^BSESN': q(0.1), '^AXJO': q(-1.9),
            '^GDAXI': q(-1.7), '^FTSE': q(-2.1), 'DX=F': q(0.07),
            'CL=F': q(1.9), 'GC=F': q(0.8), 'ES=F': q(-4.7), 'NQ=F': q(-6.3),
            '^VIX': { price: 16.6, changePercent: null },
        });
        const r = await atlas.getGlobalSentiment();
        expect(r.baseAdj).toBeLessThan(0);
    });
});
