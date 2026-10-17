/**
 * Per-account stock-picking method (2026-10-17). Replaces the hard-coded Phase 1
 * experiment switch: which ordering of the nightly candidate pool an account uses.
 *
 *   control  — current AI-score order (every account's default)
 *   oversold — mean-reversion points minus momentum points (selectionExperimentService)
 *   steady   — full uptrend, RSI 55-70, $50+ first
 *   insider  — stocks with an active insider-buying cluster first
 *
 * The paper account's method can change automatically when a method passes its test
 * (promotionService). A LIVE account's method only changes through an approval request
 * the owner accepts (approvalService) — never automatically.
 */
const { query } = require('../config/database');

const METHODS = ['control', 'oversold', 'steady', 'insider'];
const CACHE_MS = 60 * 1000;
const _cache = new Map();

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS strategy_settings (
            user_id          TEXT        PRIMARY KEY,
            selection_method TEXT        NOT NULL DEFAULT 'control' CHECK (selection_method IN ('control', 'oversold', 'steady', 'insider')),
            source           TEXT,
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    _ready = true;
}

function _legacyDefault(userId) {
    // Before this table existed the paper experiment was switched on via env.
    const ids = (process.env.SELECTION_EXPERIMENT_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    return ids.includes(String(userId)) ? 'oversold' : 'control';
}

/** The account's method. Falls back to the legacy env default; never throws. */
async function getSelectionMethod(userId) {
    const key = String(userId);
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.method;
    try {
        await ensureTable();
        const r = await query(`SELECT selection_method FROM strategy_settings WHERE user_id = $1`, [key]);
        const method = r.rows[0]?.selection_method || _legacyDefault(key);
        _cache.set(key, { at: Date.now(), method });
        return method;
    } catch (_) {
        return hit ? hit.method : _legacyDefault(key);
    }
}

async function getSettingsRow(userId) {
    await ensureTable();
    const r = await query(`SELECT selection_method AS method, source, updated_at FROM strategy_settings WHERE user_id = $1`, [String(userId)]);
    return r.rows[0] || null;
}

async function setSelectionMethod(userId, method, source) {
    if (!METHODS.includes(method)) throw new Error(`Unknown selection method: ${method}`);
    await ensureTable();
    await query(
        `INSERT INTO strategy_settings (user_id, selection_method, source) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET selection_method = EXCLUDED.selection_method, source = EXCLUDED.source, updated_at = NOW()`,
        [String(userId), method, source || null]
    );
    _cache.delete(String(userId));
}

module.exports = { METHODS, getSelectionMethod, getSettingsRow, setSelectionMethod, ensureTable };
