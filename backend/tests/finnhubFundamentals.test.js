/** CANSLIM fundamentals from Finnhub /stock/metric (2026-11-03). */
jest.mock('axios', () => ({ get: jest.fn() }));
const axios = require('axios');
const { fundamentalsSnapshot } = require('../src/utils/finnhubEarnings');

describe('fundamentalsSnapshot', () => {
    beforeEach(() => axios.get.mockReset());

    test('quarterly year-over-year as decimal fractions', async () => {
        // XEL on 2026-11-03
        axios.get.mockResolvedValue({ data: { metric: { epsGrowthQuarterlyYoy: 23.77, epsGrowthTTMYoy: 1.34, revenueGrowthQuarterlyYoy: -5.16, revenueGrowthTTMYoy: 4.73, grossMarginTTM: 40.43668, marketCapitalization: 47123.5 } } });
        const r = await fundamentalsSnapshot('XEL');
        expect(r.earningsGrowth).toBeCloseTo(0.2377);
        expect(r.revenueGrowth).toBeCloseTo(-0.0516);
        expect(r.grossMargins).toBeCloseTo(0.4044);
        expect(r.marketCap).toBe(47123500000);
    });

    test('falls back to trailing 12 months when the quarter is missing', async () => {
        axios.get.mockResolvedValue({ data: { metric: { epsGrowthTTMYoy: 11, revenueGrowthTTMYoy: 21.74 } } });
        const r = await fundamentalsSnapshot('AJG');
        expect(r.earningsGrowth).toBeCloseTo(0.11);
        expect(r.revenueGrowth).toBeCloseTo(0.2174);
        expect(r.grossMargins).toBeNull();
    });

    test('an ETF has no fundamentals; a bad response throws', async () => {
        axios.get.mockResolvedValue({ data: { metric: { '52WeekHigh': 700 } } });
        expect(await fundamentalsSnapshot('SPY')).toEqual({ earningsGrowth: null, revenueGrowth: null, grossMargins: null, marketCap: null });
        axios.get.mockResolvedValue({ data: {} });
        await expect(fundamentalsSnapshot('BAD')).rejects.toThrow(/bad Finnhub/);
    });
});
