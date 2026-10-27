/** Blitz entry orders (2026-10-27): cancel on poll timeout, skip while a buy is still open. */
jest.mock('axios');
jest.mock('../src/services/userDatabaseService', () => ({
    getUserAlpacaCredentials: jest.fn(async () => ({ isPaper: true, keyId: 'k', secretKey: 's' })),
}));
jest.mock('../src/services/brokerService', () => ({
    getPositions: jest.fn(async () => []),
    getOpenOrders: jest.fn(async () => []),
    placeStopOrder: jest.fn(async () => ({})),
}));
jest.mock('../src/services/intradayDatabaseService', () => ({ openPosition: jest.fn(async (u, s, p) => ({ symbol: s, ...p })) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const axios = require('axios');
const broker = require('../src/services/brokerService');
const intradayDb = require('../src/services/intradayDatabaseService');
const { buyIntraday } = require('../src/services/intradayBrokerService');

const opts = { stopLossPercent: 2, takeProfitPercent: 4 };

beforeEach(() => {
    jest.clearAllMocks();
    require('../src/services/userDatabaseService').getUserAlpacaCredentials.mockResolvedValue({ isPaper: true, keyId: 'k', secretKey: 's' });
    broker.getPositions.mockResolvedValue([]);
    broker.getOpenOrders.mockResolvedValue([]);
    broker.placeStopOrder.mockResolvedValue({});
    intradayDb.openPosition.mockImplementation(async (u, s, p) => ({ symbol: s, ...p }));
    jest.spyOn(global, 'setTimeout').mockImplementation(fn => { fn(); return 0; });
    axios.post.mockResolvedValue({ data: { id: 'o1', status: 'new', filled_qty: '0' } });
    axios.delete.mockResolvedValue({});
});
afterEach(() => global.setTimeout.mockRestore());

test('skips entry while a buy order for the symbol is still open', async () => {
    broker.getOpenOrders.mockResolvedValueOnce([{ id: 'old', symbol: 'AMD', side: 'buy' }]);
    expect(await buyIntraday('u', 'AMD', 2, opts)).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
});

test('skips entry when the open-order check fails (fail closed)', async () => {
    broker.getOpenOrders.mockRejectedValueOnce(new Error('timeout'));
    expect(await buyIntraday('u', 'AMD', 2, opts)).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
});

test('unfilled order is cancelled, not abandoned', async () => {
    axios.get.mockImplementation(async () => ({
        data: axios.delete.mock.calls.length ? { id: 'o1', status: 'canceled', filled_qty: '0' } : { id: 'o1', status: 'new', filled_qty: '0' },
    }));
    expect(await buyIntraday('u', 'AMD', 2, opts)).toBeNull();
    expect(axios.delete).toHaveBeenCalledWith(expect.stringContaining('/orders/o1'), expect.anything());
    expect(intradayDb.openPosition).not.toHaveBeenCalled();
});

test('a fill that lands during the cancel is tracked with its real qty and price', async () => {
    axios.get.mockImplementation(async () => ({
        data: axios.delete.mock.calls.length
            ? { id: 'o1', status: 'canceled', filled_qty: '1', filled_avg_price: '543.50' }
            : { id: 'o1', status: 'new', filled_qty: '0' },
    }));
    const pos = await buyIntraday('u', 'AMD', 2, opts);
    expect(intradayDb.openPosition).toHaveBeenCalledWith('u', 'AMD', expect.objectContaining({ quantity: 1, price: 543.5, brokerOrderId: 'o1' }));
    expect(broker.placeStopOrder).toHaveBeenCalledWith('u', 'AMD', 1, expect.any(Number));
    expect(pos).toBeTruthy();
});
