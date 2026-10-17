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

const METHODS = ['control', 'oversold', 'steady', 'insider', 'oil', 'sector'];
/**
 * Exit profiles (2026-10-17, 3-year replay of 148K candidate trades, return per day held):
 *   standard — today's rules: tightening trail (5.5% → 2%), break-even lock at +2%,
 *              slow-mover exit (~4 trading days, gain 0-2%), max hold ~5 trading days.
 *              Replay of the simpler 5% version: +0.10%/trade, +0.020%/day.
 *   wide     — flat 7% trail, no break-even lock, no slow-mover exit, take profits after
 *              ~10 trading days, hard cap ~20: +0.25%/trade, +0.030%/day, better in 2024,
 *              2025 and 2026. Paper first; a live account changes only by approval.
 */
const EXIT_PROFILES = ['standard', 'wide'];
const CACHE_MS = 60 * 1000;
const _cache = new Map();

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS strategy_settings (
            user_id          TEXT        PRIMARY KEY,
            selection_method TEXT        NOT NULL DEFAULT 'control',
            source           TEXT,
            updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    await query(`ALTER TABLE strategy_settings ADD COLUMN IF NOT EXISTS exit_profile TEXT NOT NULL DEFAULT 'standard'`);
    // methods list widened 2026-10-17 (oil, sector) — keep the constraint in step with METHODS
    await query(`ALTER TABLE strategy_settings DROP CONSTRAINT IF EXISTS strategy_settings_selection_method_check`);
    await query(`ALTER TABLE strategy_settings ADD CONSTRAINT strategy_settings_selection_method_check
                 CHECK (selection_method IN (${METHODS.map(m => `'${m}'`).join(', ')}))`);
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

const _exitCache = new Map();
/** 'standard' unless the account was switched; never throws. */
async function getExitProfile(userId) {
    const key = String(userId);
    const hit = _exitCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.profile;
    try {
        await ensureTable();
        const r = await query(`SELECT exit_profile FROM strategy_settings WHERE user_id = $1`, [key]);
        const profile = EXIT_PROFILES.includes(r.rows[0]?.exit_profile) ? r.rows[0].exit_profile : 'standard';
        _exitCache.set(key, { at: Date.now(), profile });
        return profile;
    } catch (_) {
        return hit ? hit.profile : 'standard';
    }
}

async function setExitProfile(userId, profile, source) {
    if (!EXIT_PROFILES.includes(profile)) throw new Error(`Unknown exit profile: ${profile}`);
    await ensureTable();
    await query(
        `INSERT INTO strategy_settings (user_id, exit_profile, source) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET exit_profile = EXCLUDED.exit_profile, source = EXCLUDED.source, updated_at = NOW()`,
        [String(userId), profile, source || null]
    );
    _exitCache.delete(String(userId));
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

module.exports = { METHODS, EXIT_PROFILES, getSelectionMethod, getSettingsRow, setSelectionMethod, getExitProfile, setExitProfile, ensureTable };
