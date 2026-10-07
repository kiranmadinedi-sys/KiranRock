jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/enhancedAITradingBot', () => ({
    scanMarketForOpportunities: jest.fn(),
    getUserRiskConfig: jest.fn(),
    _reservePositionSlot: jest.fn(),
}));
jest.mock('../src/services/brokerService', () => ({ getAccountInfo: jest.fn(), buyLimitExtendedHours: jest.fn() }));
jest.mock('../src/services/holdingsDatabaseService', () => ({ getUserHoldings: jest.fn() }));
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { query } = require('../src/config/database');
const bot = require('../src/services/enhancedAITradingBot');
const broker = require('../src/services/brokerService');
const holdingsDb = require('../src/services/holdingsDatabaseService');
const { scanExtendedHoursForUser } = require('../src/services/extendedHoursTradingService');

/**
 * 2026-10-06: the extended-hours entry path had no account-level position cap — the
 * paper account (max_open_positions 4, holding 7) bought SNOW after hours to reach 8,
 * and ran ~65 full pre-market scans while it could never legally buy.
 */
describe('extended-hours entries respect max_open_positions', () => {
    const user = { id: 'user-1' };
    const held = n => Array.from({ length: n }, (_, i) => ({ symbol: `H${i}` }));

    beforeEach(() => {
        jest.clearAllMocks();
        query.mockResolvedValue({ rows: [{ n: 0 }] }); // today's extended-hours entries
        bot.getUserRiskConfig.mockResolvedValue({ maxOpenPositions: 4, minBuyScore: 75, stopLoss: -0.05 });
        bot.scanMarketForOpportunities.mockResolvedValue([{ symbol: 'SNOW', price: 300, recommendation: 'STRONG BUY', aiScore: 95 }]);
        broker.getAccountInfo.mockResolvedValue({ cashBalance: 10000 });
        broker.buyLimitExtendedHours.mockResolvedValue({ filledQty: 1, filledAvgPrice: 300 });
        bot._reservePositionSlot.mockResolvedValue({ ok: true, count: 4 });
    });

    test('an account already at or over its limit skips the scan entirely and buys nothing', async () => {
        holdingsDb.getUserHoldings.mockResolvedValue(held(7));
        await scanExtendedHoursForUser(user);
        expect(bot.scanMarketForOpportunities).not.toHaveBeenCalled();
        expect(broker.buyLimitExtendedHours).not.toHaveBeenCalled();
    });

    test('with room, the fresh slot guard is checked before the order and can still stop it', async () => {
        holdingsDb.getUserHoldings.mockResolvedValue(held(3));
        bot._reservePositionSlot.mockResolvedValue({ ok: false, duplicate: false, count: 4 }); // a regular-hours cycle just filled the slot
        await scanExtendedHoursForUser(user);
        expect(bot._reservePositionSlot).toHaveBeenCalledWith('user-1', 'SNOW', 4);
        expect(broker.buyLimitExtendedHours).not.toHaveBeenCalled();
    });

    test('with room and a free slot, the entry is placed', async () => {
        holdingsDb.getUserHoldings.mockResolvedValue(held(3));
        await scanExtendedHoursForUser(user);
        // $500 extended-hours notional cap / $300 → 1 whole share
        expect(broker.buyLimitExtendedHours).toHaveBeenCalledWith('user-1', 'SNOW', 1, expect.any(Object));
    });
});
