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
        process.env.CORE_FRACTIONAL = 'off'; // whole-share cases below; fractional cases set 'on'
        core = require('../src/services/coreHoldingsService');
        query = require('../src/config/database').query;
        broker = require('../src/services/brokerService');
        dataProvider = require('../src/services/dataProvider');
    });

    const coreRows = rows => query.mockImplementation(sql => Promise.resolve(
        /FROM core_holdings/.test(sql) ? { rows }
            : /FROM core_settings/.test(sql) ? { rows: [{ enabled: true, cashReservePct: 25 }] }
            : { rows: [] }));

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

    // 2026-10-19 first live run: paper's $500 swing per-order limit made SPY ($770) unbuyable.
    test('the swing per-order limit does not apply to core; buys skip that check', async () => {
        coreRows([{ symbol: 'SPY', targetPct: 40 }]);
        broker.getAccountInfo.mockResolvedValue({ portfolioValue: 10000, cashBalance: 9000 });
        broker.getPositions.mockResolvedValue([]);
        dataProvider.getQuote.mockResolvedValue({ price: 770 });
        broker.buyMarket.mockResolvedValue({ filledQty: 5, filledAvgPrice: 770, status: 'filled' });
        await core.rebalanceCore('u1');
        expect(broker.buyMarket).toHaveBeenCalledWith('u1', 'SPY', 5, expect.objectContaining({ safetyOptions: { enforceNotionalLimit: false } }));
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

    // 2026-10-26: fractional core — targets are hit exactly and small accounts can hold SPY.
    test('fractional mode buys the exact dollar amount (4 decimals)', async () => {
        process.env.CORE_FRACTIONAL = 'on';
        coreRows([{ symbol: 'SPY', targetPct: 50 }]);
        broker.getAccountInfo.mockResolvedValue({ portfolioValue: 10000, cashBalance: 9000 });
        broker.getPositions.mockResolvedValue([]);
        dataProvider.getQuote.mockResolvedValue({ price: 700 });
        broker.buyMarket.mockResolvedValue({ filledQty: 7.1073, filledAvgPrice: 700, status: 'filled' });
        await core.rebalanceCore('u1');
        expect(broker.buyMarket).toHaveBeenCalledWith('u1', 'SPY', 7.1073, expect.any(Object));
    });
    test('fractional mode: a small account can buy part of a share, but never under $50', async () => {
        process.env.CORE_FRACTIONAL = 'on';
        coreRows([{ symbol: 'SPY', targetPct: 40 }]);
        broker.getAccountInfo.mockResolvedValue({ portfolioValue: 1000, cashBalance: 900 });
        broker.getPositions.mockResolvedValue([]);
        dataProvider.getQuote.mockResolvedValue({ price: 760 });
        broker.buyMarket.mockResolvedValue({ filledQty: 0.5236, filledAvgPrice: 760, status: 'filled' });
        await core.rebalanceCore('u1');
        expect(broker.buyMarket).toHaveBeenCalledWith('u1', 'SPY', 0.5236, expect.any(Object)); // $400 target
        broker.buyMarket.mockClear();
        broker.getAccountInfo.mockResolvedValue({ portfolioValue: 1000, cashBalance: 280 }); // $30 above the reserve
        const actions = await core.rebalanceCore('u1');
        expect(broker.buyMarket).not.toHaveBeenCalled();
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

describe('coreHoldingsService.saveConfig (Settings screen rules)', () => {
    let core, query;
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        jest.doMock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
        core = require('../src/services/coreHoldingsService');
        query = require('../src/config/database').query;
    });
    // current core list + current holdings (any strategy)
    const db = ({ core = [], held = [] } = {}) => query.mockImplementation(sql => {
        if (/SELECT symbol FROM core_holdings/.test(sql)) return Promise.resolve({ rows: core.map(symbol => ({ symbol })) });
        if (/FROM holdings WHERE/.test(sql)) return Promise.resolve({ rows: held.map(symbol => ({ symbol })) });
        if (/FROM core_holdings WHERE user_id = $1 AND active/.test(sql)) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [] });
    });

    test('rejects a total over 80% and a single stock over 50%', async () => {
        db();
        await expect(core.saveConfig('u1', { holdings: [{ symbol: 'SPY', targetPct: 60 }, { symbol: 'QQQ', targetPct: 30 }] }))
            .rejects.toThrow(/target must be 0-50%.*Total target is 90%/);
    });

    test('rejects adding a stock the swing bot currently holds', async () => {
        db({ held: ['NVDA'] });
        await expect(core.saveConfig('u1', { holdings: [{ symbol: 'NVDA', targetPct: 10 }] })).rejects.toThrow(/open swing-bot position/);
    });

    test('removing a held core stock needs explicit release; 0% keeps holding', async () => {
        db({ core: ['V'], held: ['V'] });
        await expect(core.saveConfig('u1', { holdings: [] })).rejects.toThrow(/V is still held/);
        await expect(core.saveConfig('u1', { holdings: [{ symbol: 'V', targetPct: 0 }] })).resolves.toMatchObject({ released: [] });
        await expect(core.saveConfig('u1', { holdings: [], releaseSymbols: ['V'] })).resolves.toMatchObject({ released: ['V'] });
    });

    test('rejects invalid symbols and duplicates', async () => {
        db();
        await expect(core.saveConfig('u1', { holdings: [{ symbol: 'sp y', targetPct: 5 }] })).rejects.toThrow(/not a valid stock symbol/);
        await expect(core.saveConfig('u1', { holdings: [{ symbol: 'SPY', targetPct: 5 }, { symbol: 'spy', targetPct: 5 }] })).rejects.toThrow(/only once/);
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
