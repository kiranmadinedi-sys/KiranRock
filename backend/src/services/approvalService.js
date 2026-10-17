/**
 * Approval requests for real-money changes (2026-10-17, the user's rule): the platform
 * may test and promote improvements on the PAPER account by itself, but anything that
 * changes how a LIVE account trades waits for the owner's explicit approval.
 *
 * A request is stored once (same user + kind + key while pending), announced on Telegram,
 * shown as a popup on the website until decided, and re-announced every trading morning.
 * Approving runs the change; rejecting just closes it. Requests expire after 14 days.
 *
 * Kinds:
 *   selection_method — payload { method }: switch the account's stock-picking method
 *   core_enable      — payload { holdings: [{symbol, targetPct}], cashReservePct }: turn on core holdings
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const EXPIRE_DAYS = 14;

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS approval_requests (
            id               SERIAL      PRIMARY KEY,
            user_id          TEXT        NOT NULL,
            kind             TEXT        NOT NULL,
            request_key      TEXT        NOT NULL,
            title            TEXT        NOT NULL,
            message          TEXT        NOT NULL,
            payload          JSONB       NOT NULL DEFAULT '{}',
            status           TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'failed')),
            result           TEXT,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            decided_at       TIMESTAMPTZ,
            last_reminded_at TIMESTAMPTZ
        )`);
    await query(`CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_one_pending
                 ON approval_requests (user_id, kind, request_key) WHERE status = 'pending'`);
    _ready = true;
}

function _telegram(userId, text) {
    try {
        const alertService = require('./telegramAlertService');
        return alertService.sendMessage(userId, text).catch(() => {});
    } catch (_) { return Promise.resolve(); }
}

/** Create (or keep the existing pending) request. Returns the row and whether it is new. */
async function createRequest({ userId, kind, key, title, message, payload = {} }) {
    await ensureTable();
    const r = await query(
        `INSERT INTO approval_requests (user_id, kind, request_key, title, message, payload)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, kind, request_key) WHERE status = 'pending' DO NOTHING
         RETURNING *`,
        [String(userId), kind, key, title, message, JSON.stringify(payload)]
    );
    if (!r.rows.length) {
        const existing = await query(`SELECT * FROM approval_requests WHERE user_id = $1 AND kind = $2 AND request_key = $3 AND status = 'pending'`, [String(userId), kind, key]);
        return { request: existing.rows[0], created: false };
    }
    const req = r.rows[0];
    logger.info('[Approval] Request created', { id: req.id, userId, kind, key });
    await _telegram(userId, `🔔 *Approval needed* — ${title}\n\n${message}\n\nOpen the website to Approve or Reject (it shows as a popup).`);
    return { request: req, created: true };
}

async function listPending(userId) {
    await ensureTable();
    await query(`UPDATE approval_requests SET status = 'expired', decided_at = NOW()
                 WHERE status = 'pending' AND created_at < NOW() - ($1::int * INTERVAL '1 day')`, [EXPIRE_DAYS]);
    const r = await query(`SELECT id, kind, title, message, payload, created_at FROM approval_requests
                           WHERE user_id = $1 AND status = 'pending' ORDER BY created_at`, [String(userId)]);
    return r.rows;
}

/** The change each kind makes when approved. */
const HANDLERS = {
    async selection_method(userId, payload) {
        await require('./strategySettingsService').setSelectionMethod(userId, payload.method, 'approved');
        return `Stock-picking method is now "${payload.method}".`;
    },
    async exit_profile(userId, payload) {
        await require('./strategySettingsService').setExitProfile(userId, payload.profile, 'approved');
        return `Exit profile is now "${payload.profile}".`;
    },
    async core_enable(userId, payload) {
        const core = require('./coreHoldingsService');
        await core.saveConfig(userId, { holdings: payload.holdings, cashReservePct: payload.cashReservePct });
        await core.setEnabled(userId, true);
        return `Core holdings enabled: ${payload.holdings.map(h => `${h.symbol} ${h.targetPct}%`).join(', ')}. First buys after 10:00 AM ET on the next trading day.`;
    },
};

/** Approve or reject one of the user's own pending requests. */
async function decide(userId, id, approve) {
    await ensureTable();
    const r = await query(`SELECT * FROM approval_requests WHERE id = $1 AND user_id = $2`, [id, String(userId)]);
    const req = r.rows[0];
    if (!req) { const e = new Error('Request not found'); e.status = 404; throw e; }
    if (req.status !== 'pending') { const e = new Error(`Request is already ${req.status}`); e.status = 409; throw e; }
    if (!approve) {
        await query(`UPDATE approval_requests SET status = 'rejected', decided_at = NOW() WHERE id = $1`, [id]);
        logger.info('[Approval] Rejected', { id, userId, kind: req.kind });
        return { status: 'rejected' };
    }
    const handler = HANDLERS[req.kind];
    try {
        if (!handler) throw new Error(`No handler for ${req.kind}`);
        const result = await handler(userId, req.payload || {});
        await query(`UPDATE approval_requests SET status = 'approved', decided_at = NOW(), result = $2 WHERE id = $1`, [id, result]);
        logger.info('[Approval] Approved and applied', { id, userId, kind: req.kind, result });
        await _telegram(userId, `✅ *Approved* — ${req.title}\n${result}`);
        return { status: 'approved', result };
    } catch (err) {
        await query(`UPDATE approval_requests SET status = 'failed', decided_at = NOW(), result = $2 WHERE id = $1`, [id, err.message]);
        logger.warn('[Approval] Approved but applying failed', { id, userId, kind: req.kind, error: err.message });
        return { status: 'failed', result: err.message };
    }
}

/** Trading mornings: re-announce anything still waiting (once a day per request). */
async function remindPending(now = new Date()) {
    await ensureTable();
    const r = await query(`SELECT * FROM approval_requests WHERE status = 'pending'
                           AND created_at > NOW() - ($1::int * INTERVAL '1 day')
                           AND (last_reminded_at IS NULL OR last_reminded_at < NOW() - INTERVAL '20 hours')
                           AND created_at < NOW() - INTERVAL '12 hours'`, [EXPIRE_DAYS]);
    for (const req of r.rows) {
        await _telegram(req.user_id, `⏰ *Reminder — approval still needed:* ${req.title}\nOpen the website to Approve or Reject.`);
        await query(`UPDATE approval_requests SET last_reminded_at = NOW() WHERE id = $1`, [req.id]);
    }
    return r.rows.length;
}

module.exports = { ensureTable, createRequest, listPending, decide, remindPending, HANDLERS };
