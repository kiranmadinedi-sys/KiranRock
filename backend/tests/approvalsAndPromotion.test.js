/** Real-money approvals + automatic paper promotion (2026-10-17). */
describe('approvalService', () => {
    let approvals, query, alert, strategy;
    let rows;

    beforeEach(() => {
        jest.resetModules();
        rows = [];
        jest.doMock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
        jest.doMock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));
        jest.doMock('../src/services/strategySettingsService', () => ({ setSelectionMethod: jest.fn().mockResolvedValue() }));
        jest.doMock('../src/config/database', () => ({
            query: jest.fn(async (sql, p) => {
                if (/INSERT INTO approval_requests/.test(sql)) {
                    if (rows.some(r => r.user_id === p[0] && r.kind === p[1] && r.request_key === p[2] && r.status === 'pending')) return { rows: [] };
                    const r = { id: rows.length + 1, user_id: p[0], kind: p[1], request_key: p[2], title: p[3], message: p[4], payload: JSON.parse(p[5]), status: 'pending' };
                    rows.push(r); return { rows: [r] };
                }
                if (/SELECT \* FROM approval_requests WHERE id = \$1 AND user_id = \$2/.test(sql)) return { rows: rows.filter(r => r.id === p[0] && r.user_id === p[1]) };
                if (/SELECT \* FROM approval_requests WHERE user_id/.test(sql)) return { rows: rows.filter(r => r.user_id === p[0] && r.status === 'pending') };
                if (/UPDATE approval_requests SET status = '(\w+)'/.test(sql) && /WHERE id = \$1/.test(sql)) {
                    const st = sql.match(/status = '(\w+)'/)[1]; const r = rows.find(x => x.id === p[0]); if (r) r.status = st; return { rows: [] };
                }
                return { rows: [] };
            }),
        }));
        approvals = require('../src/services/approvalService');
        query = require('../src/config/database').query;
        alert = require('../src/services/telegramAlertService');
        strategy = require('../src/services/strategySettingsService');
    });

    const req = { userId: 'live-1', kind: 'selection_method', key: 'oversold', title: 'Use Oversold', message: 'evidence', payload: { method: 'oversold' } };

    test('a request is created once and announced on Telegram', async () => {
        expect((await approvals.createRequest(req)).created).toBe(true);
        expect((await approvals.createRequest(req)).created).toBe(false);
        expect(alert.sendMessage).toHaveBeenCalledTimes(1);
        expect(alert.sendMessage.mock.calls[0][1]).toMatch(/Approval needed/);
    });

    test('nothing changes until the owner approves; approving applies the change', async () => {
        const { request } = await approvals.createRequest(req);
        expect(strategy.setSelectionMethod).not.toHaveBeenCalled();
        const out = await approvals.decide('live-1', request.id, true);
        expect(out.status).toBe('approved');
        expect(strategy.setSelectionMethod).toHaveBeenCalledWith('live-1', 'oversold', 'approved');
    });

    test('rejecting changes nothing; another user cannot decide it', async () => {
        const { request } = await approvals.createRequest(req);
        await expect(approvals.decide('someone-else', request.id, true)).rejects.toThrow(/not found/);
        expect((await approvals.decide('live-1', request.id, false)).status).toBe('rejected');
        expect(strategy.setSelectionMethod).not.toHaveBeenCalled();
        await expect(approvals.decide('live-1', request.id, true)).rejects.toThrow(/already rejected/);
    });
});

describe('promotionService.evaluateArms', () => {
    test('passes only with enough days, +1pp per pick, and a win rate not lower than control', async () => {
        jest.resetModules();
        const days = Array.from({ length: 16 }, (_, i) => `2026-11-${String(i + 1).padStart(2, '0')}`);
        const data = [];
        for (const d of days) {
            data.push({ d, arm: 'control', r5: 0.5 }, { d, arm: 'control', r5: -0.5 });       // avg 0, 50% win
            data.push({ d, arm: 'insider', r5: 2.0 }, { d, arm: 'insider', r5: 0.5 });        // avg +1.25, 100% win
            data.push({ d, arm: 'steady', r5: 3.0 }, { d, arm: 'steady', r5: -0.6 });         // avg +1.2, but 50% win → equal, passes
        }
        data.push({ d: '2026-11-17', arm: 'oversold', r5: 9 }, { d: '2026-11-17', arm: 'control', r5: 0 }); // 1 day only
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: data }) }));
        jest.doMock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
        const { evaluateArms } = require('../src/services/promotionService');
        const arms = await evaluateArms();
        expect(arms.insider).toMatchObject({ days: 16, edgePp: 1.25, passes: true });
        expect(arms.oversold).toMatchObject({ days: 1, passes: false, status: 'needs 14 more days' });
        expect(arms.steady.passes).toBe(true);
    });
});

describe('promotionService.liveApprovalUsers', () => {
    afterEach(() => { delete process.env.LIVE_APPROVAL_USER_IDS; });

    test('defaults to every active live account (each owner decides for their own)', async () => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [{ id: 'kmadined-id' }, { id: 'anil-id' }] }) }));
        const { liveApprovalUsers } = require('../src/services/promotionService');
        const query = require('../src/config/database').query;
        expect(await liveApprovalUsers()).toEqual(['kmadined-id', 'anil-id']);
        expect(query.mock.calls[0][0]).toMatch(/alpaca_paper = false/);
    });

    test('LIVE_APPROVAL_USER_IDS restricts it to a list', async () => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        process.env.LIVE_APPROVAL_USER_IDS = 'only-me';
        const { liveApprovalUsers } = require('../src/services/promotionService');
        expect(await liveApprovalUsers()).toEqual(['only-me']);
    });
});
