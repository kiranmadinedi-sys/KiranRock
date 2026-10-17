/** Research archive (2026-10-17): all-ticker news + insider trades, storage only. */
describe('researchArchiveService', () => {
    let ra, query, axios;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));
        jest.doMock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
        jest.doMock('axios', () => ({ get: jest.fn() }));
        ra = require('../src/services/researchArchiveService');
        query = require('../src/config/database').query;
        axios = require('axios');
        process.env.FINNHUB_API_KEY = 'k';
    });

    const inserts = re => query.mock.calls.filter(c => re.test(c[0]));

    test('news pages are stored with upper-cased symbols until there is no next page', async () => {
        axios.get
            .mockResolvedValueOnce({ data: { news: [{ id: 1, created_at: '2026-10-13T12:00:00Z', headline: 'PBOC clears Visa', symbols: ['v'] }], next_page_token: 't2' } })
            .mockResolvedValueOnce({ data: { news: [{ id: 2, created_at: '2026-10-13T13:00:00Z', headline: 'MA too', symbols: ['MA', 'V'] }], next_page_token: null } });
        await ra.fetchNews('2026-10-13T00:00:00Z', '2026-10-14T00:00:00Z');
        const ins = inserts(/INSERT INTO news_archive/);
        expect(ins).toHaveLength(2);
        expect(ins[0][1]).toContainEqual(['V']);
        expect(axios.get.mock.calls[1][1].params.page_token).toBe('t2');
    });

    test('incremental sync restarts an hour before the newest stored article', async () => {
        query.mockImplementation(sql => Promise.resolve(/MAX\(created_at\)/.test(sql)
            ? { rows: [{ m: '2026-10-17T10:00:00Z' }] } : { rows: [], rowCount: 0 }));
        axios.get.mockResolvedValue({ data: { news: [], next_page_token: null } });
        await ra.syncRecentNews(new Date('2026-10-17T12:00:00Z'));
        expect(axios.get.mock.calls[0][1].params.start).toBe('2026-10-17T09:00:00.000Z');
    });

    test('incremental sync never reaches back more than 2 days (backfill in progress)', async () => {
        query.mockImplementation(sql => Promise.resolve(/MAX\(created_at\)/.test(sql)
            ? { rows: [{ m: '2023-01-26T17:00:00Z' }] } : { rows: [], rowCount: 0 }));
        axios.get.mockResolvedValue({ data: { news: [], next_page_token: null } });
        await ra.syncRecentNews(new Date('2026-10-17T12:00:00Z'));
        expect(axios.get.mock.calls[0][1].params.start).toBe('2026-10-15T12:00:00.000Z');
    });

    test('insider sweep stores each symbol\'s Form 4 rows and survives a failing symbol', async () => {
        process.env.FINNHUB_SWEEP_PER_MIN = '100000'; // no waiting in tests
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [], rowCount: 1 }) }));
        jest.doMock('axios', () => ({ get: jest.fn() }));
        ra = require('../src/services/researchArchiveService');
        query = require('../src/config/database').query;
        axios = require('axios');
        axios.get
            .mockResolvedValueOnce({ data: { data: [{ id: 'f1', name: 'CEO', transactionDate: '2026-10-01', transactionCode: 'P', change: 1000, share: 5000, transactionPrice: 390 }] } })
            .mockRejectedValueOnce(new Error('timeout'));
        const r = await ra.sweepInsiders(['V', 'MA'], { from: '2026-08-01' });
        expect(r).toMatchObject({ symbols: 2, failed: 1 });
        const ins = inserts(/INSERT INTO insider_transactions/);
        expect(ins[0][1].slice(0, 6)).toEqual(['V', 'f1', 'CEO', '2026-10-01', null, 'P']);
        delete process.env.FINNHUB_SWEEP_PER_MIN;
    });
});
