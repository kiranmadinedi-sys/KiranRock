/**
 * Platform-wide settings (2026-11-06) — for changes that cannot be per account because the
 * stock scores themselves are shared by every account (analyzeStockWithAI takes no user).
 * Changed only through an approved request (approvalService kind `platform_setting`).
 * Read through a 60s cache so per-stock scoring never waits on the database.
 *
 * Keys:
 *   atlas_penalties_scored — boolean, default true. false = ATLAS's negative points are
 *     logged but no longer subtracted (its bonuses have been unscored since 2026-10-17).
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const DEFAULTS = { atlas_penalties_scored: true };
const CACHE_MS = 60 * 1000;
const _cache = new Map();

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS platform_settings (
            key        TEXT        PRIMARY KEY,
            value      JSONB       NOT NULL,
            source     TEXT,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    _ready = true;
}

async function get(key) {
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    let value = DEFAULTS[key];
    try {
        await ensureTable();
        const r = await query(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
        if (r.rows.length) value = r.rows[0].value;
    } catch (err) {
        logger.warn('[PlatformSettings] Read failed — using default', { key, error: err.message });
    }
    _cache.set(key, { at: Date.now(), value });
    return value;
}

async function set(key, value, source) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown platform setting ${key}`);
    await ensureTable();
    await query(
        `INSERT INTO platform_settings (key, value, source, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, source = EXCLUDED.source, updated_at = NOW()`,
        [key, JSON.stringify(value), source]
    );
    _cache.delete(key);
    logger.info('[PlatformSettings] Updated', { key, value, source });
}

function _clearCache() { _cache.clear(); }

module.exports = { get, set, DEFAULTS, _clearCache };
