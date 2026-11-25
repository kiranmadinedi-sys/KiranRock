/**
 * 2026-11-23 fixes:
 *  1. A weekend-built stock universe is not reused on a trading day, and the "scan complete"
 *     target falls back to the latest WEEKDAY build (not a fixed 420).
 *  2. The 15:45 ET cleanup cancels unfilled buys in every account and never journals an
 *     order that is still open at the broker as CANCELED.
 *  3. Before selling, wait until cancelled orders actually release the shares.
 */
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('stock universe cache — weekend list not reused on a trading day', () => {
    let ms;
    beforeEach(() => { jest.resetModules(); ms = require('../src/services/marketScreenerService'); });
    const builtAt = Date.parse('2026-11-23T03:30:00Z'); // Sunday 22:30 ET

    test('Sunday-built list is stale on Monday even within 24h', () => {
        ms._setCacheForTest({ list: [{ symbol: 'AAPL' }], builtAt, universeDate: '2026-11-22' });
        expect(ms._isCacheValid(builtAt + 10 * 3600e3, '2026-11-23')).toBe(false);
    });
    test('same-day and weekday→weekend reuse still allowed', () => {
        ms._setCacheForTest({ list: [{ symbol: 'AAPL' }], builtAt, universeDate: '2026-11-23' });
        expect(ms._isCacheValid(builtAt + 3600e3, '2026-11-23')).toBe(true);
        ms._setCacheForTest({ list: [{ symbol: 'AAPL' }], builtAt, universeDate: '2026-11-20' }); // Friday
        expect(ms._isCacheValid(builtAt + 3600e3, '2026-11-21')).toBe(true);                     // Saturday
    });
    test('holiday-built list is stale on the next trading day; 24h expiry unchanged', () => {
        ms._setCacheForTest({ list: [{ symbol: 'AAPL' }], builtAt, universeDate: '2026-11-26' }); // Thanksgiving
        expect(ms._isCacheValid(builtAt + 3600e3, '2026-11-27')).toBe(false);
        ms._setCacheForTest({ list: [{ symbol: 'AAPL' }], builtAt, universeDate: '2026-11-23' });
        expect(ms._isCacheValid(builtAt + 25 * 3600e3, '2026-11-23')).toBe(false);
    });
    test('scan target falls back to the latest weekday build when the date has none', async () => {
        const query = jest.fn(async (sql, params) => {
            if (/FROM hermes_build_status/.test(sql)) return { rows: [{ d: '2026-11-20' }] };
            return { rows: [{ n: params[0] === '2026-11-20' ? 2755 : 0 }] };
        });
        await expect(ms.getScanTargetSize('2026-11-23', { query })).resolves.toBe(2755);
        expect(query.mock.calls[1][0]).toMatch(/NOT IN \(0, 6\)/); // weekend builds excluded
    });
    test('a date with its own build uses it', async () => {
        const query = jest.fn(async () => ({ rows: [{ n: 2700 }] }));
        await expect(ms.getScanTargetSize('2026-11-24', { query })).resolves.toBe(2700);
        expect(query).toHaveBeenCalledTimes(1);
    });
});

describe('15:45 ET cleanup — every account, and no false CANCELED rows', () => {
    let brokerService, inserts, clients;
    beforeEach(() => {
        jest.resetModules();
        process.env.BROKER = 'alpaca';
        inserts = [];
        clients = {
            kPaper: {
                getOrders: jest.fn()
                    .mockResolvedValueOnce([
                        { id: 'p-buy', side: 'buy', type: 'limit', symbol: 'OMC' },
                        { id: 'p-stop', side: 'sell', type: 'stop', symbol: 'PII' },
                        { id: 'p-crypto', side: 'buy', type: 'limit', symbol: 'SOL/USD', asset_class: 'crypto' },
                    ])
                    .mockResolvedValueOnce([{ id: 'p-stop', status: 'new' }, { id: 'p-crypto', status: 'new' }]),
                cancelOrder: jest.fn(async () => {}),
            },
            kLive: {
                getOrders: jest.fn()
                    .mockResolvedValueOnce([{ id: 'l-buy', side: 'buy', type: 'limit', symbol: 'RHP' }])
                    .mockResolvedValueOnce([{ id: 'l-buy', status: 'pending_cancel' }]),
                cancelOrder: jest.fn(async () => {}),
            },
        };
        jest.doMock('@alpacahq/alpaca-trade-api', () => jest.fn().mockImplementation(({ keyId }) => clients[keyId]));
        jest.doMock('../src/services/userDatabaseService', () => ({
            getUserAlpacaCredentials: jest.fn(async (id) => ({ u1: { keyId: 'kPaper' }, u2: { keyId: 'kPaper' }, u3: { keyId: 'kLive' } }[id] && { ...({ u1: { keyId: 'kPaper' }, u2: { keyId: 'kPaper' }, u3: { keyId: 'kLive' } }[id]), secretKey: 's', isPaper: id !== 'u3' })),
        }));
        jest.doMock('../src/config/database', () => ({
            query: jest.fn(async (sql, params) => {
                if (/FROM users/.test(sql)) return { rows: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] };
                if (/DISTINCT ON \(idempotency_key\)/.test(sql)) return { rows: [
                    { idempotency_key: 'OMC:paper', user_id: 'u1', symbol: 'OMC', quantity: 5, broker_order_id: 'p-buy' },
                    { idempotency_key: 'RHP:live', user_id: 'u3', symbol: 'RHP', quantity: 1, broker_order_id: 'l-buy' },
                    { idempotency_key: 'SOL:paper', user_id: 'u1', symbol: 'SOL/USD', quantity: 1, broker_order_id: 'p-crypto' },
                ] };
                if (/INSERT INTO order_audit_log/.test(sql)) { inserts.push(params); return { rows: [] }; }
                return { rows: [] };
            }),
        }));
        brokerService = require('../src/services/brokerService');
    });

    test('sweeps each account once, cancels only buys, journals only what is really gone', async () => {
        const r = await brokerService.eodCancelPartialFills();
        expect(clients.kPaper.cancelOrder).toHaveBeenCalledTimes(1);        // u1 and u2 share keys → one sweep
        expect(clients.kPaper.cancelOrder).toHaveBeenCalledWith('p-buy');   // stop and crypto preserved
        expect(clients.kLive.cancelOrder).toHaveBeenCalledWith('l-buy');    // the live account is swept now
        expect(r.canceled).toBe(2);
        const journaledKeys = inserts.map(p => String(p[0]));
        expect(journaledKeys.some(k => k.startsWith('OMC:paper'))).toBe(true);
        expect(journaledKeys.some(k => k.startsWith('RHP:live'))).toBe(true);   // pending_cancel → going away
        expect(journaledKeys.some(k => k.startsWith('SOL:paper'))).toBe(false); // still open → not CANCELED
    });

    test('stale-order lookup judges each order by its LATEST row (filled sells are not CANCELED)', async () => {
        await brokerService.eodCancelPartialFills();
        const db = require('../src/config/database');
        const sql = db.query.mock.calls.map(c => c[0]).find(s => /DISTINCT ON \(idempotency_key\)/.test(s));
        // the pending-state filter must sit OUTSIDE the DISTINCT ON subquery
        const inner = sql.slice(sql.indexOf('DISTINCT ON'), sql.indexOf(') latest'));
        expect(inner).not.toMatch(/state IN/);
        expect(sql.slice(sql.indexOf(') latest'))).toMatch(/latest\.state IN \('SUBMITTED', 'PENDING_FILL', 'PARTIALLY_FILLED'\)/);
    });

    test('a failed cancel keeps the order out of the CANCELED journal', async () => {
        clients.kLive.cancelOrder.mockRejectedValue(new Error('order is not cancelable'));
        clients.kLive.getOrders.mockReset()
            .mockResolvedValueOnce([{ id: 'l-buy', side: 'buy', type: 'limit', symbol: 'RHP' }])
            .mockResolvedValueOnce([{ id: 'l-buy', status: 'new' }]);
        await brokerService.eodCancelPartialFills();
        expect(inserts.map(p => String(p[0])).some(k => k.startsWith('RHP:live'))).toBe(false);
    });
});

describe('sell — wait for cancelled orders to release the shares', () => {
    let brokerService;
    beforeEach(() => {
        jest.resetModules();
        process.env.BROKER = 'alpaca';
        jest.doMock('@alpacahq/alpaca-trade-api', () => jest.fn().mockImplementation(() => ({})));
        brokerService = require('../src/services/brokerService');
    });
    const sleep = jest.fn(async () => {});

    test('returns as soon as qty_available covers the sale', async () => {
        const axios = { get: jest.fn()
            .mockResolvedValueOnce({ data: { qty: '16', qty_available: '0' } })
            .mockResolvedValueOnce({ data: { qty: '16', qty_available: '16' } }) };
        await expect(brokerService.waitForSharesReleased('https://paper-api.alpaca.markets', {}, 'PHG', 16, { deps: { axios, sleep } })).resolves.toBe(true);
        expect(axios.get).toHaveBeenCalledTimes(2);
        expect(axios.get.mock.calls[0][0]).toBe('https://paper-api.alpaca.markets/v2/positions/PHG');
    });
    test('gives up after the time limit and lets the caller sell anyway', async () => {
        const axios = { get: jest.fn(async () => ({ data: { qty: '16', qty_available: '0' } })) };
        await expect(brokerService.waitForSharesReleased('x', {}, 'PHG', 16, { maxMs: 2000, stepMs: 500, deps: { axios, sleep } })).resolves.toBe(false);
        expect(axios.get).toHaveBeenCalledTimes(4);
    });
    test('recognises the held-shares rejection, not other errors', () => {
        expect(brokerService.isHeldQtyRejection({ response: { status: 403, data: { code: 40310000 } } })).toBe(true);
        expect(brokerService.isHeldQtyRejection(new Error('insufficient qty available for order'))).toBe(true);
        expect(brokerService.isHeldQtyRejection({ response: { status: 422, data: { message: 'invalid qty' } } })).toBe(false);
    });
});
