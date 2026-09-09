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
    const res = await query(`
        SELECT
            COUNT(*)::int AS n,
            ROUND(AVG(mfe_pct)::numeric, 2)        AS avg_mfe_pct,
            ROUND(AVG(mae_pct)::numeric, 2)        AS avg_mae_pct,
            ROUND(AVG(return_5d_pct)::numeric, 2)  AS avg_return_5d_pct,
            ROUND(AVG(return_10d_pct)::numeric, 2) AS avg_return_10d_pct,
            ROUND(AVG(return_20d_pct)::numeric, 2) AS avg_return_20d_pct,
            COUNT(*) FILTER (WHERE return_20d_pct > 0)::int AS would_have_won
        FROM trade_forward_tracking
        WHERE closed_at IS NOT NULL
          AND recorded_at >= NOW() - ($1 || ' days')::interval
    `, [days]);
    return res.rows[0];
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
    startTradeForwardTrackingScheduler,
    stopTradeForwardTrackingScheduler,
};
