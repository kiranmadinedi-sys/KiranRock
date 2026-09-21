jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/redisStateService', () => ({
    setDataStale: jest.fn().mockResolvedValue(), clearDataStale: jest.fn().mockResolvedValue(),
}));
jest.mock('../src/services/userDatabaseService', () => ({}));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { query } = require('../src/config/database');
const redis = require('../src/services/redisStateService');
const { stageATLAS } = require('../src/services/istPipelineScheduler');

/**
 * 2026-09-20: ATLAS used to re-ingest via a Yahoo call that no longer exists, fail on
 * every symbol, and still report success. It now checks daily_bars freshness directly.
 */
describe('IST stageATLAS — daily_bars freshness', () => {
    beforeEach(() => jest.clearAllMocks());
    const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

    test('fresh bars (weekend-old) -> ok, clears DATA_STALE', async () => {
        query.mockResolvedValue({ rows: [{ latest: daysAgo(2), symbols: 3924 }] });
        const r = await stageATLAS([]);
        expect(r.ok).toBe(true);
        expect(redis.clearDataStale).toHaveBeenCalledWith('atlas');
        expect(redis.setDataStale).not.toHaveBeenCalled();
    });

    test('stale bars -> fails and sets DATA_STALE', async () => {
        query.mockResolvedValue({ rows: [{ latest: daysAgo(9), symbols: 3924 }] });
        const r = await stageATLAS([]);
        expect(r.ok).toBe(false);
        expect(redis.setDataStale).toHaveBeenCalledWith('atlas');
    });

    test('empty table -> fails and sets DATA_STALE', async () => {
        query.mockResolvedValue({ rows: [{ latest: null, symbols: 0 }] });
        const r = await stageATLAS([]);
        expect(r.ok).toBe(false);
        expect(redis.setDataStale).toHaveBeenCalledWith('atlas');
    });

    test('DB error -> fails and sets DATA_STALE', async () => {
        query.mockRejectedValue(new Error('db down'));
        const r = await stageATLAS([]);
        expect(r.ok).toBe(false);
        expect(redis.setDataStale).toHaveBeenCalledWith('atlas');
    });
});
