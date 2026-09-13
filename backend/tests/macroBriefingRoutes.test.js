jest.mock('../src/services/macroRiskService', () => ({
    recordDailyRiskFlag: jest.fn(),
    VALID_LEVELS: ['Calm', 'Elevated', 'High', 'Extreme', 'Panic'],
}));
jest.mock('../src/services/telegramAlertService', () => ({
    sendTelegramMessage: jest.fn(),
}));
jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

/**
 * Added 2026-09-14: GET /api/internal/macro-briefing is called by a
 * scheduled cloud agent with no user session (api.telegram.org is
 * unreachable from that sandbox, so the backend sends Telegram on its
 * behalf and also records the risk flag for the trading bot). Gated by a
 * shared secret, not the normal `protect` user-auth middleware.
 *
 * No supertest in this project — the route handler is invoked directly via
 * the router's own stack, matching this codebase's existing lightweight
 * testing style for services.
 *
 * The route reads TELEGRAM_CHAT_ID at module-load time, not per-request, so
 * everything (env vars, the mocked deps, and the route itself) is loaded
 * fresh inside beforeEach via jest.resetModules() — reusing a module
 * required before process.env was set would silently freeze the wrong value.
 */
function loadFresh() {
    jest.resetModules();
    const macroRiskService = require('../src/services/macroRiskService');
    const telegramAlertService = require('../src/services/telegramAlertService');
    const router = require('../src/routes/macroBriefingRoutes');
    const layer = router.stack.find(l => l.route && l.route.path === '/macro-briefing');
    return { handler: layer.route.stack[0].handle, macroRiskService, telegramAlertService };
}

function mockRes() {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
}

describe('GET /api/internal/macro-briefing', () => {
    const OLD_ENV = process.env;
    let handler, macroRiskService, telegramAlertService;

    beforeEach(() => {
        process.env = { ...OLD_ENV, MACRO_BRIEFING_INGEST_SECRET: 'test-secret', TELEGRAM_CHAT_ID: 'chat-123' };
        ({ handler, macroRiskService, telegramAlertService } = loadFresh());
        macroRiskService.recordDailyRiskFlag.mockResolvedValue();
        telegramAlertService.sendTelegramMessage.mockResolvedValue(true);
    });

    afterAll(() => {
        process.env = OLD_ENV;
    });

    test('rejects a request with the wrong secret', async () => {
        const req = { query: { secret: 'wrong', message: 'hi', risk_level: 'Calm' }, ip: '1.2.3.4' };
        const res = mockRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(401);
        expect(macroRiskService.recordDailyRiskFlag).not.toHaveBeenCalled();
    });

    test('rejects a missing risk_level', async () => {
        const req = { query: { secret: 'test-secret', message: 'hi' }, ip: '1.2.3.4' };
        const res = mockRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(400);
        expect(macroRiskService.recordDailyRiskFlag).not.toHaveBeenCalled();
    });

    test('records the flag and sends the Telegram message on a valid request', async () => {
        const req = { query: { secret: 'test-secret', message: 'Today looks calm', risk_level: 'Calm' }, ip: '1.2.3.4' };
        const res = mockRes();
        await handler(req, res);

        expect(macroRiskService.recordDailyRiskFlag).toHaveBeenCalledWith({ riskLevel: 'Calm', message: 'Today looks calm' });
        expect(telegramAlertService.sendTelegramMessage).toHaveBeenCalledWith('chat-123', 'Today looks calm');
        expect(res.json).toHaveBeenCalledWith({ ok: true, telegramSent: true });
    });

    test('still records the flag even if the Telegram send fails, and reports it in the response', async () => {
        telegramAlertService.sendTelegramMessage.mockRejectedValue(new Error('network error'));
        const req = { query: { secret: 'test-secret', message: 'Today looks calm', risk_level: 'Calm' }, ip: '1.2.3.4' };
        const res = mockRes();
        await handler(req, res);

        expect(macroRiskService.recordDailyRiskFlag).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith({ ok: true, telegramSent: false });
    });

    test('returns 500 if storing the flag fails, without attempting the Telegram send', async () => {
        macroRiskService.recordDailyRiskFlag.mockRejectedValue(new Error('db down'));
        const req = { query: { secret: 'test-secret', message: 'Today looks calm', risk_level: 'Calm' }, ip: '1.2.3.4' };
        const res = mockRes();
        await handler(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(telegramAlertService.sendTelegramMessage).not.toHaveBeenCalled();
    });

    test('returns 503 if the secret itself is not configured on the server', async () => {
        process.env = { ...OLD_ENV, TELEGRAM_CHAT_ID: 'chat-123' };
        delete process.env.MACRO_BRIEFING_INGEST_SECRET;
        ({ handler, macroRiskService } = loadFresh());
        const req = { query: { secret: 'anything', message: 'hi', risk_level: 'Calm' }, ip: '1.2.3.4' };
        const res = mockRes();
        await handler(req, res);
        expect(res.status).toHaveBeenCalledWith(503);
    });
});
