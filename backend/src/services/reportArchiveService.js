/**
 * Report archive (2026-10-24) — every scheduled report (Saturday market study + strategy review,
 * weekly $/day scoreboard, daily trading summary, macro briefing, promotion check) is stored
 * here as well as sent to Telegram, so the Reports page can browse them historically.
 *
 * Visibility: user_id set → only that user. user_id NULL → everyone, unless admin_only.
 * Saving never throws — a failed archive write must not block a Telegram report.
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const KINDS = {
    market_study: 'Saturday market study',
    promotion_check: 'Promotion check',
    pnl_scoreboard: 'Weekly $/day scoreboard',
    daily_summary: 'Daily trading summary',
    macro_briefing: 'Macro briefing',
    premarket_brief: 'Pre-market overnight check',
    core_watchlist: 'Core watchlist',
};

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS report_archive (
            id          SERIAL      PRIMARY KEY,
            kind        TEXT        NOT NULL,
            title       TEXT        NOT NULL,
            body        TEXT        NOT NULL,
            format      TEXT        NOT NULL DEFAULT 'markdown' CHECK (format IN ('markdown', 'html')),
            user_id     TEXT,
            admin_only  BOOLEAN     NOT NULL DEFAULT false,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await query(`CREATE INDEX IF NOT EXISTS idx_report_archive_kind_time ON report_archive (kind, created_at DESC)`);
    _ready = true;
}

async function save({ kind, title, body, format = 'markdown', userId = null, adminOnly = false }) {
    try {
        if (!body) return;
        // Jest sets NODE_ENV=test; route/service tests must never write into the real archive.
        if (process.env.NODE_ENV === 'test' && !process.env.REPORT_ARCHIVE_IN_TESTS) return;
        await ensureTable();
        await query(
            `INSERT INTO report_archive (kind, title, body, format, user_id, admin_only) VALUES ($1, $2, $3, $4, $5, $6)`,
            [kind, title || KINDS[kind] || kind, String(body), format, userId == null ? null : String(userId), !!adminOnly]);
    } catch (err) {
        logger.warn('[ReportArchive] Save failed (non-blocking)', { kind, error: err.message });
    }
}

const VISIBLE_SQL = `(user_id = $1 OR (user_id IS NULL AND (NOT admin_only OR $2)))`;

async function list(userId, isAdmin, { kind = null, limit = 200 } = {}) {
    await ensureTable();
    const params = [String(userId), !!isAdmin, Math.min(Number(limit) || 200, 500)];
    let where = VISIBLE_SQL;
    if (kind) { params.push(kind); where += ` AND kind = $4`; }
    const r = await query(
        `SELECT id, kind, title, created_at, user_id IS NOT NULL AS personal FROM report_archive
         WHERE ${where} ORDER BY created_at DESC LIMIT $3`, params);
    return r.rows;
}

async function get(userId, isAdmin, id) {
    await ensureTable();
    const r = await query(`SELECT * FROM report_archive WHERE id = $3 AND ${VISIBLE_SQL}`, [String(userId), !!isAdmin, Number(id)]);
    return r.rows[0] || null;
}

module.exports = { KINDS, ensureTable, save, list, get };
