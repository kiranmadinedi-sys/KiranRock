jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/**
 * 2026-09-29, ahead of turning the options bot on for the "user" paper account:
 * getOptionsChain and getQuote/getBars/searchSymbols used to share ONE Yahoo
 * circuit breaker. Both run inside the same PM2 process (kiranrock-worker) as the
 * swing bot and nightly scan, so a burst of options-chain rate-limit failures
 * could trip the shared breaker and fail-fast the swing bot's own Yahoo fallback
 * for 60s at a time — exactly the failure shape that caused the Aug 18-20 outage
 * the breaker was built to prevent, just from a new direction. Split into two
 * independent breakers (options vs general) so neither can affect the other, and
 * gave the options breaker a longer cooldown since its Yahoo cadence is sparse
 * enough that fast recovery doesn't matter.
 */
describe('dataProvider — isolated Yahoo circuit breakers (options vs general)', () => {
    let mockOptions, mockQuote, mockChart, mockSearch;
    let dataProvider;

    const networkError = () => new Error('ETIMEDOUT');

    beforeEach(() => {
        jest.resetModules();
        jest.useRealTimers();
        process.env.DATA_PROVIDER = 'yahoo';
        delete process.env.POLYGON_API_KEY;

        mockOptions = jest.fn();
        mockQuote = jest.fn();
        mockChart = jest.fn();
        mockSearch = jest.fn();

        jest.doMock('yahoo-finance2', () => ({
            default: jest.fn().mockImplementation(() => ({
                options: mockOptions,
                quote: mockQuote,
                chart: mockChart,
                search: mockSearch,
            })),
        }));

        dataProvider = require('../src/services/dataProvider');
    });

    test('5 consecutive options-chain failures trip ONLY the options breaker — getQuote unaffected', async () => {
        mockOptions.mockRejectedValue(networkError());

        for (let i = 0; i < 5; i++) {
            const result = await dataProvider.getOptionsChain('AAPL');
            expect(result).toBeNull(); // yahooProvider.getOptionsChain swallows errors, returns null
        }

        // Options breaker should now be open: a 6th call fails fast, no real network attempt.
        mockOptions.mockClear();
        const afterTrip = await dataProvider.getOptionsChain('AAPL');
        expect(afterTrip).toBeNull();
        expect(mockOptions).not.toHaveBeenCalled();

        // getQuote must be completely unaffected by the options breaker tripping.
        mockQuote.mockResolvedValue({ regularMarketPrice: 150 });
        const quote = await dataProvider.getQuote('AAPL');
        expect(quote.price).toBe(150);
        expect(mockQuote).toHaveBeenCalledTimes(1);
    });

    test('5 consecutive getQuote failures trip ONLY the general breaker — getOptionsChain unaffected', async () => {
        mockQuote.mockRejectedValue(networkError());

        for (let i = 0; i < 5; i++) {
            await expect(dataProvider.getQuote('AAPL')).rejects.toThrow();
        }

        mockQuote.mockClear();
        await expect(dataProvider.getQuote('AAPL')).rejects.toThrow(/circuit breaker open/);
        expect(mockQuote).not.toHaveBeenCalled();

        // getOptionsChain must be completely unaffected by the general breaker tripping.
        mockOptions.mockResolvedValue({ expirationDates: ['2026-10-17'] });
        const chain = await dataProvider.getOptionsChain('AAPL');
        expect(chain).toEqual({ expirationDates: ['2026-10-17'] });
        expect(mockOptions).toHaveBeenCalledTimes(1);
    });

    test('the options breaker cooldown outlasts the general breaker cooldown', async () => {
        jest.useFakeTimers();

        mockOptions.mockRejectedValue(networkError());
        mockQuote.mockRejectedValue(networkError());

        for (let i = 0; i < 5; i++) {
            await dataProvider.getOptionsChain('AAPL');
            await expect(dataProvider.getQuote('AAPL')).rejects.toThrow();
        }

        // Advance 61s: the general breaker's 60s cooldown has elapsed, options' 5-min has not.
        jest.advanceTimersByTime(61 * 1000);

        mockQuote.mockClear();
        mockQuote.mockResolvedValue({ regularMarketPrice: 200 });
        const quote = await dataProvider.getQuote('AAPL'); // general breaker closed again -> live probe
        expect(quote.price).toBe(200);
        expect(mockQuote).toHaveBeenCalledTimes(1);

        mockOptions.mockClear();
        const chain = await dataProvider.getOptionsChain('AAPL'); // options breaker still open -> fail-fast
        expect(chain).toBeNull();
        expect(mockOptions).not.toHaveBeenCalled();

        jest.useRealTimers();
    });
});
