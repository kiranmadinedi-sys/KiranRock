/**
 * 2026-09-19: kmadined's ORCL buy was recorded twice — once by buyBracket's
 * live-fill path here, once by the reconciler's SHADOW backfill — each with
 * no broker_order_id, so nothing could ever tell they were the same real
 * Alpaca order. buyBracket is the main live equity-entry path (PANTHEON
 * ARROW spec: always use bracket for new entries), so it's the highest-value
 * call site to confirm actually threads the real order id through to
 * executeBuyOrder's new trailing param.
 */
describe('brokerService.buyBracket — passes the real broker order id through (2026-09-19)', () => {
    let brokerService;

    beforeEach(() => {
        jest.resetModules();
        process.env.BROKER = 'alpaca';

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
            getQuote: jest.fn().mockResolvedValue({ price: 156.24, ask: 156.30, bid: 156.20 }),
        }));
        jest.doMock('../src/services/tradingServiceDB', () => ({
            executeBuyOrder: jest.fn().mockResolvedValue({}),
            executeSellOrder: jest.fn().mockResolvedValue({}),
        }));
        jest.doMock('../src/utils/logger', () => ({
            logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trade: jest.fn(), riskEvent: jest.fn() },
        }));

        const AlpacaCtor = require('@alpacahq/alpaca-trade-api');
        AlpacaCtor.mockImplementation(() => ({
            getAccount: jest.fn().mockResolvedValue({ cash: '100000' }),
            createOrder: jest.fn().mockResolvedValue({ id: '8ba07571-real-order' }),
            getOrder: jest.fn().mockResolvedValue({ status: 'filled', filled_qty: '1', filled_avg_price: '156.5676' }),
        }));

        brokerService = require('../src/services/brokerService');
    });

    test('the real Alpaca order id is passed as executeBuyOrder\'s trailing brokerOrderId param', async () => {
        const tradingServiceDB = require('../src/services/tradingServiceDB');

        await brokerService.buyBracket('user-1', 'ORCL', 1, { stopPrice: 144.52, targetPrice: 250.25 });

        expect(tradingServiceDB.executeBuyOrder).toHaveBeenCalled();
        const call = tradingServiceDB.executeBuyOrder.mock.calls[0];
        expect(call[call.length - 1]).toBe('8ba07571-real-order');
    });
});
