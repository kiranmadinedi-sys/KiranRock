/**
 * Missed Opportunity Monitor
 * ================================================
 * Catches the DELL class of bug automatically instead of requiring someone to
 * manually cross-reference logs, daily_universe_analysis, and trades after
 * the fact (which is how the 2026-09-05 case was found — DELL scored STRONG
 * BUY and passed prescreen for 5 straight trading days during a real +20%+
 * breakout, and no account ever bought it, purely because of an opportunity-
 * ranking bug that has since been fixed).
 *
 * Runs once daily after close. Flags any symbol that has passed prescreen with
 * a STRONG BUY/BUY recommendation for MIN_QUALIFYING_DAYS or more of the last
 * LOOKBACK_DAYS days, with zero BUY trades on ANY account across that same
 * window — then sends one Telegram alert per newly-detected miss (not a daily
 * repeat for the same ongoing miss) so this surfaces same-day instead of only
 * when someone happens to go looking.
 */

'use strict';

const cron       = require('node-cron');
const { query }  = require('../config/database');
const { logger } = require('../utils/logger');

const CRON_TZ             = { timezone: 'America/New_York' };
const MIN_QUALIFYING_DAYS = 3;
const LOOKBACK_DAYS       = 6;
const MIN_SCORE           = 85;    // sustained across every qualifying day, not just once
const MIN_REALIZED_MOVE_PCT = 8;   // real price move required — see note below
const MAX_ALERT_LINES     = 10;

let job = null;

async function _ensureSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS missed_opportunities (
            id                     SERIAL PRIMARY KEY,
            symbol                 TEXT NOT NULL,
            qualifying_days        INTEGER NOT NULL,
            latest_score           NUMERIC,
            latest_recommendation  TEXT,
            realized_move_pct      NUMERIC,
            detected_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at            TIMESTAMPTZ
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_missed_opps_open
            ON missed_opportunities (symbol) WHERE resolved_at IS NULL
    `);
    // Table may already exist from before realized_move_pct was added.
    await query(`
        ALTER TABLE missed_opportunities ADD COLUMN IF NOT EXISTS realized_move_pct NUMERIC
    `);
}

/**
 * % price change from the oldest to newest close in the lookback window.
 * Returns null if bars aren't available (never blocks the rest of the check —
 * a symbol just doesn't qualify without a confirmed real move).
 */
async function _getRealizedMovePct(symbol) {
    try {
        const dataProvider = require('./dataProvider');
        const bars = await dataProvider.getBars(symbol, '1d', LOOKBACK_DAYS + 3);
        if (!bars || bars.length < 2) return null;
        const first = bars[0].close;
        const last  = bars[bars.length - 1].close;
        if (!first || first <= 0) return null;
        return ((last - first) / first) * 100;
    } catch (err) {
        logger.debug('[MissedOpportunity] Price check failed', { symbol, err: err.message });
        return null;
    }
}

/**
 * Run the check. Exposed standalone (not just via cron) so it can be triggered
 * manually or tested in isolation.
 * @returns {Promise<{checked:number, missed:string[], newlyFlagged:string[]}>}
 */
async function checkMissedOpportunities() {
    await _ensureSchema();

    // Stage 1 — score filter. NOTE: ai_score saturates hard in this system (dozens
    // of symbols hit 100 on any given week), so "STRONG BUY 3+ days" alone matched
    // 166 symbols in testing — useless as an alert, that's just what a healthy
    // scoring pipeline looks like when capital can only ever act on a handful of
    // them. Score is a necessary filter, not a sufficient one.
    const qualifying = await query(`
        SELECT symbol,
               COUNT(*)::int AS qualifying_days,
               MAX(ai_score) AS latest_score,
               MIN(ai_score) AS min_score,
               (ARRAY_AGG(recommendation ORDER BY analysis_date DESC))[1] AS latest_recommendation
        FROM daily_universe_analysis
        WHERE analysis_date >= CURRENT_DATE - ($1 || ' days')::interval
          AND analysis_date < CURRENT_DATE
          AND recommendation = 'STRONG BUY'
          AND passed_prescreen = true
          AND ai_score >= $2
        GROUP BY symbol
        HAVING COUNT(*) >= $3
    `, [LOOKBACK_DAYS, MIN_SCORE, MIN_QUALIFYING_DAYS]);

    if (qualifying.rows.length === 0) {
        logger.info('[MissedOpportunity] No symbols qualified for a check today');
        return { checked: 0, missed: [], newlyFlagged: [] };
    }

    const candidateSymbols = qualifying.rows.map(r => r.symbol);
    // "Not missed" = a recent BUY trade OR a currently-open holding — a position
    // can exist in holdings with no trades row behind it (a real, separate gap:
    // IOVA was found this way, 57 shares bought 2026-09-04 with zero rows in
    // trades — presumably a shadow import). Either one means an account is
    // actually participating in the move, which is what actually matters here.
    const [bought, held] = await Promise.all([
        query(`
            SELECT DISTINCT symbol FROM trades
            WHERE action = 'BUY'
              AND trade_date >= CURRENT_DATE - ($1 || ' days')::interval
              AND symbol = ANY($2)
        `, [LOOKBACK_DAYS, candidateSymbols]),
        query(`SELECT DISTINCT symbol FROM holdings WHERE symbol = ANY($1)`, [candidateSymbols]),
    ]);
    const notMissedSet = new Set([...bought.rows, ...held.rows].map(r => r.symbol));

    const scoreQualifiedUnbought = qualifying.rows.filter(r => !notMissedSet.has(r.symbol));

    // Stage 2 — the real filter: did the price actually move? This is what made
    // DELL worth flagging and separates "AI liked it" from "AI liked it AND we
    // sat out a real move." Sequential, not Promise.all — dataProvider's own
    // shared rate limiter already paces these; this is an off-hours daily cron,
    // not a latency-sensitive live cycle, so there's no reason to burst it.
    const missed = [];
    for (const row of scoreQualifiedUnbought) {
        const movePct = await _getRealizedMovePct(row.symbol);
        if (movePct !== null && movePct >= MIN_REALIZED_MOVE_PCT) {
            missed.push({ ...row, realized_move_pct: movePct });
        }
    }
    missed.sort((a, b) => b.realized_move_pct - a.realized_move_pct);
    const missedSymbols = missed.map(m => m.symbol);

    // Resolve any open record for a symbol that's no longer missed (it got
    // bought, or dropped out of the qualifying window).
    await query(`
        UPDATE missed_opportunities
        SET resolved_at = NOW()
        WHERE resolved_at IS NULL
          AND NOT (symbol = ANY($1))
    `, [missedSymbols.length ? missedSymbols : ['__none__']]);

    const newlyFlagged = [];
    for (const m of missed) {
        const existing = await query(
            `SELECT id FROM missed_opportunities WHERE symbol = $1 AND resolved_at IS NULL`,
            [m.symbol]
        );
        if (existing.rows.length > 0) {
            await query(
                `UPDATE missed_opportunities
                 SET qualifying_days = $1, latest_score = $2, latest_recommendation = $3,
                     realized_move_pct = $4, last_seen_at = NOW()
                 WHERE id = $5`,
                [m.qualifying_days, m.latest_score, m.latest_recommendation, m.realized_move_pct, existing.rows[0].id]
            );
        } else {
            await query(
                `INSERT INTO missed_opportunities
                     (symbol, qualifying_days, latest_score, latest_recommendation, realized_move_pct, detected_at, last_seen_at)
                 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
                [m.symbol, m.qualifying_days, m.latest_score, m.latest_recommendation, m.realized_move_pct]
            );
            newlyFlagged.push(m);
        }
    }

    if (newlyFlagged.length > 0) {
        const shown   = newlyFlagged.slice(0, MAX_ALERT_LINES);
        const overflow = newlyFlagged.length - shown.length;
        const lines = shown.map(m =>
            `• *${m.symbol}* — +${m.realized_move_pct.toFixed(1)}% over ${LOOKBACK_DAYS}d, ` +
            `STRONG BUY score ${m.latest_score} for ${m.qualifying_days}/${LOOKBACK_DAYS}d, 0 buys on any account`
        );
        const message =
            `🔍 *Missed Opportunity Alert*\n\n` +
            `${newlyFlagged.length} symbol(s) scored STRONG BUY (${MIN_SCORE}+) for ${MIN_QUALIFYING_DAYS}+ of the ` +
            `last ${LOOKBACK_DAYS} days, passed prescreen, actually moved ${MIN_REALIZED_MOVE_PCT}%+, and had ` +
            `zero buys across every account:\n\n` +
            lines.join('\n') +
            (overflow > 0 ? `\n…and ${overflow} more (see missed_opportunities table)` : '') +
            `\n\nWorth a look — candidate cap, sector/correlation limits, portfolio at capacity, ` +
            `or a real gap in the buy path.`;
        try {
            const alertService = require('./telegramAlertService');
            await alertService.sendAdminMessage(message);
        } catch (err) {
            logger.warn('[MissedOpportunity] Telegram alert failed', { err: err.message });
        }
        logger.info('[MissedOpportunity] New missed opportunities flagged', {
            count: newlyFlagged.length,
            symbols: newlyFlagged.map(m => m.symbol)
        });
    } else {
        logger.info('[MissedOpportunity] Check complete — nothing new', {
            qualifying: qualifying.rows.length,
            missed: missed.length
        });
    }

    return { checked: qualifying.rows.length, missed: missedSymbols, newlyFlagged: newlyFlagged.map(m => m.symbol) };
}

/**
 * Called once from worker.js at startup. Runs daily at 5:00 PM ET, Mon-Fri —
 * after close and after daily_universe_analysis has its final rows for the day.
 */
function startMissedOpportunityScheduler() {
    if (job) {
        logger.warn('[MissedOpportunity] Scheduler already running');
        return;
    }

    job = cron.schedule('0 17 * * 1-5', async () => {
        logger.info('[MissedOpportunity] Cron triggered — checking for missed opportunities');
        try {
            await checkMissedOpportunities();
        } catch (err) {
            logger.error('[MissedOpportunity] Cron job failed', { error: err.message });
        }
    }, CRON_TZ);

    logger.info('[MissedOpportunity] Scheduler started — runs at 5:00 PM ET, Mon-Fri');
}

function stopMissedOpportunityScheduler() {
    if (job) {
        job.stop();
        job = null;
        logger.info('[MissedOpportunity] Scheduler stopped');
    }
}

module.exports = {
    checkMissedOpportunities,
    startMissedOpportunityScheduler,
    stopMissedOpportunityScheduler,
};
