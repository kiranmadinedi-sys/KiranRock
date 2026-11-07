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
    core_guidance: 'Core guidance',
    accountability: 'Weekly accountability (cost vs gains)',
    mistake_review: 'Daily mistake review',
    research_lab: 'Research lab',
    portfolio_lab: 'Portfolio lab',
    prediction_check: 'Score edge check',
    news_rescan: 'News rescan alert',
    telegram: 'All Telegram messages',
};

// Raw Telegram copies (~130/day: trade alerts, health, scan status). Kept out of the "All"
// view so the curated reports aren't buried; the 'telegram' chip shows them.
const NOISY_KINDS = ['telegram'];

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
        // The Telegram hook may already have stored this exact text as a raw copy — keep one.
        if (kind !== 'telegram') {
            await query(`DELETE FROM report_archive WHERE kind = 'telegram' AND body = $1 AND created_at > NOW() - INTERVAL '10 minutes'`, [String(body)]);
        }
    } catch (err) {
        logger.warn('[ReportArchive] Save failed (non-blocking)', { kind, error: err.message });
    }
}

function _title(body) {
    const first = String(body).split('\n').map(l => l.replace(/<[^>]+>|[*_`[\]]/g, '').trim()).find(Boolean) || 'Telegram message';
    return first.slice(0, 100);
}

/**
 * Every Telegram send lands here (telegramAlertService / telegramService / news rescan), so
 * /reports shows everything Telegram shows (2026-11-07, user request). Admin chat → admin
 * only; a user's own chat → only that user. Skips text a scheduled report already archived
 * under its own kind. Fire-and-forget; never throws.
 */
function archiveTelegram({ chatId, body, parseMode }) {
    if (!body || (process.env.NODE_ENV === 'test' && !process.env.REPORT_ARCHIVE_IN_TESTS)) return;
    (async () => {
        await ensureTable();
        const text = String(body);
        const dup = await query(`SELECT 1 FROM report_archive WHERE body = $1 AND created_at > NOW() - INTERVAL '10 minutes' LIMIT 1`, [text]);
        if (dup.rows.length) return;
        const adminChat = process.env.TELEGRAM_CHAT_ID || '';
        let userId = null, adminOnly = true;
        if (chatId && String(chatId) !== String(adminChat)) {
            const u = await query(`SELECT id FROM users WHERE telegram_chat_id = $1 LIMIT 1`, [String(chatId)]);
            if (u.rows[0]) { userId = String(u.rows[0].id); adminOnly = false; }
        }
        const format = String(parseMode || '').toUpperCase() === 'HTML' ? 'html' : 'markdown';
        await query(
            `INSERT INTO report_archive (kind, title, body, format, user_id, admin_only) VALUES ('telegram', $1, $2, $3, $4, $5)`,
            [_title(text), text, format, userId, adminOnly]);
    })().catch(err => logger.debug('[ReportArchive] Telegram copy failed', { error: err.message }));
}

const VISIBLE_SQL = `(user_id = $1 OR (user_id IS NULL AND (NOT admin_only OR $2)))`;

async function list(userId, isAdmin, { kind = null, limit = 200 } = {}) {
    await ensureTable();
    const params = [String(userId), !!isAdmin, Math.min(Number(limit) || 200, 500)];
    let where = VISIBLE_SQL;
    if (kind) { params.push(kind); where += ` AND kind = $4`; }
    else where += ` AND kind <> ALL('{${NOISY_KINDS.join(',')}}')`;
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

module.exports = { KINDS, ensureTable, save, list, get, archiveTelegram };
