jest.mock('@alpacahq/alpaca-trade-api');
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/userDatabaseService', () => ({
    getUsersWithAITradingEnabled: jest.fn(),
    getUserAlpacaCredentials: jest.fn(),
}));
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/enhancedAITradingBot', () => ({}));
jest.mock('../src/services/tradingControlService', () => ({ getGlobalTradingControl: jest.fn() }));
jest.mock('../src/services/redisStateService', () => ({}));
jest.mock('../src/services/vixSpikeMonitorService', () => ({}));
jest.mock('../src/services/premarketGapAlertService', () => ({}));
jest.mock('../src/services/extendedHoursTradingService', () => ({}));
jest.mock('../src/services/marketRegimeService', () => ({ getMarketRegime: jest.fn() }));
jest.mock('../src/services/globalSentimentService', () => ({ getGlobalSentiment: jest.fn() }));

const Alpaca = require('@alpacahq/alpaca-trade-api');
const { query } = require('../src/config/database');
const userDb = require('../src/services/userDatabaseService');
const alertService = require('../src/services/telegramAlertService');

/**
 * Added 2026-09-17 alongside the fix. Real incident: 8 of 11 daily stop
 * restoration attempts failed with a 403 on 2026-09-16 (C, PFE, XLC, SMCI,
 * INTC, PBR) — traced via Alpaca's real order history to bracket orders
 * (and stops mid cancel-replace) that the old protectedSymbols check
 * (stop/stop_limit/trailing_stop only) didn't recognize as protection,
 * causing a redundant, always-403 placement attempt. None were actually
 * naked — Alpaca's qty_available drops to 0 the moment ANY resting sell
 * order exists, regardless of type, which is exactly what a 403 here means.
 * Fix: count any resting sell order as protection, and alert (not just
 * silently console.warn) on any restoration attempt that still fails.
 */
describe('enhancedAIScheduler.runMorningStopVerification', () => {
    let runMorningStopVerification;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();
        // 13:31 UTC in September = 9:31 AM ET (EDT, UTC-4) — inside the 9:31-9:44 window.
        jest.setSystemTime(new Date('2026-09-16T13:31:00Z'));

        jest.doMock('@alpacahq/alpaca-trade-api');
        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        jest.doMock('../src/services/userDatabaseService', () => ({
            getUsersWithAITradingEnabled: jest.fn(),
            getUserAlpacaCredentials: jest.fn(),
        }));
        jest.doMock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));
        jest.doMock('../src/services/enhancedAITradingBot', () => ({}));
        jest.doMock('../src/services/tradingControlService', () => ({ getGlobalTradingControl: jest.fn() }));
        jest.doMock('../src/services/redisStateService', () => ({}));
        jest.doMock('../src/services/vixSpikeMonitorService', () => ({}));
        jest.doMock('../src/services/premarketGapAlertService', () => ({}));
        jest.doMock('../src/services/extendedHoursTradingService', () => ({}));
        jest.doMock('../src/services/marketRegimeService', () => ({ getMarketRegime: jest.fn() }));
        jest.doMock('../src/services/globalSentimentService', () => ({ getGlobalSentiment: jest.fn() }));

        ({ runMorningStopVerification } = require('../src/services/enhancedAIScheduler'));

        const userDbMock = require('../src/services/userDatabaseService');
        userDbMock.getUsersWithAITradingEnabled.mockResolvedValue([{ id: 'user-1' }]);
        userDbMock.getUserAlpacaCredentials.mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true });

        const dbMock = require('../src/config/database');
        dbMock.query.mockResolvedValue({ rows: [{ stop_loss: '-0.05' }] });
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    function mockAlpaca({ positions, openOrders, createOrderImpl }) {
        const AlpacaCtor = require('@alpacahq/alpaca-trade-api');
        AlpacaCtor.mockImplementation(() => ({
            getPositions: jest.fn().mockResolvedValue(positions),
            getOrders: jest.fn().mockResolvedValue(openOrders),
            createOrder: createOrderImpl || jest.fn().mockResolvedValue({}),
        }));
    }

    test('does NOT attempt a redundant stop when the position is protected by a bracket take-profit LIMIT leg', async () => {
        const createOrder = jest.fn().mockResolvedValue({});
        mockAlpaca({
            positions: [{ symbol: 'C', qty: '3', avg_entry_price: '135.00' }],
            openOrders: [{ symbol: 'C', side: 'sell', type: 'limit' }], // bracket take-profit leg, not stop-typed
            createOrderImpl: createOrder,
        });
        const alertMock = require('../src/services/telegramAlertService');

        await runMorningStopVerification();

        expect(createOrder).not.toHaveBeenCalled();
        expect(alertMock.sendMessage).not.toHaveBeenCalled();
    });

    test('still restores a genuinely unprotected position and sends a success alert', async () => {
        const createOrder = jest.fn().mockResolvedValue({});
        mockAlpaca({
            positions: [{ symbol: 'NAT', qty: '13', avg_entry_price: '6.72' }],
            openOrders: [],
            createOrderImpl: createOrder,
        });
        const alertMock = require('../src/services/telegramAlertService');

        await runMorningStopVerification();

        expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'NAT', side: 'sell', type: 'stop' }));
        expect(alertMock.sendMessage).toHaveBeenCalledWith('user-1', expect.stringContaining('restored automatically'));
    });

    test('a placement failure now sends a failure alert instead of staying silent', async () => {
        const createOrder = jest.fn().mockRejectedValue({
            message: 'Request failed with status code 403',
            response: { data: { message: 'insufficient qty available for order (requested: 23, available: 0)' } },
        });
        mockAlpaca({
            positions: [{ symbol: 'PBR', qty: '23', avg_entry_price: '21.30' }],
            openOrders: [], // race: the actually-protecting order isn't visible in this snapshot
            createOrderImpl: createOrder,
        });
        const alertMock = require('../src/services/telegramAlertService');

        await runMorningStopVerification();

        expect(createOrder).toHaveBeenCalled();
        expect(alertMock.sendMessage).toHaveBeenCalledWith(
            'user-1',
            expect.stringContaining('insufficient qty available')
        );
    });
});
