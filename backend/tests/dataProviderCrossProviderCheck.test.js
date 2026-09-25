jest.mock('axios');
jest.mock('@alpacahq/alpaca-trade-api');
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

process.env.POLYGON_API_KEY = 'test-polygon-key';
// DATA_PROVIDER unset -> defaults to 'yahoo' -> activeProvider !== polygonProvider ->
// verifyPriceCrossProvider's secondary is polygonProvider, matching this file's mocks.
delete process.env.DATA_PROVIDER;

const axios = require('axios');
const dataProvider = require('../src/services/dataProvider');

/**
 * 2026-09-25, from a cross-validated ChatGPT review: "never execute a trade when
 * primary and fallback data sources materially disagree" is worth having as a real
 * safety principle on its own merits (the specific case that prompted it, NFLX at
 * $71, turned out to be correct on cross-check against Polygon directly — this
 * platform runs a fictional simulated market, so it will never match a real-world
 * price lookup, which is a different thing from this system's own two providers
 * disagreeing with each other). Wired into the swing bot's buy path as a pre-trade
 * gate; this file tests the check itself.
 */
describe('dataProvider.verifyPriceCrossProvider', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    function mockPolygonQuote(price) {
        axios.get.mockResolvedValue({
            data: { ticker: { lastTrade: { p: price }, day: { c: price, o: price }, prevDay: {} } },
        });
    }

    test('agrees when the secondary price is close to the primary', async () => {
        mockPolygonQuote(71.70); // primary 71.72, ~0.03% apart

        const result = await dataProvider.verifyPriceCrossProvider('NFLX', 71.72);

        expect(result.agree).toBe(true);
        expect(result.reason).toBe('agree');
        expect(result.secondaryPrice).toBe(71.70);
    });

    test('flags a material disagreement (default 3% threshold) and does not agree', async () => {
        mockPolygonQuote(50.00); // primary 71.72 -> ~30% apart

        const result = await dataProvider.verifyPriceCrossProvider('NFLX', 71.72);

        expect(result.agree).toBe(false);
        expect(result.reason).toBe('material_disagreement');
        expect(result.deviationPct).toBeCloseTo(0.4344, 3);
    });

    test('a custom tolerance threshold is respected', async () => {
        mockPolygonQuote(73.00); // primary 71.72 -> ~1.8% apart

        const tight = await dataProvider.verifyPriceCrossProvider('NFLX', 71.72, { toleranceThreshold: 0.01 });
        const loose = await dataProvider.verifyPriceCrossProvider('NFLX', 71.72, { toleranceThreshold: 0.05 });

        expect(tight.agree).toBe(false);
        expect(loose.agree).toBe(true);
    });

    test('fails OPEN when the secondary provider has no usable price', async () => {
        axios.get.mockResolvedValue({ data: { ticker: {} } }); // no lastTrade, no day.c -> price 0

        const result = await dataProvider.verifyPriceCrossProvider('OBSCURESYM', 12.34);

        expect(result.agree).toBe(true);
        expect(result.reason).toBe('secondary_unavailable');
    });

    test('fails OPEN when the secondary provider lookup throws', async () => {
        axios.get.mockRejectedValue(new Error('network error'));

        const result = await dataProvider.verifyPriceCrossProvider('NFLX', 71.72);

        expect(result.agree).toBe(true);
        expect(result.reason).toContain('secondary_lookup_failed');
    });

    test('rejects an invalid primary price outright, without even checking the secondary', async () => {
        const result = await dataProvider.verifyPriceCrossProvider('NFLX', NaN);

        expect(result.agree).toBe(false);
        expect(result.reason).toBe('invalid_primary_price');
        expect(axios.get).not.toHaveBeenCalled();
    });
});
