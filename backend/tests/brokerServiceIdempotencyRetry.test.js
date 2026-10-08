jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('@alpacahq/alpaca-trade-api', () => jest.fn().mockImplementation(() => ({})));

/**
 * 2026-10-07: a FAILED/REJECTED order attempt left its CREATED claim in place, so one broker
 * rejection blocked every retry for the rest of the day (paper NVDA exit: rejected at 08:35,
 * then "Duplicate order blocked" every 30 minutes). Retries are now allowed under a
 * numbered key only when no attempt ever reached the broker.
 */
describe('claimIdempotencyKey — retry after a pre-broker failure, never a real duplicate', () => {
    let claim, query, auditRows;
    const KEY = 'NVDA:2026-10-07:u1:sell:Slow mover: 5d held';
    const minsAgo = m => new Date(Date.now() - m * 60000).toISOString();

    beforeEach(() => {
        jest.resetModules();
        auditRows = [];
        jest.doMock('../src/config/database', () => ({
            query: jest.fn(async (sql, params) => {
                if (/INSERT INTO order_audit_log/.test(sql)) {
                    if (auditRows.some(r => r.idempotency_key === params[0] && r.state === 'CREATED')) {
                        const e = new Error('duplicate key value violates unique constraint "idx_order_audit_created_once"');
                        e.code = '23505';
                        throw e;
                    }
                    auditRows.push({ idempotency_key: params[0], state: 'CREATED', created_at: new Date().toISOString() });
                    return { rows: [] };
                }
                if (/SELECT idempotency_key, state, created_at FROM order_audit_log/.test(sql)) {
                    const prefix = params[1].replace('%', '');
                    return { rows: auditRows.filter(r => r.idempotency_key === params[0] || r.idempotency_key.startsWith(prefix)) };
                }
                return { rows: [] };
            }),
        }));
        ({ claimIdempotencyKey: claim } = require('../src/services/brokerService'));
        query = require('../src/config/database').query;
    });

    test('first claim gets the base key', async () => {
        expect(await claim(KEY, 'u1', 'NVDA')).toBe(KEY);
    });

    test('a concurrent duplicate while the first attempt is in flight is still blocked (2026-08-07 protection)', async () => {
        await claim(KEY, 'u1', 'NVDA');
        expect(await claim(KEY, 'u1', 'NVDA')).toBeNull();
    });

    test('after a broker rejection (FAILED, never submitted) a retry gets a numbered key', async () => {
        await claim(KEY, 'u1', 'NVDA');
        auditRows.push({ idempotency_key: KEY, state: 'FAILED', created_at: new Date().toISOString() });
        expect(await claim(KEY, 'u1', 'NVDA')).toBe(`${KEY}#retry1`);
    });

    test('a second failure allows #retry2, and the retry key itself blocks concurrent duplicates', async () => {
        await claim(KEY, 'u1', 'NVDA');
        auditRows.push({ idempotency_key: KEY, state: 'FAILED', created_at: new Date().toISOString() });
        const r1 = await claim(KEY, 'u1', 'NVDA');
        expect(await claim(KEY, 'u1', 'NVDA')).toBeNull(); // r1 is in flight
        auditRows.push({ idempotency_key: r1, state: 'REJECTED', created_at: new Date().toISOString() });
        expect(await claim(KEY, 'u1', 'NVDA')).toBe(`${KEY}#retry2`);
    });

    test('an attempt that reached the broker (SUBMITTED) blocks all retries — no double order', async () => {
        await claim(KEY, 'u1', 'NVDA');
        auditRows.push({ idempotency_key: KEY, state: 'SUBMITTED', created_at: new Date().toISOString() });
        expect(await claim(KEY, 'u1', 'NVDA')).toBeNull();
    });

    test('a crashed attempt (CREATED, no outcome) can be retried only after 2 minutes', async () => {
        auditRows.push({ idempotency_key: KEY, state: 'CREATED', created_at: minsAgo(1) });
        expect(await claim(KEY, 'u1', 'NVDA')).toBeNull();
        auditRows[0].created_at = minsAgo(3);
        expect(await claim(KEY, 'u1', 'NVDA')).toBe(`${KEY}#retry1`);
    });

    test('retries stop after the limit', async () => {
        auditRows.push({ idempotency_key: KEY, state: 'CREATED', created_at: minsAgo(30) }, { idempotency_key: KEY, state: 'FAILED', created_at: minsAgo(30) });
        for (let i = 1; i <= 5; i++) auditRows.push({ idempotency_key: `${KEY}#retry${i}`, state: 'CREATED', created_at: minsAgo(30 - i) }, { idempotency_key: `${KEY}#retry${i}`, state: 'FAILED', created_at: minsAgo(30 - i) });
        expect(await claim(KEY, 'u1', 'NVDA')).toBeNull();
    });
});
