jest.mock('axios');
jest.mock('@alpacahq/alpaca-trade-api');
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/services/userDatabaseService', () => ({
    getUserAlpacaCredentials: jest.fn().mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true }),
}));
jest.mock('../src/services/tradingControlService', () => ({
    getGlobalTradingControl: jest.fn().mockResolvedValue({ globalTradingEnabled: true }),
    getUserTradingControls: jest.fn().mockResolvedValue({ aiTradingEnabled: true, botTradingEnabled: true }),
}));
jest.mock('../src/services/dataProvider', () => ({
    getQuote: jest.fn().mockResolvedValue({ price: 100, ask: 100.1, bid: 99.9 }),
}));
jest.mock('../src/services/tradingServiceDB', () => ({
    executeBuyOrder: jest.fn().mockResolvedValue({}),
    executeSellOrder: jest.fn().mockResolvedValue({}),
}));
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trade: jest.fn(), riskEvent: jest.fn() },
}));

const axios = require('axios');
const Alpaca = require('@alpacahq/alpaca-trade-api');
const tradingServiceDB = require('../src/services/tradingServiceDB');

/**
 * Added 2026-09-17. Real incident: a NAT limit sell filled 5.5 hours after
 * submission, at a different price than known at submission time — but the
 * DB had already recorded a completed sale of the FULL requested quantity
 * the moment brokerService's 15s waitForFill window expired, because
 * sellMarket/buyMarket computed the correct filled quantity internally but
 * then passed the ORIGINAL requested quantity to executeSellOrder/
 * executeBuyOrder regardless — every not-fully-filled order (including a
 * completely unfilled one) got recorded as fully, immediately done.
 */
describe('brokerService (alpaca) — records only what actually filled', () => {
    let brokerService;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();
        process.env.BROKER = 'alpaca';

        jest.doMock('axios', () => ({
            get: jest.fn().mockResolvedValue({ data: [] }), // no open orders to cancel
            delete: jest.fn().mockResolvedValue({}),
        }));
        jest.doMock('@alpacahq/alpaca-trade-api');
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
        jest.doMock('../src/services/userDatabaseService', () => ({
            getUserAlpacaCredentials: jest.fn().mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true }),
        }));
        jest.doMock('../src/services/tradingControlService', () => ({
            getGlobalTradingControl: jest.fn().mockResolvedValue({ globalTradingEnabled: true }),
            getUserTradingControls: jest.fn().mockResolvedValue({ aiTradingEnabled: true, botTradingEnabled: true }),
        }));
        jest.doMock('../src/services/dataProvider', () => ({
            getQuote: jest.fn().mockResolvedValue({ price: 100, ask: 100.1, bid: 99.9 }),
        }));
        jest.doMock('../src/services/tradingServiceDB', () => ({
            executeBuyOrder: jest.fn().mockResolvedValue({}),
            executeSellOrder: jest.fn().mockResolvedValue({}),
        }));
        jest.doMock('../src/utils/logger', () => ({
            logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trade: jest.fn(), riskEvent: jest.fn() },
        }));

        brokerService = require('../src/services/brokerService');
    });

    function mockOrderLifecycle({ createOrderId = 'ord-1', getOrderResponses }) {
        const AlpacaCtor = require('@alpacahq/alpaca-trade-api');
        let call = 0;
        AlpacaCtor.mockImplementation(() => ({
            createOrder: jest.fn().mockResolvedValue({ id: createOrderId }),
            getOrder: jest.fn().mockImplementation(() => {
                const resp = getOrderResponses[Math.min(call, getOrderResponses.length - 1)];
                call++;
                return Promise.resolve(resp);
            }),
        }));
    }

    test('sellMarket: fully filled — records the real fill qty/price, not the requested ones', async () => {
        mockOrderLifecycle({ getOrderResponses: [{ status: 'filled', filled_qty: '9', filled_avg_price: '121.70' }] });
        const tradesDb = require('../src/services/tradingServiceDB');

        const result = await brokerService.sellMarket('user-1', 'SOXL', 9, { reason: 'test' });

        expect(tradesDb.executeSellOrder).toHaveBeenCalledWith('user-1', 'SOXL', 9, 'ALPACA_PAPER', 'test', 121.70, 'ord-1');
        expect(result.filledQty).toBe(9);
        expect(result.filledAvgPrice).toBe(121.70);
    });

    test('sellMarket: unfilled after the wait window — does NOT record a sale', async () => {
        mockOrderLifecycle({ getOrderResponses: [{ status: 'new', filled_qty: '0', filled_avg_price: null }] });
        const tradesDb = require('../src/services/tradingServiceDB');

        // waitForFill polls every 500ms for up to 15s (a real ~15s wait — this is what
        // actually happened live for NAT, just compressed here) — fake-timer it so the
        // test doesn't take 15 real seconds.
        jest.useFakeTimers({ doNotFake: ['nextTick'] });
        const resultPromise = brokerService.sellMarket('user-1', 'NAT', 8, { reason: 'test' });
        await jest.advanceTimersByTimeAsync(16000);
        const result = await resultPromise;
        jest.useRealTimers();

        expect(tradesDb.executeSellOrder).not.toHaveBeenCalled();
        expect(result.filledQty).toBe(0);
        expect(result.status).toBe('new');
    });

    test('sellMarket: partially filled — records only the portion that actually filled', async () => {
        mockOrderLifecycle({ getOrderResponses: [{ status: 'partially_filled', filled_qty: '3', filled_avg_price: '50.00' }] });
        const tradesDb = require('../src/services/tradingServiceDB');

        const result = await brokerService.sellMarket('user-1', 'XYZ', 10, { reason: 'test' });

        expect(tradesDb.executeSellOrder).toHaveBeenCalledWith('user-1', 'XYZ', 3, 'ALPACA_PAPER', 'test', 50.00, 'ord-1');
        expect(result.filledQty).toBe(3);
    });

    test('buyMarket: fully filled — records the real fill qty and passes the real fill price through', async () => {
        mockOrderLifecycle({ getOrderResponses: [{ status: 'filled', filled_qty: '10', filled_avg_price: '150.25' }] });
        const tradesDb = require('../src/services/tradingServiceDB');

        const result = await brokerService.buyMarket('user-1', 'AAPL', 10, {});

        expect(tradesDb.executeBuyOrder).toHaveBeenCalledWith(
            'user-1', 'AAPL', 10, 'ALPACA_PAPER', null, null, null, 150.25, null, null, 'ord-1'
        );
        expect(result.filledQty).toBe(10);
        expect(result.filledAvgPrice).toBe(150.25);
    });

    test('buyMarket: unfilled after the wait window — does NOT record a purchase', async () => {
        mockOrderLifecycle({ getOrderResponses: [{ status: 'new', filled_qty: '0', filled_avg_price: null }] });
        const tradesDb = require('../src/services/tradingServiceDB');

        jest.useFakeTimers({ doNotFake: ['nextTick'] });
        const resultPromise = brokerService.buyMarket('user-1', 'AAPL', 10, {});
        await jest.advanceTimersByTimeAsync(16000);
        const result = await resultPromise;
        jest.useRealTimers();

        expect(tradesDb.executeBuyOrder).not.toHaveBeenCalled();
        expect(result.filledQty).toBe(0);
    });
});

/**
 * Added 2026-09-18. Real incident: HPQ and SWKS extended-hours buys each
 * recorded fewer shares than the order's real eventual total (11 vs 14, 4 vs
 * 5) — buyLimitExtendedHours treated ANY positive filled_qty at the 15s
 * waitForFill mark as the order's final outcome, even a 'partially_filled'
 * status, with no mechanism to catch the rest once it filled later (which
 * extended-hours 'day' orders commonly do, over the following minutes/hours
 * of thin liquidity). It also never passed the known fillPrice through to
 * executeBuyOrder (always null), forcing a fresh same-moment quote lookup
 * instead — the same gap already fixed in buyMarket/sellMarket.
 */
describe('brokerService (alpaca) — buyLimitExtendedHours defers incomplete fills to reconciliation', () => {
    let brokerService;

    beforeEach(() => {
        jest.clearAllMocks();
        jest.resetModules();
        process.env.BROKER = 'alpaca';

        jest.doMock('axios', () => ({
            get: jest.fn().mockResolvedValue({ data: [] }),
            delete: jest.fn().mockResolvedValue({}),
        }));
        jest.doMock('@alpacahq/alpaca-trade-api');
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
        jest.doMock('../src/services/userDatabaseService', () => ({
            getUserAlpacaCredentials: jest.fn().mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true }),
        }));
        jest.doMock('../src/services/tradingControlService', () => ({
            getGlobalTradingControl: jest.fn().mockResolvedValue({ globalTradingEnabled: true }),
            getUserTradingControls: jest.fn().mockResolvedValue({ aiTradingEnabled: true, botTradingEnabled: true }),
        }));
        jest.doMock('../src/services/dataProvider', () => ({
            getQuote: jest.fn().mockResolvedValue({ price: 34.6, ask: 34.65, bid: 34.55 }),
        }));
        jest.doMock('../src/services/tradingServiceDB', () => ({
            executeBuyOrder: jest.fn().mockResolvedValue({}),
            executeSellOrder: jest.fn().mockResolvedValue({}),
        }));
        jest.doMock('../src/utils/logger', () => ({
            logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trade: jest.fn(), riskEvent: jest.fn() },
        }));

        brokerService = require('../src/services/brokerService');
    });

    function mockOrderLifecycle({ createOrderId = 'ord-1', getOrderResponses }) {
        const AlpacaCtor = require('@alpacahq/alpaca-trade-api');
        let call = 0;
        // buyLimitExtendedHours calls getClientForUser twice — once for the entry order,
        // once more for the follow-up stop-order placement — each constructing a fresh
        // Alpaca client. Share one createOrder spy across every instantiation so a test
        // can assert total call count in one place instead of picking a specific instance.
        const sharedCreateOrder = jest.fn().mockResolvedValue({ id: createOrderId });
        AlpacaCtor.mockImplementation(() => ({
            createOrder: sharedCreateOrder,
            getOrder: jest.fn().mockImplementation(() => {
                const resp = getOrderResponses[Math.min(call, getOrderResponses.length - 1)];
                call++;
                return Promise.resolve(resp);
            }),
        }));
        return { sharedCreateOrder };
    }

    test('fully filled — records with the real fill price passed through, not null', async () => {
        mockOrderLifecycle({ getOrderResponses: [{ status: 'filled', filled_qty: '14', filled_avg_price: '34.60' }] });
        const tradesDb = require('../src/services/tradingServiceDB');

        const result = await brokerService.buyLimitExtendedHours('user-1', 'HPQ', 14, {});

        expect(tradesDb.executeBuyOrder).toHaveBeenCalledWith(
            'user-1', 'HPQ', 14, 'ALPACA_PAPER_EXTENDED_HOURS', null, null, null, 34.60, null, null, 'ord-1'
        );
        expect(result.filledQty).toBe(14);
    });

    test('partially filled — does NOT record yet, but still protects the shares that did fill', async () => {
        const { sharedCreateOrder } = mockOrderLifecycle({ getOrderResponses: [{ status: 'partially_filled', filled_qty: '11', filled_avg_price: '34.65' }] });
        const tradesDb = require('../src/services/tradingServiceDB');

        const result = await brokerService.buyLimitExtendedHours('user-1', 'HPQ', 14, {});

        expect(tradesDb.executeBuyOrder).not.toHaveBeenCalled();
        // Stop-placement still attempted for the 11 confirmed shares, independent of recording.
        expect(sharedCreateOrder).toHaveBeenCalledTimes(2); // entry + stop
        expect(result.filledQty).toBe(11);
        expect(result.status).toBe('partially_filled');
    });

    test('unfilled — neither records nor attempts a stop', async () => {
        const { sharedCreateOrder } = mockOrderLifecycle({ getOrderResponses: [{ status: 'new', filled_qty: '0', filled_avg_price: null }] });
        const tradesDb = require('../src/services/tradingServiceDB');

        jest.useFakeTimers({ doNotFake: ['nextTick'] });
        const resultPromise = brokerService.buyLimitExtendedHours('user-1', 'HPQ', 14, {});
        await jest.advanceTimersByTimeAsync(16000);
        const result = await resultPromise;
        jest.useRealTimers();

        expect(tradesDb.executeBuyOrder).not.toHaveBeenCalled();
        expect(sharedCreateOrder).toHaveBeenCalledTimes(1); // entry only, no stop
        expect(result.filledQty).toBe(0);
    });
});
