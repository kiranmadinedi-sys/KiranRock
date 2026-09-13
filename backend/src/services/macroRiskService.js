/**
 * Macro/News Risk Flag — feeds the daily Fed/geopolitical news digest
 * (a scheduled cloud-agent research job, see project memory 2026-09-13)
 * into position sizing, as a genuinely OPTIONAL, soft-fail dampener.
 *
 * Deliberately separate from vixMonitor's VIX-based sizing multiplier:
 * VIX is a real, market-priced number; this is an LLM's daily read of the
 * news, which is a fundamentally softer, less-calibrated signal. It should
 * nudge position size, never block a trade outright, and any failure to
 * read it (missing row, stale date, DB error) must resolve to "no
 * adjustment" — the trading bot must never depend on this being available.
 *
 * Data flow: the cloud agent researches the day's catalysts, then calls
 * POST /api/internal/macro-briefing (macroBriefingRoutes.js) with a
 * risk level + message. That route calls recordDailyRiskFlag() below and
 * also sends the Telegram message directly from the backend (which has no
 * network egress restrictions, unlike the cloud agent's sandbox — see the
 * 2026-09-13 investigation: api.telegram.org is blocked from that sandbox
 * for both Bash/curl and WebFetch).
 */
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const VALID_LEVELS = ['Calm', 'Elevated', 'High', 'Extreme', 'Panic'];

// Never a hard block — the market-priced VIX check already owns that job
// (see enhancedAITradingBot.js's _vixSizeMult, which blocks entries upstream
// at EXTREME/PANIC). This is a softer, additive dampener on top of it.
const SIZE_MULTIPLIER_BY_LEVEL = {
    Calm: 1.0,
    Elevated: 0.9,
    High: 0.75,
    Extreme: 0.6,
    Panic: 0.5,
};

let _schemaEnsured = false;

async function ensureMacroRiskSchema() {
    if (_schemaEnsured) return;
    await query(`
        CREATE TABLE IF NOT EXISTS macro_risk_flags (
            id SERIAL PRIMARY KEY,
            flag_date DATE UNIQUE NOT NULL,
            risk_level TEXT NOT NULL,
            message TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    `);
    _schemaEnsured = true;
}

function _today() {
    return new Date().toISOString().slice(0, 10);
}

/**
 * Upsert today's risk flag. Throws on a genuinely invalid level (caught by
 * the route, which is the only caller) but never on infrastructure —
 * schema creation is part of this call so the very first-ever call works.
 */
async function recordDailyRiskFlag({ riskLevel, message }) {
    if (!VALID_LEVELS.includes(riskLevel)) {
        throw new Error(`Invalid risk level "${riskLevel}" — must be one of ${VALID_LEVELS.join(', ')}`);
    }
    await ensureMacroRiskSchema();
    await query(`
        INSERT INTO macro_risk_flags (flag_date, risk_level, message)
        VALUES ($1, $2, $3)
        ON CONFLICT (flag_date) DO UPDATE SET
            risk_level = EXCLUDED.risk_level,
            message    = EXCLUDED.message,
            updated_at = NOW()
    `, [_today(), riskLevel, message || null]);
}

/**
 * Today's position-size multiplier from the macro risk flag, or 1.0
 * (no adjustment) if there's no row for today, the table doesn't exist yet,
 * or anything else goes wrong. Never throws — this is read on every
 * position-sizing pass in the live trading bot, and must fail open.
 */
async function getRiskSizeMultiplier() {
    try {
        const res = await query(
            `SELECT risk_level FROM macro_risk_flags WHERE flag_date = $1`,
            [_today()]
        );
        const level = res.rows[0]?.risk_level;
        if (!level) return 1.0;
        return SIZE_MULTIPLIER_BY_LEVEL[level] ?? 1.0;
    } catch (err) {
        logger.debug('[MacroRisk] Could not read today\'s risk flag — proceeding with no adjustment', {
            error: err.message
        });
        return 1.0;
    }
}

module.exports = { ensureMacroRiskSchema, recordDailyRiskFlag, getRiskSizeMultiplier, VALID_LEVELS, SIZE_MULTIPLIER_BY_LEVEL };
