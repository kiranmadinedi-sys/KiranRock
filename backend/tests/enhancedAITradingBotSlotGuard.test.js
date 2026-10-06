jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), aiDecision: jest.fn() },
}));

/**
 * 2026-10-05 real incident: kmadined (maxOpenPositions 6) went from 4 to 8 positions
 * in two minutes. Morning cycles ran 30-97 min, so the scheduler's 15-min stuck-lock
 * force-clear let three cycles overlap, and each one checked the position cap against
 * the holdings snapshot from its own start. _reservePositionSlot re-counts from live
 * sources right before each order and reserves the slot in the same synchronous step.
 */
describe('_reservePositionSlot — cross-cycle position cap', () => {
    let bot, holdingsDb, brokerService;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/services/holdingsDatabaseService', () => ({ getUserHoldings: jest.fn() }));
        jest.doMock('../src/services/brokerService', () => ({ getOpenOrders: jest.fn() }));
        holdingsDb = require('../src/services/holdingsDatabaseService');
        brokerService = require('../src/services/brokerService');
        bot = require('../src/services/enhancedAITradingBot');
        holdingsDb.getUserHoldings.mockResolvedValue(
            ['ARW', 'BJ', 'TMO', 'NAT'].map(symbol => ({ symbol }))
        );
        brokerService.getOpenOrders.mockResolvedValue([]);
    });

    test('three concurrent cycles buying 5 symbols with 4 held and max 6: only 2 get a slot', async () => {
        const symbols = ['PANW', 'SCCO', 'OKTA', 'SHOP', 'LXP'];
        const results = await Promise.all(symbols.map(s => bot._reservePositionSlot('u1', s, 6)));
        expect(results.filter(r => r.ok)).toHaveLength(2);
        expect(results.filter(r => !r.ok).every(r => r.count === 6)).toBe(true);
    });

    test('a pending broker buy order occupies a slot (filled-but-not-yet-recorded window)', async () => {
        brokerService.getOpenOrders.mockResolvedValue([
            { side: 'buy', symbol: 'PANW' }, { side: 'buy', symbol: 'SCCO' },
            { side: 'sell', symbol: 'ARW' },     // a stop, not a new position
            { side: 'buy', symbol: 'BTC/USD' },  // crypto has its own book
        ]);
        const r = await bot._reservePositionSlot('u1', 'OKTA', 6);
        expect(r).toEqual({ ok: false, duplicate: false, count: 6 });
    });

    test('the same symbol cannot be bought by two cycles at once', async () => {
        const [a, b] = await Promise.all([
            bot._reservePositionSlot('u1', 'PANW', 6),
            bot._reservePositionSlot('u1', 'PANW', 6),
        ]);
        expect([a.ok, b.ok].sort()).toEqual([false, true]);
        expect((a.ok ? b : a).duplicate).toBe(true);
    });

    test('an open-orders failure still enforces the cap from holdings + reservations', async () => {
        brokerService.getOpenOrders.mockRejectedValue(new Error('timeout'));
        const first  = await bot._reservePositionSlot('u1', 'PANW', 5);
        const second = await bot._reservePositionSlot('u1', 'SCCO', 5);
        expect(first.ok).toBe(true);
        expect(second.ok).toBe(false);
    });

    test('reservations expire, and are per user', async () => {
        const realNow = Date.now;
        try {
            expect((await bot._reservePositionSlot('u1', 'PANW', 5)).ok).toBe(true);
            expect((await bot._reservePositionSlot('u2', 'SCCO', 5)).ok).toBe(true); // different user
            expect((await bot._reservePositionSlot('u1', 'SCCO', 5)).ok).toBe(false);
            Date.now = () => realNow() + 4 * 60 * 1000; // past the 3-min TTL
            expect((await bot._reservePositionSlot('u1', 'SCCO', 5)).ok).toBe(true);
        } finally {
            Date.now = realNow;
        }
    });
});
