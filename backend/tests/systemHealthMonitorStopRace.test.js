/**
 * 2026-10-12: the health monitor's missing-stop check raced the bot's StopRepair. While
 * StopRepair was mid cancel→place raising a stop, this check saw "no stop" and placed
 * its own 7%-below-entry stop into the gap — moving the stop DOWN (2026-10-09 GME
 * 24.07→23.78, kmadined BUG 46.52→44.98) and making StopRepair log a false CRITICAL.
 */
describe('systemHealthMonitor — no longer races StopRepair', () => {
    let axios, broker, lock, monitor;

    const POS = (symbol, extra = {}) => ({
        symbol, qty: '5', avg_entry_price: '25.57', current_price: '26.00', unrealized_plpc: '0.01', ...extra,
    });

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('axios', () => ({ get: jest.fn(), post: jest.fn(), delete: jest.fn() }));
        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        jest.doMock('../src/services/userDatabaseService', () => ({
            getUserAlpacaCredentials: jest.fn().mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: true }),
        }));
        jest.doMock('../src/services/brokerService', () => ({ getOpenOrders: jest.fn() }));
        jest.doMock('../src/services/coreHoldingsService', () => ({ getCoreSymbols: jest.fn().mockResolvedValue(new Set()) }));

        axios   = require('axios');
        broker  = require('../src/services/brokerService');
        lock    = require('../src/utils/stopOrderLock');
        monitor = require('../src/services/systemHealthMonitorService');
    });

    function mockPositions(list) {
        axios.get.mockImplementation((url) => {
            if (url.endsWith('/v2/positions')) return Promise.resolve({ data: list });
            const sym = url.split('/').pop();
            const p = list.find(x => x.symbol === sym);
            return p ? Promise.resolve({ data: p }) : Promise.reject(new Error('404'));
        });
        axios.post.mockResolvedValue({ data: { id: 'new', side: 'sell' } });
    }

    test('skips a symbol StopRepair has marked mid-swap (the GME/BUG race)', async () => {
        mockPositions([POS('GME')]);
        broker.getOpenOrders.mockResolvedValue([]); // old stop canceled, new one not yet placed
        lock.markStopChange('u1', 'GME');

        await monitor.checkAndFixStops('u1');
        await monitor.checkAndFixStops('u1'); // even on a second sweep

        expect(axios.post).not.toHaveBeenCalled();
    });

    test('a stop missing on only ONE sweep is left to StopRepair', async () => {
        mockPositions([POS('GME')]);
        broker.getOpenOrders.mockResolvedValue([]);

        const r = await monitor.checkAndFixStops('u1');

        expect(axios.post).not.toHaveBeenCalled();
        expect(r).toEqual({ issue: null, fixed: null });
    });

    test('a stop still missing on the NEXT sweep gets the backstop stop', async () => {
        mockPositions([POS('GME')]);
        broker.getOpenOrders.mockResolvedValue([]);

        await monitor.checkAndFixStops('u1');
        const r = await monitor.checkAndFixStops('u1');

        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(axios.post.mock.calls[0][1]).toMatchObject({ symbol: 'GME', type: 'stop', stop_price: '23.78' });
        expect(r.fixed).toContain('GME');
    });

    test('a stop that reappears between sweeps resets the confirmation', async () => {
        mockPositions([POS('GME')]);
        broker.getOpenOrders.mockResolvedValueOnce([]); // sweep 1: gap
        broker.getOpenOrders.mockResolvedValueOnce([{ symbol: 'GME', side: 'sell', type: 'stop', status: 'new' }]); // sweep 2: fixed
        broker.getOpenOrders.mockResolvedValueOnce([]); // sweep 3: a NEW gap — must not act yet

        await monitor.checkAndFixStops('u1');
        await monitor.checkAndFixStops('u1');
        await monitor.checkAndFixStops('u1');

        expect(axios.post).not.toHaveBeenCalled();
    });

    test('a "held" bracket stop leg counts as protection (status=open used to hide it)', async () => {
        mockPositions([POS('RXO')]);
        broker.getOpenOrders.mockResolvedValue([{ symbol: 'RXO', side: 'sell', type: 'stop', status: 'held', order_class: 'bracket' }]);

        await monitor.checkAndFixStops('u1');
        await monitor.checkAndFixStops('u1');

        expect(axios.post).not.toHaveBeenCalled();
    });

    test('crypto positions are never given a stock-style stop (crypto manages its own exits)', async () => {
        mockPositions([POS('SHIBUSD', { asset_class: 'crypto', qty: '1000000' })]);
        broker.getOpenOrders.mockResolvedValue([]);

        await monitor.checkAndFixStops('u1');
        const r = await monitor.checkAndFixStops('u1');

        expect(axios.post).not.toHaveBeenCalled();
        expect(r).toEqual({ issue: null, fixed: null });
    });

    test('core holdings never get a stop, even when missing on two sweeps', async () => {
        mockPositions([POS('SPY')]);
        broker.getOpenOrders.mockResolvedValue([]);
        require('../src/services/coreHoldingsService').getCoreSymbols.mockResolvedValue(new Set(['SPY']));

        await monitor.checkAndFixStops('u1');
        await monitor.checkAndFixStops('u1');

        expect(axios.post).not.toHaveBeenCalled();
    });

    test('a failed order fetch throws instead of reading as "nothing is protected"', async () => {
        mockPositions([POS('GME')]);
        broker.getOpenOrders.mockRejectedValue(new Error('pool timeout'));

        await expect(monitor.checkAndFixStops('u1')).rejects.toThrow('pool timeout');
        expect(axios.post).not.toHaveBeenCalled();
    });

    describe('upgradeTrailingStops', () => {
        test('does not swap a stop StopRepair is mid-updating', async () => {
            mockPositions([POS('NVDA', { qty: '3', current_price: '200', unrealized_plpc: '0.08' })]);
            broker.getOpenOrders.mockResolvedValue([{ id: 'o1', symbol: 'NVDA', side: 'sell', type: 'stop', stop_price: '150', status: 'new' }]);
            lock.markStopChange('u1', 'NVDA');

            await monitor.upgradeTrailingStops('u1');

            expect(axios.delete).not.toHaveBeenCalled();
            expect(axios.post).not.toHaveBeenCalled();
        });

        test('never cancels a bracket leg to swap in a trailing stop', async () => {
            mockPositions([POS('NVDA', { qty: '3', current_price: '200', unrealized_plpc: '0.08' })]);
            broker.getOpenOrders.mockResolvedValue([{ id: 'o1', symbol: 'NVDA', side: 'sell', type: 'stop', stop_price: '150', status: 'held', order_class: 'bracket' }]);

            await monitor.upgradeTrailingStops('u1');

            expect(axios.delete).not.toHaveBeenCalled();
        });

        test('marks its own swap for StopRepair, and clears the mark afterwards', async () => {
            mockPositions([POS('NVDA', { qty: '3', current_price: '200', unrealized_plpc: '0.08' })]);
            broker.getOpenOrders.mockResolvedValue([{ id: 'o1', symbol: 'NVDA', side: 'sell', type: 'stop', stop_price: '150', status: 'new' }]);
            let markedDuringSwap = null;
            axios.delete.mockImplementation(() => {
                markedDuringSwap = lock.isStopChangeInProgress('u1', 'NVDA');
                return Promise.resolve({});
            });

            await monitor.upgradeTrailingStops('u1');

            expect(markedDuringSwap).toBe(true);
            expect(lock.isStopChangeInProgress('u1', 'NVDA')).toBe(false);
            expect(axios.post.mock.calls[0][1]).toMatchObject({ symbol: 'NVDA', type: 'trailing_stop' });
        });
    });
});
