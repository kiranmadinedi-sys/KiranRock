jest.mock('../src/config/database', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
const sb = require('../src/services/brokerScoreboardService');

const ctx = (o = {}) => ({ bearOrders: new Set(o.bearOrders || []), bearSymbols: new Set(o.bearSymbols || []), sleeves: new Map(Object.entries(o.sleeves || {})) });

describe('broker scoreboard — which strategy a fill belongs to', () => {
    test('bear by order id or contract; crypto pairs; option contracts; sleeves; else swing', () => {
        const c = ctx({ bearOrders: ['o-bear'], bearSymbols: ['SPY261218P00650000'], sleeves: { SPY: 'core', MU: 'satellite', TFC: 'options' } });
        expect(sb.classify({ symbol: 'NKE', orderId: 'o-bear' }, c)).toBe('bear');
        expect(sb.classify({ symbol: 'SPY261218P00650000' }, c)).toBe('bear');
        expect(sb.classify({ symbol: 'SOL/USD' }, c)).toBe('crypto');
        expect(sb.classify({ symbol: 'SOLUSD' }, c)).toBe('crypto');
        expect(sb.classify({ symbol: 'TFC261218P00047500' }, c)).toBe('options');
        expect(sb.classify({ symbol: 'TFC' }, c)).toBe('options');   // assigned wheel shares
        expect(sb.classify({ symbol: 'SPY' }, c)).toBe('core');
        expect(sb.classify({ symbol: 'MU' }, c)).toBe('satellite');
        expect(sb.classify({ symbol: 'AAPL' }, c)).toBe('swing');
    });
    test('a stock ticker ending in USD is not mistaken for crypto', () => {
        expect(sb.isCrypto('AUSD')).toBe(false);
        expect(sb.isCrypto('BTCUSD')).toBe(true);
    });
});

describe('broker scoreboard — average-cost replay', () => {
    const f = (time, symbol, side, qty, price, strategy = 'swing', rawSide = side) => ({ time, symbol, side, rawSide, qty, price, strategy });

    test('long round trip with a partial sale', () => {
        const r = sb.replay([f('1', 'AAPL', 'buy', 10, 100), f('2', 'AAPL', 'buy', 10, 110), f('3', 'AAPL', 'sell', 5, 120)], { today: '2026-11-22' });
        expect(r.events[0].pnl).toBeCloseTo(5 * (120 - 105), 6);
        expect(r.open[0]).toMatchObject({ qty: 15, avg: 105 });
    });
    test('short sale then cover profits when the price falls, and is not flagged as a missing buy', () => {
        const r = sb.replay([f('1', 'NKE', 'sell', 10, 50, 'swing', 'sell_short'), f('2', 'NKE', 'buy', 10, 45)], { today: '2026-11-22' });
        expect(r.events[0].pnl).toBeCloseTo(50, 6);
        expect(r.unknownBasis).toBe(0);
        expect(r.open).toHaveLength(0);
    });
    test('a plain sale with no buy (renamed ticker) is counted as unknown basis', () => {
        expect(sb.replay([f('1', 'BNY', 'sell', 2, 60)], { today: '2026-11-22' }).unknownBasis).toBe(1);
    });
    test('options use the ×100 multiplier; a short put that expired unheld is closed at $0 on expiry', () => {
        const r = sb.replay([f('2026-10-19T15:00:00Z', 'DVN261113P00047000', 'sell', 1, 0.78, 'options', 'sell_short')], { today: '2026-11-22', heldSymbols: new Set() });
        expect(r.events).toHaveLength(1);
        expect(r.events[0]).toMatchObject({ expired: true, time: '2026-11-13T21:00:00Z' });
        expect(r.events[0].pnl).toBeCloseTo(78, 6);
    });
    test('an option still held, or not yet expired, stays open', () => {
        const fills = [f('2026-11-01T15:00:00Z', 'TFC261218P00047500', 'sell', 1, 0.65, 'options', 'sell_short')];
        expect(sb.replay(fills, { today: '2026-11-22' }).events).toHaveLength(0);
        expect(sb.replay(fills, { today: '2026-12-20', heldSymbols: new Set(['TFC261218P00047500']) }).events).toHaveLength(0);
    });
    test('the same symbol in two strategies keeps separate cost', () => {
        const r = sb.replay([f('1', 'NKE', 'buy', 1, 60, 'swing'), f('2', 'NKE', 'sell', 1, 58, 'bear', 'sell_short'), f('3', 'NKE', 'sell', 1, 70, 'swing')], { today: '2026-11-22' });
        expect(r.events).toEqual([expect.objectContaining({ strategy: 'swing', pnl: 10 })]);
        expect(r.open).toEqual([expect.objectContaining({ strategy: 'bear', qty: -1 })]);
    });
});

describe('broker scoreboard — account build reconciles with equity', () => {
    test('realized + fees + dividends + unrealized explains the equity change (paper)', async () => {
        const deps = {
            client: { isPaper: true, base: 'x', headers: {} },
            ctx: ctx({ sleeves: { SPY: 'core' } }),
            activities: [
                { activity_type: 'FILL', transaction_time: '2026-11-18T15:00:00Z', symbol: 'AAPL', side: 'buy', qty: '10', price: '100', order_id: 'a' },
                { activity_type: 'FILL', transaction_time: '2026-11-19T15:00:00Z', symbol: 'AAPL', side: 'sell', qty: '10', price: '90', order_id: 'b' },
                { activity_type: 'FILL', transaction_time: '2026-11-19T15:00:00Z', symbol: 'SOL/USD', side: 'buy', qty: '1', price: '100', order_id: 'c' },
                { activity_type: 'FILL', transaction_time: '2026-11-20T15:00:00Z', symbol: 'SOL/USD', side: 'sell', qty: '0.9975', price: '110', order_id: 'd' },
                { activity_type: 'CFEE', date: '2026-11-19', symbol: 'SOLUSD', qty: '-0.0025', price: '100', net_amount: '0' },
                { activity_type: 'CFEE', date: '2026-11-20', net_amount: '-0.27' },
                { activity_type: 'DIV', date: '2026-11-20', symbol: 'SPY', net_amount: '5' },
                { activity_type: 'FEE', date: '2026-11-20', net_amount: '-0.02' },
            ],
            positions: [{ symbol: 'SPY', unrealized_pl: '-50' }],
            // 100000 − 100 (AAPL) + 9.725 (SOL cash) − 0.27 (USD fee) + 5 (div) − 0.02 (fee) − 50 (open SPY)
            account: { equity: '99864.435' },
            history: { base_value: 100000 },
        };
        const a = await sb.buildAccount('u', { now: new Date('2026-11-22T17:00:00Z'), deps });
        expect(a.windows.d7.swing).toBeCloseTo(-100, 6);
        expect(a.windows.d7.crypto).toBeCloseTo(0.9975 * 10 - 0.25 - 0.27, 4);
        expect(a.windows.d7.core).toBeCloseTo(5, 6);
        expect(a.unrealized.core).toBe(-50);
        expect(Math.abs(a.check.gap)).toBeLessThan(0.05);
    });
});
