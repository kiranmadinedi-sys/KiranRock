/**
 * Shadow Trade Service
 * ================================================
 * Answers the question trade_rejection_log alone can't: not just "why was
 * this blocked," but "what would have happened if it hadn't been." For any
 * rejected candidate with a genuinely tradeable score (>= SHADOW_TRADE_MIN_SCORE,
 * gated in enhancedAITradingBot.js's _recordRejection), tracks the price
 * forward as if the trade had been taken — max favorable/adverse excursion
 * and 5/10/20-trading-day returns from the price at the moment it was
 * rejected — so each risk gate can eventually be judged on real evidence
 * instead of a hunch.
 *
 * Added 2026-09-07, prompted by a ChatGPT review of PANTHEON's architecture
 * that (correctly, independent of the codebase) identified this as the
 * highest-leverage next step: know whether a gate is protecting the account
 * or quietly costing it money before tuning it either direction.
 */

'use strict';

const cron       = require('node-cron');
const { query }  = require('../config/database');
const { logger } = require('../utils/logger');

const CRON_TZ           = { timezone: 'America/New_York' };
const TRACK_TRADING_DAYS = 20;   // how long to keep watching before closing a shadow trade out
const RETURN_CHECKPOINTS = [5, 10, 20];

let job = null;

async function _ensureSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS shadow_trades (
            id                SERIAL PRIMARY KEY,
            symbol            TEXT NOT NULL,
            user_id           TEXT NOT NULL,
            rejection_date    DATE NOT NULL,
            rejection_reason  TEXT NOT NULL,
            rejection_detail  TEXT,
            ai_score          NUMERIC,
            entry_price_ref   NUMERIC NOT NULL,
            stop_price_ref    NUMERIC,
            target_price_ref  NUMERIC,
            sector            TEXT,
            setup_family      TEXT,
            mfe_pct           NUMERIC,
            mae_pct           NUMERIC,
            return_5d_pct     NUMERIC,
            return_10d_pct    NUMERIC,
            return_20d_pct    NUMERIC,
            rejected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_checked_at   TIMESTAMPTZ,
            closed_at         TIMESTAMPTZ,
            UNIQUE (symbol, user_id, rejection_date)
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_shadow_trades_open
            ON shadow_trades (symbol) WHERE closed_at IS NULL
    `);
}

/**
 * Record (or refresh, if the same symbol/user/day rejects again intraday) a
 * shadow trade. Only called for rejections that already cleared the score bar
 * — see _recordRejection in enhancedAITradingBot.js.
 */
async function recordShadowTrade(opportunity, userId, reason, detail) {
    await _ensureSchema();

    const entryPrice = opportunity.entry || opportunity.price;
    if (!entryPrice || entryPrice <= 0) return; // nothing to track price movement from

    const today = new Date().toISOString().slice(0, 10);
    await query(`
        INSERT INTO shadow_trades
            (symbol, user_id, rejection_date, rejection_reason, rejection_detail,
             ai_score, entry_price_ref, stop_price_ref, target_price_ref,
             sector, setup_family)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (symbol, user_id, rejection_date) DO UPDATE SET
            rejection_reason = EXCLUDED.rejection_reason,
            rejection_detail = EXCLUDED.rejection_detail,
            ai_score         = EXCLUDED.ai_score
    `, [
        opportunity.symbol, String(userId), today, reason, detail || null,
        opportunity.aiScore || opportunity.confidence || null,
        entryPrice, opportunity.stop || null, opportunity.target || null,
        opportunity.sector || null, opportunity.setupFamily || null
    ]);
}

/**
 * Update forward MFE/MAE/return metrics for every still-open shadow trade,
 * then close out any that have run their full tracking window.
 */
async function updateShadowTrades() {
    await _ensureSchema();

    const open = await query(`
        SELECT id, symbol, entry_price_ref, rejected_at
        FROM shadow_trades
        WHERE closed_at IS NULL
    `);

    let updated = 0, closed = 0, failed = 0;

    for (const row of open.rows) {
        try {
            const dataProvider = require('./dataProvider');
            const daysElapsed = Math.floor((Date.now() - new Date(row.rejected_at).getTime()) / 86400000);
            // Fetch enough bars to cover the full tracking window plus buffer for
            // weekends/holidays between rejection and now.
            const bars = await dataProvider.getBars(row.symbol, '1d', Math.max(TRACK_TRADING_DAYS + 10, daysElapsed + 5));
            if (!bars || bars.length === 0) { failed++; continue; }

            // Only bars strictly after the rejection matter for MFE/MAE/returns.
            const rejectedAtMs = new Date(row.rejected_at).getTime();
            const barsSince = bars.filter(b => new Date(b.time || b.date).getTime() > rejectedAtMs);
            if (barsSince.length === 0) continue; // no new bar yet (rejected today)

            const entry = parseFloat(row.entry_price_ref);
            const highs = barsSince.map(b => b.high);
            const lows  = barsSince.map(b => b.low);
            const mfePct = ((Math.max(...highs) - entry) / entry) * 100;
            const maePct = ((Math.min(...lows)  - entry) / entry) * 100;

            const returns = {};
            for (const n of RETURN_CHECKPOINTS) {
                if (barsSince.length >= n) {
                    returns[n] = ((barsSince[n - 1].close - entry) / entry) * 100;
                }
            }

            const tradingDaysTracked = barsSince.length;
            const shouldClose = tradingDaysTracked >= TRACK_TRADING_DAYS;

            await query(`
                UPDATE shadow_trades
                SET mfe_pct = $1, mae_pct = $2,
                    return_5d_pct  = COALESCE($3, return_5d_pct),
                    return_10d_pct = COALESCE($4, return_10d_pct),
                    return_20d_pct = COALESCE($5, return_20d_pct),
                    last_checked_at = NOW(),
                    closed_at = CASE WHEN $6 THEN NOW() ELSE closed_at END
                WHERE id = $7
            `, [
                mfePct, maePct,
                returns[5] ?? null, returns[10] ?? null, returns[20] ?? null,
                shouldClose, row.id
            ]);

            updated++;
            if (shouldClose) closed++;
        } catch (err) {
            failed++;
            logger.debug('[ShadowTrade] Update failed', { symbol: row.symbol, err: err.message });
        }
    }

    logger.info('[ShadowTrade] Daily update complete', { checked: open.rows.length, updated, closed, failed });
    return { checked: open.rows.length, updated, closed, failed };
}

/**
 * The actual payoff: is each gate protecting the account or costing it money?
 * Aggregates closed (fully-tracked) shadow trades by rejection reason.
 */
async function getShadowTradeAttribution({ days = 90 } = {}) {
    await _ensureSchema();
    const res = await query(`
        SELECT rejection_reason,
               COUNT(*)::int AS n,
               ROUND(AVG(mfe_pct)::numeric, 2)        AS avg_mfe_pct,
               ROUND(AVG(mae_pct)::numeric, 2)        AS avg_mae_pct,
               ROUND(AVG(return_20d_pct)::numeric, 2) AS avg_return_20d_pct,
               COUNT(*) FILTER (WHERE return_20d_pct > 0)::int AS would_have_won
        FROM shadow_trades
        WHERE closed_at IS NOT NULL
          AND rejected_at >= NOW() - ($1 || ' days')::interval
        GROUP BY rejection_reason
        ORDER BY n DESC
    `, [days]);
    return res.rows;
}

function startShadowTradeScheduler() {
    if (job) {
        logger.warn('[ShadowTrade] Scheduler already running');
        return;
    }

    // 6:00 PM ET, after the missed-opportunity monitor's 5:00 PM slot.
    job = cron.schedule('0 18 * * 1-5', async () => {
        logger.info('[ShadowTrade] Cron triggered — updating shadow trades');
        try {
            await updateShadowTrades();

            // Weekly attribution summary, Fridays only — enough new closed shadow
            // trades accumulate slowly; a daily alert would mostly repeat itself.
            const etDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date());
            if (etDay === 'Fri') {
                const attribution = await getShadowTradeAttribution({ days: 90 });
                if (attribution.length > 0) {
                    const lines = attribution.map(a =>
                        `• *${a.rejection_reason}* — ${a.n} tracked, avg MFE +${a.avg_mfe_pct}%, ` +
                        `avg MAE ${a.avg_mae_pct}%, avg 20d return ${a.avg_return_20d_pct > 0 ? '+' : ''}${a.avg_return_20d_pct}% ` +
                        `(${a.would_have_won}/${a.n} would have been profitable)`
                    );
                    const message =
                        `📊 *Shadow Trade Attribution* (last 90 days)\n\n` +
                        `What happened to candidates each gate blocked:\n\n` +
                        lines.join('\n');
                    try {
                        const alertService = require('./telegramAlertService');
                        await alertService.sendAdminMessage(message);
                    } catch (err) {
                        logger.warn('[ShadowTrade] Attribution alert failed', { err: err.message });
                    }
                }
            }
        } catch (err) {
            logger.error('[ShadowTrade] Cron job failed', { error: err.message });
        }
    }, CRON_TZ);

    logger.info('[ShadowTrade] Scheduler started — daily update 6:00 PM ET, attribution summary Fridays');
}

function stopShadowTradeScheduler() {
    if (job) {
        job.stop();
        job = null;
        logger.info('[ShadowTrade] Scheduler stopped');
    }
}

module.exports = {
    recordShadowTrade,
    updateShadowTrades,
    getShadowTradeAttribution,
    startShadowTradeScheduler,
    stopShadowTradeScheduler,
};
