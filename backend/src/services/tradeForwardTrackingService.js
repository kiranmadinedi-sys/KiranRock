/**
 * Trade Forward Tracking Service
 * ================================================
 * The "actual BUY" counterpart to shadowTradeService's rejected-candidate
 * tracking. Anchored to the real entry price of an executed trade, tracks the
 * same forward MFE/MAE/5-10-20-trading-day-return metrics shadow trades do —
 * using the identical shared math in forwardReturnCalculator.js — so the two
 * populations can be compared apples-to-apples in the Gate Alpha Attribution
 * report (see shadowTradeService.getGateAlphaAttribution).
 *
 * Deliberately independent of the trade's own real exit: `trades.pnl_percent`
 * reflects whatever the bot's own exit strategy/timing produced, which varies
 * trade to trade and isn't a fair comparison point against a fixed-window
 * shadow-trade return. This tracks a fixed 5/10/20-day window from entry
 * regardless of when (or whether) the position is actually closed, exactly
 * mirroring shadow trades' own methodology.
 *
 * Added 2026-09-08, prompted by a ChatGPT review's follow-up: knowing 10 of
 * 163 STRONG BUY candidates became real trades only answers "how selective are
 * the gates" — not "are the gates selecting the RIGHT ones." Comparing actual
 * BUY forward returns against each gate's rejected population answers that.
 */

'use strict';

const cron       = require('node-cron');
const { query }  = require('../config/database');
const { logger } = require('../utils/logger');
const { computeForwardMetrics, barsAfter, TRACK_TRADING_DAYS } = require('../utils/forwardReturnCalculator');

const CRON_TZ = { timezone: 'America/New_York' };

let job = null;

async function _ensureSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS trade_forward_tracking (
            id                SERIAL PRIMARY KEY,
            trade_id          INTEGER,
            symbol            TEXT NOT NULL,
            user_id           TEXT NOT NULL,
            entry_date        DATE NOT NULL,
            entry_price       NUMERIC NOT NULL,
            ai_score          NUMERIC,
            sector            TEXT,
            regime            TEXT,
            mfe_pct           NUMERIC,
            mae_pct           NUMERIC,
            return_5d_pct     NUMERIC,
            return_10d_pct    NUMERIC,
            return_20d_pct    NUMERIC,
            recorded_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_checked_at   TIMESTAMPTZ,
            closed_at         TIMESTAMPTZ,
            UNIQUE (trade_id)
        )
    `);
    await query(`
        CREATE INDEX IF NOT EXISTS idx_trade_forward_tracking_open
            ON trade_forward_tracking (symbol) WHERE closed_at IS NULL
    `);
}

/**
 * Record a new tracking row right after a BUY actually fills. Fire-and-forget
 * by design — called from tradingServiceDB.executeBuyOrder() after its own
 * transaction has already committed the real trade; a failure here must never
 * affect the trade that already happened. trade_id may be null if the caller
 * doesn't have it (still tracked, just not linkable back to a specific trades
 * row for detailed drill-down later).
 */
async function recordTradeEntry({ tradeId, symbol, userId, entryDate, entryPrice, aiScore, sector, regime }) {
    if (!entryPrice || entryPrice <= 0 || !symbol || !userId) return;
    try {
        await _ensureSchema();
        await query(`
            INSERT INTO trade_forward_tracking
                (trade_id, symbol, user_id, entry_date, entry_price, ai_score, sector, regime)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
            ON CONFLICT (trade_id) DO NOTHING
        `, [
            tradeId ?? null, symbol, String(userId), entryDate, entryPrice,
            aiScore ?? null, sector ?? null, regime ?? null
        ]);
    } catch (err) {
        logger.debug('[TradeForwardTracking] recordTradeEntry failed', { symbol, error: err.message });
    }
}

/**
 * Update forward MFE/MAE/return metrics for every still-open tracking row,
 * then close out any that have run their full tracking window. Mirrors
 * shadowTradeService.updateShadowTrades() exactly (same shared calculator).
 */
async function updateTradeForwardTracking() {
    await _ensureSchema();

    const open = await query(`
        SELECT id, symbol, entry_price, recorded_at
        FROM trade_forward_tracking
        WHERE closed_at IS NULL
    `);

    let updated = 0, closed = 0, failed = 0;

    for (const row of open.rows) {
        try {
            const dataProvider = require('./dataProvider');
            const daysElapsed = Math.floor((Date.now() - new Date(row.recorded_at).getTime()) / 86400000);
            const bars = await dataProvider.getBars(row.symbol, '1d', Math.max(TRACK_TRADING_DAYS + 10, daysElapsed + 5));
            if (!bars || bars.length === 0) { failed++; continue; }

            const anchorMs = new Date(row.recorded_at).getTime();
            const barsSince = barsAfter(bars, anchorMs);
            if (barsSince.length === 0) continue; // no new bar yet (entered today)

            const entry = parseFloat(row.entry_price);
            const metrics = computeForwardMetrics(barsSince, entry);
            if (!metrics) continue;

            await query(`
                UPDATE trade_forward_tracking
                SET mfe_pct = $1, mae_pct = $2,
                    return_5d_pct  = COALESCE($3, return_5d_pct),
                    return_10d_pct = COALESCE($4, return_10d_pct),
                    return_20d_pct = COALESCE($5, return_20d_pct),
                    last_checked_at = NOW(),
                    closed_at = CASE WHEN $6 THEN NOW() ELSE closed_at END
                WHERE id = $7
            `, [
                metrics.mfePct, metrics.maePct,
                metrics.return5dPct, metrics.return10dPct, metrics.return20dPct,
                metrics.shouldClose, row.id
            ]);

            updated++;
            if (metrics.shouldClose) closed++;
        } catch (err) {
            failed++;
            logger.debug('[TradeForwardTracking] Update failed', { symbol: row.symbol, err: err.message });
        }
    }

    logger.info('[TradeForwardTracking] Daily update complete', { checked: open.rows.length, updated, closed, failed });
    return { checked: open.rows.length, updated, closed, failed };
}

/**
 * Single aggregate row for the "Actual BUY" side of Gate Alpha Attribution —
 * deliberately not grouped by anything (every executed trade is one group),
 * mirroring shadowTradeService.getShadowTradeAttribution()'s shape so the two
 * can be merged into one report.
 */
async function getActualBuyAttribution({ days = 90 } = {}) {
    await _ensureSchema();
    // Not gated on closed_at (2026-09-08 feedback round): a full 20-day close-out
    // shouldn't be the price of seeing ANY signal. Each checkpoint's average and
    // count are independent — n_5d/n_10d/n_20d tell the caller how mature each
    // number actually is, rather than showing nothing until the slowest checkpoint
    // (20D) is ready.
    const res = await query(`
        SELECT
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE return_5d_pct  IS NOT NULL)::int AS n_5d,
            COUNT(*) FILTER (WHERE return_10d_pct IS NOT NULL)::int AS n_10d,
            COUNT(*) FILTER (WHERE return_20d_pct IS NOT NULL)::int AS n_20d,
            ROUND(AVG(mfe_pct)::numeric, 2)        AS avg_mfe_pct,
            ROUND(AVG(mae_pct)::numeric, 2)        AS avg_mae_pct,
            ROUND(AVG(return_5d_pct)::numeric, 2)  AS avg_return_5d_pct,
            ROUND(AVG(return_10d_pct)::numeric, 2) AS avg_return_10d_pct,
            ROUND(AVG(return_20d_pct)::numeric, 2) AS avg_return_20d_pct,
            COUNT(*) FILTER (WHERE return_20d_pct > 0)::int AS would_have_won
        FROM trade_forward_tracking
        WHERE recorded_at >= NOW() - ($1 || ' days')::interval
    `, [days]);
    return res.rows[0];
}

/**
 * Breaks down average MFE/MAE by WHY the trade eventually exited — the
 * question the raw aggregate above can't answer on its own: are stop-losses
 * cutting real winners short (high avg MFE before the stop), or catching
 * weak entries that barely moved favorably before drawing down (low avg
 * MFE, meaningful avg MAE)? Those are different problems needing different
 * fixes (stop width vs. entry-signal quality), and this is the first place
 * that separates them with real forward-tracked data instead of guessing
 * from hold-time patterns.
 *
 * Added 2026-09-18, investigating why kmadined's live account was down for
 * the month despite every non-stop-loss exit type being net profitable:
 * half of all exits were stop-losses, and this breakdown showed most of
 * them had barely gone positive at all (avg MFE a few percent) before
 * reversing — an entry-quality signal, not a "the stop cut off a real
 * winner" one (which would show a much higher avg MFE for that bucket).
 *
 * Classifies via `trades.notes`, since there's no dedicated exit-category
 * column — mirrors enhancedAITradingBot.js's own inline `_exitCategory`
 * classification (built from the live-detected `reason` string) plus the
 * separate `exitReasonTag` labels positionReconciliationService.js writes
 * for broker-side exits it catches after the fact, unified into the same
 * category names so both populations compare like-for-like.
 */
async function getMfeMaeByExitCategory(userId, { days = 90 } = {}) {
    await _ensureSchema();
    // ft.trade_id links to the BUY that opened the position (recordTradeEntry fires
    // right after a buy fills) — there's no lot-tracking linking a BUY to whichever
    // SELL(s) eventually closed it, so the closing sell is approximated as the
    // earliest SELL for the same user+symbol dated after the buy. Good enough for
    // the common single-lot case; a symbol with multiple round trips in the window
    // attributes each buy's forward MFE/MAE to its own first subsequent sell, which
    // is still a reasonable per-entry pairing, just not a guaranteed exact one.
    const res = await query(`
        SELECT
            CASE
                WHEN sell.notes ILIKE 'Stop-loss triggered%'                       OR sell.notes ILIKE '%exit type: stop_loss_reconciled%'       THEN 'stop_loss'
                WHEN sell.notes ILIKE 'Trailing stop%'                             OR sell.notes ILIKE '%exit type: trailing_stop_reconciled%'   THEN 'trailing_stop'
                WHEN sell.notes ILIKE 'Break-even protection%'                                                                                   THEN 'break_even'
                WHEN sell.notes ILIKE 'Early partial take-profit%' OR sell.notes ILIKE 'Partial take-profit%'
                     OR sell.notes ILIKE '%exit type: partial_profit_reconciled%'                                                                THEN 'partial_take_profit'
                WHEN sell.notes ILIKE 'Take-profit target%'                        OR sell.notes ILIKE '%exit type: take_profit_reconciled%'
                     OR sell.notes ILIKE '%exit type: protective_limit_reconciled%'                                                              THEN 'take_profit'
                WHEN sell.notes ILIKE 'Pre-earnings%'                                                                                            THEN 'pre_earnings_exit'
                WHEN sell.notes ILIKE 'Swing max-hold partial%'                                                                                  THEN 'max_hold_partial'
                WHEN sell.notes ILIKE 'Swing max-hold%'                                                                                          THEN 'max_hold_time'
                WHEN sell.notes ILIKE 'Slow mover%'                                                                                              THEN 'slow_mover'
                WHEN sell.notes ILIKE 'Quality score decay%'                                                                                     THEN 'quality_decay'
                WHEN sell.notes ILIKE '%exit type: market_exit_reconciled%'                                                                      THEN 'reconciler_market_exit'
                WHEN sell.id IS NULL                                                                                                             THEN 'still_open'
                ELSE 'other'
            END AS exit_category,
            COUNT(*)::int                                       AS n,
            COUNT(*) FILTER (WHERE ft.mfe_pct IS NOT NULL)::int AS n_with_mfe,
            ROUND(AVG(ft.mfe_pct)::numeric, 2)                  AS avg_mfe_pct,
            ROUND(AVG(ft.mae_pct)::numeric, 2)                  AS avg_mae_pct,
            ROUND(AVG(sell.pnl_percent)::numeric, 2)            AS avg_realized_pnl_pct,
            ROUND(SUM(sell.pnl)::numeric, 2)                    AS total_pnl
        FROM trade_forward_tracking ft
        JOIN trades buy ON buy.id = ft.trade_id
        LEFT JOIN LATERAL (
            SELECT s.id, s.notes, s.pnl, s.pnl_percent
            FROM trades s
            WHERE s.user_id = buy.user_id AND s.symbol = buy.symbol AND s.action = 'SELL'
              AND s.status != 'VOIDED' AND s.trade_date >= buy.trade_date
            ORDER BY s.trade_date ASC
            LIMIT 1
        ) sell ON true
        WHERE ft.user_id = $1
          AND ft.recorded_at >= NOW() - ($2 || ' days')::interval
        GROUP BY exit_category
        ORDER BY total_pnl ASC NULLS LAST
    `, [String(userId), days]);
    return res.rows;
}

function startTradeForwardTrackingScheduler() {
    if (job) {
        logger.warn('[TradeForwardTracking] Scheduler already running');
        return;
    }

    // Same 6:00 PM ET slot as shadowTradeService's own update — both need to be
    // current before either report reads them, and neither depends on the other's
    // run order (independent tables, independent update loops).
    job = cron.schedule('0 18 * * 1-5', async () => {
        logger.info('[TradeForwardTracking] Cron triggered — updating trade forward tracking');
        try {
            await updateTradeForwardTracking();
        } catch (err) {
            logger.error('[TradeForwardTracking] Cron job failed', { error: err.message });
        }
    }, CRON_TZ);

    logger.info('[TradeForwardTracking] Scheduler started — daily update 6:00 PM ET');
}

function stopTradeForwardTrackingScheduler() {
    if (job) {
        job.stop();
        job = null;
        logger.info('[TradeForwardTracking] Scheduler stopped');
    }
}

module.exports = {
    recordTradeEntry,
    updateTradeForwardTracking,
    getActualBuyAttribution,
    getMfeMaeByExitCategory,
    startTradeForwardTrackingScheduler,
    stopTradeForwardTrackingScheduler,
};
