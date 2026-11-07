/** Cost ledger, weekly accountability, and the deposit-as-profit fix (2026-11-07). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { query } = require('../src/config/database');
const ledger = require('../src/services/costLedgerService');
const acct = require('../src/services/accountabilityService');
const { removeCashMoves } = require('../src/services/dailyPnlTargetService');

beforeEach(() => query.mockClear());

describe('removeCashMoves', () => {
    const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'];
    test('a deposit that landed in profit_loss is taken out (kmadined 11-03 $2,500)', () => {
        expect(removeCashMoves(days, [10.67, 2492.04, 136.16, -242.19], [{ date: '2026-11-03', amount: 2500 }]).map(v => +v.toFixed(2)))
            .toEqual([10.67, -7.96, 136.16, -242.19]);
    });
    test('already excluded by Alpaca → nothing subtracted twice', () => {
        expect(removeCashMoves(days, [10, -20, 30, 5], [{ date: '2026-11-03', amount: 2500 }])).toEqual([10, -20, 30, 5]);
    });
    test('withdrawals work the same way', () => {
        expect(removeCashMoves(days, [5, -1004, 3, 1], [{ date: '2026-11-03', amount: -1000 }])).toEqual([5, -4, 3, 1]);
    });
});

test('geminiCost bills thinking tokens as output', () => {
    expect(ledger.geminiCost({ promptTokenCount: 1e6, candidatesTokenCount: 5e5, thoughtsTokenCount: 5e5 }, { inPerM: 0.3, outPerM: 2.5 })).toBeCloseTo(2.8);
    expect(ledger.geminiCost(undefined)).toBe(0);
});

test('spend pro-rates known subscriptions and lists unknown prices', async () => {
    query.mockImplementation(async sql => {
        if (/FROM api_costs/.test(sql)) return { rows: [{ service: 'gemini:pulse', calls: 100, usd: 0.5 }] };
        if (/FROM service_subscriptions/.test(sql)) return { rows: [
            { service: 'Polygon', monthly_usd: 30.4375, notes: 'market data' },
            { service: 'Finnhub', monthly_usd: null, notes: 'fundamentals' },
            { service: 'Gemini', monthly_usd: null, notes: 'metered — tracked per call' },
        ] };
        return { rows: [] };
    });
    const s = await ledger.spend('2026-11-01', '2026-11-07');
    expect(s.days).toBe(7);
    expect(s.subscriptionsUsd).toBeCloseTo(7);
    expect(s.totalUsd).toBeCloseTo(7.5);
    expect(s.unknownPrices).toEqual(['Finnhub']);
});

test('weekly report: live gains only, net = gains − cost', async () => {
    query.mockResolvedValue({ rows: [] });
    const w = await acct.buildWeek({
        now: new Date('2026-11-06T21:30:00Z'),
        deps: {
            spend: async () => ({ metered: [{ service: 'gemini:pulse', calls: 10, usd: 1 }], subscriptions: [], totalUsd: 1, unknownPrices: ['Finnhub'] }),
            summaries: async () => [
                { username: 'kmadined', summary: { isPaper: false, total: { last5: -85.5 }, last5: { total: -2 } } },
                { username: 'user', summary: { isPaper: true, total: { last5: -3600 }, last5: { total: -300 } } },
            ],
        },
    });
    expect(w.gains.totalUsd).toBe(-85.5);
    expect(w.net).toBeCloseTo(-86.5);
    const text = acct.formatMessage(w);
    expect(text).toContain('kmadined');
    expect(text).not.toContain('user:');
    expect(text).toContain('cost more than it made');
    expect(text).toContain('Finnhub');
});
