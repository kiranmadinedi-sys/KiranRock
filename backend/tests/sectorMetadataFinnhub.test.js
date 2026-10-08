jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

/**
 * 2026-10-08: 1,821 of 2,630 scan rows had sector 'Unknown' (the quote feed carries no
 * sector), and Yahoo-style names in the learned cache didn't match the static map's names.
 */
describe('sector resolution — Finnhub mapping and canonical names', () => {
    // learnSector() never writes the real cache under Jest (NODE_ENV=test guard in the service).
    const sm = require('../src/services/sectorMetadataService');

    test('Finnhub industries map to the canonical sectors (as seen live)', () => {
        expect(sm.mapFinnhubIndustry('Semiconductors')).toBe('Technology');            // LRCX
        expect(sm.mapFinnhubIndustry('Building')).toBe('Industrials');                 // AAON
        expect(sm.mapFinnhubIndustry('Retail')).toBe('Consumer Discretionary');        // AAP
        expect(sm.mapFinnhubIndustry('Metals & Mining')).toBe('Materials');            // SCCO
        expect(sm.mapFinnhubIndustry('Real Estate')).toBe('Real Estate');              // LXP
        expect(sm.mapFinnhubIndustry('Hotels, Restaurants & Leisure')).toBe('Consumer Discretionary'); // CAKE
        expect(sm.mapFinnhubIndustry('Communications')).toBe('Technology');            // NOK, AAOI
        expect(sm.mapFinnhubIndustry('Banking')).toBe('Financials');
        expect(sm.mapFinnhubIndustry('')).toBeNull();
        expect(sm.mapFinnhubIndustry('Something New')).toBeNull();
    });

    test('Yahoo-style names collapse onto the static map\'s names', () => {
        expect(sm.canonicalSector('Financial Services')).toBe('Financials');
        expect(sm.canonicalSector('Consumer Defensive')).toBe('Consumer Staples');
        expect(sm.canonicalSector('Consumer Cyclical')).toBe('Consumer Discretionary');
        expect(sm.canonicalSector('Basic Materials')).toBe('Materials');
        expect(sm.canonicalSector('Technology')).toBe('Technology');
    });

    test('a live quote sector is returned in canonical form', () => {
        expect(sm.resolveSector('ZZTESTA', 'Financial Services')).toBe('Financials');
        expect(sm.knownSector('ZZTESTA')).toBe('Financials'); // and learned
    });

    test('lookupSectorFromFinnhub maps the profile industry', async () => {
        process.env.FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || 'test';
        const axios = { get: jest.fn().mockResolvedValue({ data: { finnhubIndustry: 'Semiconductors', name: 'Lam Research' } }) };
        await expect(sm.lookupSectorFromFinnhub('lrcx', { axios })).resolves.toEqual({ sector: 'Technology', industry: 'Semiconductors' });
        expect(axios.get.mock.calls[0][1].params.symbol).toBe('LRCX');
    });
});
