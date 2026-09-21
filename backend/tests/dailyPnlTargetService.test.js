jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const svc = require('../src/services/dailyPnlTargetService');

const NOW = new Date('2026-09-18T21:00:00Z'); // Friday

describe('dailyPnlTargetService (2026-09-20)', () => {
    test('tradingDayKeys skips weekends and holidays', () => {
        // Mon 9/14 .. Sun 9/20, with Wed 9/16 pretend-holiday
        const keys = svc.tradingDayKeys(new Date('2026-09-14T00:00:00Z'), new Date('2026-09-20T00:00:00Z'),
            d => d.toISOString().startsWith('2026-09-16'));
        expect(keys).toEqual(['2026-09-14', '2026-09-15', '2026-09-17', '2026-09-18']);
    });

    test('summarizeWindow divides by trading days (not just days with closes) and counts green/red', () => {
        const keys = ['2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18'];
        const s = svc.summarizeWindow([
            { day: '2026-09-14', pnl: 30, trades: 2 },
            { day: '2026-09-16', pnl: -10, trades: 1 },
        ], keys);
        expect(s.total).toBe(20);
        expect(s.avgPerDay).toBe(4);           // 20 / 5 days, idle days count as $0
        expect(s.greenDays).toBe(1);
        expect(s.redDays).toBe(1);
        expect(s.closedTrades).toBe(3);
    });

    test('summarizeWindow with no days is safe', () => {
        expect(svc.summarizeWindow([], []).avgPerDay).toBe(0);
    });

    function deps(rows, cryptoRows = [], cash = { equity: 7000, cash: 5000, cashPct: 71, isPaper: false }) {
        return { realizedByDay: async () => rows, cryptoByDay: async () => cryptoRows, cashInfo: async () => cash, isHoliday: () => false };
    }

    test('buildAccountSummary computes 5-day vs 4-week averages from realized rows', async () => {
        const s = await svc.buildAccountSummary('u1', { now: NOW, deps: deps([
            { day: '2026-09-18', pnl: 50, trades: 3 },
            { day: '2026-09-02', pnl: -100, trades: 4 },
        ]) });
        expect(s.last5.total).toBe(50);
        expect(s.last5.avgPerDay).toBe(10);
        expect(s.last28.total).toBe(-50);
        expect(s.isPaper).toBe(false);
        expect(s.cashPct).toBe(71);
    });

    test('crypto is reported separately per calendar day, not mixed into stock $/trading-day', async () => {
        const s = await svc.buildAccountSummary('u1', { now: NOW, deps: deps([], [{ day: '2026-09-10', pnl: 280, trades: 5 }]) });
        expect(s.last28.total).toBe(0);
        expect(s.crypto.total28).toBe(280);
        expect(s.crypto.avgPerCalendarDay).toBe(10);
    });

    test('combined message totals only LIVE accounts against the target and the $100 goal', () => {
        const mk = (avg5, avg28, paper) => ({ isPaper: paper, equity: 5000, cashPct: 60,
            last5: { avgPerDay: avg5 }, last28: { avgPerDay: avg28 } });
        const msg = svc.formatCombinedMessage([
            { username: 'kmadined', summary: mk(10, 5, false) },
            { username: 'Parvataneni', summary: mk(2, 1, false) },
            { username: 'user', summary: mk(-50, -40, true) },
        ], { target: 15, stretch: 100 });
        expect(msg).toContain('+$6.00/day');   // live combined 4w = 5 + 1, paper excluded
        expect(msg).toContain('at 40%');       // 6 / 15 of realistic target
        expect(msg).toContain('at 6%');        // 6 / 100 of the stretch goal
        expect(msg).toContain('Paper (no real money)');
    });

    describe('sendWeeklyPnlReports privacy + filtering', () => {
        function harness() {
            const sent = [];
            const alertService = {
                getUserTelegramChatId: async id => `chat-${id}`,
                sendTelegramMessage: async (chat, text) => { sent.push({ chat, text }); },
                sendAdminMessage: async text => { sent.push({ chat: 'ADMIN', text }); },
            };
            const d = {
                alertService,
                listUsers: async () => [{ id: 'a', username: 'alice' }, { id: 'b', username: 'bob' }, { id: 'idle', username: 'idle' }],
                realizedByDay: async id => id === 'idle' ? [] : [{ day: '2026-09-18', pnl: id === 'a' ? 12 : -3, trades: 1 }],
                cryptoByDay: async () => [], isHoliday: () => false,
                cashInfo: async () => ({ equity: 1000, cash: 500, cashPct: 50, isPaper: false }),
            };
            return { sent, d };
        }

        test('each user only ever receives their own numbers; combined view goes to admin only', async () => {
            const { sent, d } = harness();
            await svc.sendWeeklyPnlReports({ now: NOW, deps: d });
            const alice = sent.find(m => m.chat === 'chat-a');
            const bob = sent.find(m => m.chat === 'chat-b');
            expect(alice.text).toContain('alice');
            expect(alice.text).not.toContain('bob');
            expect(bob.text).not.toContain('alice');
            const admin = sent.filter(m => m.chat === 'ADMIN');
            expect(admin).toHaveLength(1);
            expect(admin[0].text).toContain('alice');
            expect(admin[0].text).toContain('bob');
        });

        test('accounts with no closed trades are skipped entirely (no empty reports)', async () => {
            const { sent, d } = harness();
            const r = await svc.sendWeeklyPnlReports({ now: NOW, deps: d });
            expect(r.accounts).toBe(2);
            expect(sent.find(m => m.chat === 'chat-idle')).toBeUndefined();
        });
    });
});
