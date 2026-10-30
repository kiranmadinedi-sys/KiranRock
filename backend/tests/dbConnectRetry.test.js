/** DB connect-timeout retry (2026-10-29): a stalled connect is retried; real query errors are not. */
const db = require('../src/config/database');
const timeoutErr = () => new Error('timeout exceeded when trying to connect');

beforeEach(() => db._setConnectRetryDelays([1, 1]));
afterEach(() => jest.restoreAllMocks());
afterAll(() => db.pool.end().catch(() => {}));

test('connect timeout is retried and the query then succeeds', async () => {
    const spy = jest.spyOn(db.pool, 'query')
        .mockRejectedValueOnce(timeoutErr())
        .mockResolvedValueOnce({ rows: [{ ok: 1 }] });
    const res = await db.query('SELECT 1', []);
    expect(res.rows[0].ok).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);
});

test('gives up after the retries and throws the original error', async () => {
    const spy = jest.spyOn(db.pool, 'query').mockRejectedValue(timeoutErr());
    await expect(db.query('SELECT 1', [])).rejects.toThrow('timeout exceeded');
    expect(spy).toHaveBeenCalledTimes(3);
});

test('a real query error (e.g. bad SQL) is not retried', async () => {
    const spy = jest.spyOn(db.pool, 'query').mockRejectedValue(new Error('column "x" does not exist'));
    await expect(db.query('SELECT x', [])).rejects.toThrow('does not exist');
    expect(spy).toHaveBeenCalledTimes(1);
});
