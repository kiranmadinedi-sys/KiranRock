jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cug-')), 'hb.json');
process.env.CRYPTO_HEARTBEAT_FILE = tmp;
const guard = require('../src/services/cryptoUptimeGuard');

/** 2026-09-20: alert when the crypto bot was/is dark while real positions are open. */
const NOW = new Date('2026-09-21T12:00:00Z');
const minsAgo = m => new Date(NOW.getTime() - m * 60000);

function harness({ positions = [{ symbol: 'SOL/USD', current_price: '100', stop_loss_price: '98', take_profit_price: '104' }], last } = {}) {
    const sent = [];
    return {
        sent,
        deps: {
            alertService: { sendMessage: jest.fn(async (u, m) => { sent.push({ u, m }); }) },
            cryptoDb: { getActiveUsers: async () => [{ id: 'u1' }, { id: 'u2' }], getPositions: async id => id === 'u1' ? positions : [] },
            readHeartbeat: () => last,
            writeHeartbeat: jest.fn(),
        },
    };
}

describe('cryptoUptimeGuard', () => {
    beforeEach(() => guard._resetForTests());

    test('heartbeat round-trips through the file atomically', () => {
        guard.writeHeartbeat(NOW);
        expect(guard.readHeartbeat().toISOString()).toBe(NOW.toISOString());
    });

    test('readHeartbeat tolerates a missing/corrupt file', () => {
        fs.writeFileSync(tmp, '{not json');
        expect(guard.readHeartbeat()).toBeNull();
    });

    describe('checkStartupGap', () => {
        test('long gap + open positions -> alerts only the user holding positions, with stop/TP context', async () => {
            const h = harness({ last: minsAgo(300) });
            const r = await guard.checkStartupGap({ now: NOW, deps: h.deps });
            expect(r.alerted).toBe(1);
            expect(h.sent).toHaveLength(1);
            expect(h.sent[0].u).toBe('u1');
            expect(h.sent[0].m).toContain('5h 0m');
            expect(h.sent[0].m).toContain('SOL/USD');
            expect(h.deps.writeHeartbeat).toHaveBeenCalled();
        });

        test('flags a position already beyond its stop', async () => {
            const h = harness({ last: minsAgo(60), positions: [{ symbol: 'X/USD', current_price: '9', stop_loss_price: '10', take_profit_price: '12' }] });
            await guard.checkStartupGap({ now: NOW, deps: h.deps });
            expect(h.sent[0].m).toContain('at/below stop');
        });

        test('a short gap (normal restart) sends nothing but still refreshes the heartbeat', async () => {
            const h = harness({ last: minsAgo(3) });
            const r = await guard.checkStartupGap({ now: NOW, deps: h.deps });
            expect(r.alerted).toBe(0);
            expect(h.sent).toHaveLength(0);
            expect(h.deps.writeHeartbeat).toHaveBeenCalled();
        });

        test('long gap but no open positions -> silent', async () => {
            const h = harness({ last: minsAgo(600), positions: [] });
            expect((await guard.checkStartupGap({ now: NOW, deps: h.deps })).alerted).toBe(0);
        });

        test('first ever run (no heartbeat) -> silent', async () => {
            const h = harness({ last: null });
            expect((await guard.checkStartupGap({ now: NOW, deps: h.deps })).alerted).toBe(0);
        });

        test('a failing alert never throws and still writes the heartbeat', async () => {
            const h = harness({ last: minsAgo(300) });
            h.deps.alertService.sendMessage = jest.fn().mockRejectedValue(new Error('telegram down'));
            await expect(guard.checkStartupGap({ now: NOW, deps: h.deps })).resolves.toBeDefined();
            expect(h.deps.writeHeartbeat).toHaveBeenCalled();
        });
    });

    describe('runLiveWatchdog', () => {
        test('fresh heartbeat -> no alert', async () => {
            const h = harness({ last: minsAgo(4) });
            expect((await guard.runLiveWatchdog({ now: NOW, deps: h.deps })).alerted).toBe(0);
        });

        test('stale heartbeat with open positions -> alerts once per outage, not every tick', async () => {
            const h = harness({ last: minsAgo(45) });
            expect((await guard.runLiveWatchdog({ now: NOW, deps: h.deps })).alerted).toBe(1);
            expect((await guard.runLiveWatchdog({ now: new Date(NOW.getTime() + 300000), deps: h.deps })).alerted).toBe(0);
            expect(h.sent).toHaveLength(1);
            expect(h.sent[0].m).toContain('stopped responding');
        });

        test('recovers: after a fresh heartbeat, a later outage alerts again', async () => {
            const h = harness({ last: minsAgo(45) });
            await guard.runLiveWatchdog({ now: NOW, deps: h.deps });
            h.deps.readHeartbeat = () => minsAgo(1);
            await guard.runLiveWatchdog({ now: NOW, deps: h.deps }); // healthy again -> resets
            h.deps.readHeartbeat = () => minsAgo(50);
            expect((await guard.runLiveWatchdog({ now: NOW, deps: h.deps })).alerted).toBe(1);
        });

        test('stale but nothing held -> silent; no heartbeat file yet -> silent', async () => {
            expect((await guard.runLiveWatchdog({ now: NOW, deps: harness({ last: minsAgo(90), positions: [] }).deps })).alerted).toBe(0);
            expect((await guard.runLiveWatchdog({ now: NOW, deps: harness({ last: null }).deps })).reason).toBe('no-heartbeat-yet');
        });
    });
});
