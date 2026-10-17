/**
 * Core holdings (2026-10-17): long-term positions the swing bot must never manage, and a
 * buy-only daily rebalance toward target weights.
 */
describe('coreHoldingsService', () => {
    let core, query, broker, dataProvider;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        jest.doMock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
        jest.doMock('../src/services/brokerService', () => ({
            getAccountInfo: jest.fn(), getPositions: jest.fn(), getOpenOrders: jest.fn().mockResolvedValue([]), buyMarket: jest.fn(),
        }));
        jest.doMock('../src/services/dataProvider', () => ({ getQuote: jest.fn() }));
        jest.doMock('../src/services/tradingControlService', () => ({ getUserTradingControls: jest.fn().mockResolvedValue({ maxOrderNotional: 0 }) }));
        process.env.MAX_BOT_INVESTMENT_USD = '15000';
        core = require('../src/services/coreHoldingsService');
        query = require('../src/config/database').query;
        broker = require('../src/services/brokerService');
        dataProvider = require('../src/services/dataProvider');
    });

    const coreRows = rows => query.mockImplementation(sql =>
        Promise.resolve(/FROM core_holdings/.test(sql) ? { rows } : { rows: [] }));

    test('core symbols come back upper-cased as a Set', async () => {
        coreRows([{ symbol: 'spy', targetPct: 40 }, { symbol: 'V', targetPct: 10 }]);
        expect([...(await core.getCoreSymbols('u1'))]).toEqual(['SPY', 'V']);
    });

    test('a failed read never answers "no core": stale copy if cached, else it throws', async () => {
        query.mockRejectedValue(new Error('db down'));
        await expect(core.getCoreSymbols('u-new')).rejects.toThrow('db down');
    });

    test('rebalance buys whole shares toward target and keeps the swing cash reserve', async () => {
        coreRows([{ symbol: 'SPY', targetPct: 50 }]);
        broker.getAccountInfo.mockResolvedValue({ portfolioValue: 10000, cashBalance: 9000 });
        broker.getPositions.mockResolvedValue([]);
        dataProvider.getQuote.mockResolvedValue({ price: 700 });
        broker.buyMarket.mockResolvedValue({ filledQty: 7, filledAvgPrice: 700, status: 'filled' });

        const actions = await core.rebalanceCore('u1');

        // target $5,000, cash $9,000 − reserve 25% ($2,500) leaves $6,500 → $5,000 / ($700 × 1.005) → 7 shares
        expect(broker.buyMarket).toHaveBeenCalledWith('u1', 'SPY', 7, expect.objectContaining({ executedBy: 'CORE' }));
        expect(actions[0]).toMatchObject({ symbol: 'SPY', action: 'bought', qty: 7 });
    });

    test('a big target is built in steps under the per-order cap', async () => {
        coreRows([{ symbol: 'SPY', targetPct: 40 }]);
        broker.getAccountInfo.mockResolvedValue({ portfolioValue: 107000, cashBalance: 105000 }); // target $42,800
        broker.getPositions.mockResolvedValue([]);
        dataProvider.getQuote.mockResolvedValue({ price: 770 });
        broker.buyMarket.mockResolvedValue({ filledQty: 18, filledAvgPrice: 770, status: 'filled' });
        await core.rebalanceCore('u1');
        // $15,000 × 0.98 = $14,700 / ($770 × 1.005) → 18 shares today; the rest on later days
        expect(broker.buyMarket).toHaveBeenCalledWith('u1', 'SPY', 18, expect.any(Object));
    });

    test('rebalance is limited by the cash reserve', async () => {
        coreRows([{ symbol: 'SPY', targetPct: 50 }]);
        broker.getAccountInfo.mockResolvedValue({ portfolioValue: 10000, cashBalance: 3000 }); // swing already uses most cash
        broker.getPositions.mockResolvedValue([]);
        dataProvider.getQuote.mockResolvedValue({ price: 700 });
        const actions = await core.rebalanceCore('u1');
        expect(broker.buyMarket).not.toHaveBeenCalled(); // $3,000 − $2,500 reserve = $500 < 1 share
        expect(actions[0].action).toBe('no_cash');
    });

    test('at target, or with a buy still resting from earlier, it does nothing — and it never sells', async () => {
        coreRows([{ symbol: 'SPY', targetPct: 50 }, { symbol: 'V', targetPct: 10 }]);
        broker.getAccountInfo.mockResolvedValue({ portfolioValue: 10000, cashBalance: 9000 });
        broker.getPositions.mockResolvedValue([{ symbol: 'SPY', marketValue: 4900 }]);
        broker.getOpenOrders.mockImplementation((uid, sym) => Promise.resolve(sym === 'V' ? [{ side: 'buy', symbol: 'V' }] : []));
        const actions = await core.rebalanceCore('u1');
        expect(actions.map(a => a.action)).toEqual(['at_target', 'pending_order']);
        expect(broker.buyMarket).not.toHaveBeenCalled();
        expect(broker).not.toHaveProperty('sellMarket');
    });
});

describe('swing bot never touches core positions', () => {
    test('slot guard: a core symbol is a duplicate, and core positions use no swing slots', async () => {
        jest.resetModules();
        jest.doMock('../src/services/coreHoldingsService', () => ({ getCoreSymbols: jest.fn().mockResolvedValue(new Set(['SPY'])) }));
        jest.doMock('../src/services/holdingsDatabaseService', () => ({
            getUserHoldings: jest.fn().mockResolvedValue([{ symbol: 'SPY' }, { symbol: 'AAPL' }]),
        }));
        jest.doMock('../src/services/brokerService', () => ({ getOpenOrders: jest.fn().mockResolvedValue([]) }));
        const { _reservePositionSlot } = require('../src/services/enhancedAITradingBot');

        expect(await _reservePositionSlot('u1', 'SPY', 6)).toMatchObject({ ok: false, duplicate: true });
        // max 2 swing slots: AAPL uses one, SPY (core) uses none → NVDA still fits
        expect(await _reservePositionSlot('u1', 'NVDA', 2)).toMatchObject({ ok: true, count: 2 });
    });
});
