/**
 * Market Review Service
 *
 * Daily capture of the FULL scan universe (every ticker analyzed, not just the ones
 * the bot traded) into market_review_snapshots, with forward returns backfilled once
 * enough calendar time has passed. Purpose: compare the AI score/recommendation against
 * what the market actually did — independent of what the bot chose to trade — so scoring
 * changes can be justified with real outcome data instead of a single day's anecdote.
 *
 * Runs daily (see scheduleTelegramReport.js, 4:25 PM ET) — read-only/analytics, no effect
 * on trading logic.
 */

const { query } = require('../config/database');
const { logger } = require('../utils/logger');
const marketRegimeService = require('./marketRegimeService');

async function captureDailySnapshot() {
    const today = new Date().toISOString().slice(0, 10);

    const scanRows = await query(`
        SELECT symbol, ai_score, recommendation, sector, setup_family, tier, metadata->>'price' AS price
        FROM daily_universe_analysis
        WHERE analysis_date::date = $1::date
    `, [today]);

    if (scanRows.rows.length === 0) {
        logger.warn('[MarketReview] No scan rows found for today — skipping capture', { today });
        return { captured: 0 };
    }

    const tradedRes = await query(`SELECT DISTINCT symbol FROM trades WHERE trade_date::date = $1::date`, [today]);
    const tradedSymbols = new Set(tradedRes.rows.map(r => r.symbol));

    // Per-symbol gate rejections recorded live by the buy loop today (shadow-portfolio groundwork).
    const rejectionRes = await query(`SELECT symbol, reason FROM trade_rejection_log WHERE rejection_date = $1::date`, [today]);
    const rejectionBySymbol = new Map(rejectionRes.rows.map(r => [r.symbol, r.reason]));

    // Regime is a market-wide state, not per-ticker — one lookup covers the whole day's snapshot.
    let regimeLabel = null;
    try {
        const regimeData = await marketRegimeService.getMarketRegime();
        regimeLabel = regimeData?.regimeType || regimeData?.regime || null;
    } catch (_regimeErr) {
        logger.warn('[MarketReview] Regime lookup failed — capturing without it', { error: _regimeErr.message });
    }

    let captured = 0;
    for (const row of scanRows.rows) {
        const price = row.price != null ? parseFloat(row.price) : null;
        const blockedReason = rejectionBySymbol.get(row.symbol) || null;
        try {
            await query(`
                INSERT INTO market_review_snapshots
                    (scan_date, symbol, ai_score, recommendation, sector, setup_family, tier, regime, price_at_scan, was_traded, blocked_reason)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                ON CONFLICT (scan_date, symbol) DO UPDATE SET
                    ai_score       = EXCLUDED.ai_score,
                    recommendation = EXCLUDED.recommendation,
                    regime         = EXCLUDED.regime,
                    was_traded     = EXCLUDED.was_traded,
                    blocked_reason = EXCLUDED.blocked_reason,
                    updated_at     = NOW()
            `, [today, row.symbol, row.ai_score, row.recommendation, row.sector, row.setup_family, row.tier, regimeLabel, price, tradedSymbols.has(row.symbol), blockedReason]);
            captured++;
        } catch (err) {
            logger.warn('[MarketReview] Failed to capture snapshot row', { symbol: row.symbol, error: err.message });
        }
    }

    logger.info('[MarketReview] Daily snapshot captured', { date: today, captured, traded: tradedSymbols.size, regime: regimeLabel });
    return { captured };
}

async function backfillForwardReturns() {
    const pending = await query(`
        SELECT id, scan_date, symbol, price_at_scan
        FROM market_review_snapshots
        WHERE scan_date < CURRENT_DATE
          AND price_at_scan IS NOT NULL
          AND (return_1d_pct IS NULL OR return_3d_pct IS NULL OR return_5d_pct IS NULL)
        ORDER BY scan_date ASC
        LIMIT 2000
    `);

    let updated = 0;
    for (const row of pending.rows) {
        try {
            // Next up-to-5 distinct trading days' closes after scan_date — dedupes the
            // occasional double bar-per-day rows in daily_bars via DISTINCT ON.
            const bars = await query(`
                SELECT day, close FROM (
                    SELECT DISTINCT ON (timestamp::date) timestamp::date AS day, close
                    FROM daily_bars
                    WHERE symbol = $1 AND timestamp::date > $2::date
                    ORDER BY timestamp::date, timestamp DESC
                ) t
                ORDER BY day ASC
                LIMIT 5
            `, [row.symbol, row.scan_date]);

            if (bars.rows.length === 0) continue;

            const priceAtScan = parseFloat(row.price_at_scan);
            const closeAt = (idx) => bars.rows[idx] ? parseFloat(bars.rows[idx].close) : null;
            const pct = (c) => (c != null && priceAtScan > 0)
                ? Number((((c - priceAtScan) / priceAtScan) * 100).toFixed(3))
                : null;

            const c1 = closeAt(0), c3 = closeAt(2), c5 = closeAt(4);

            await query(`
                UPDATE market_review_snapshots
                SET close_1d = $1, return_1d_pct = $2,
                    close_3d = $3, return_3d_pct = $4,
                    close_5d = $5, return_5d_pct = $6,
                    updated_at = NOW()
                WHERE id = $7
            `, [c1, pct(c1), c3, pct(c3), c5, pct(c5), row.id]);
            updated++;
        } catch (err) {
            logger.warn('[MarketReview] Backfill failed for row', { symbol: row.symbol, error: err.message });
        }
    }

    logger.info('[MarketReview] Forward-return backfill complete', { checked: pending.rows.length, updated });
    return { updated };
}

async function runDailyMarketReview() {
    const captureResult  = await captureDailySnapshot();
    const backfillResult = await backfillForwardReturns();
    return { ...captureResult, ...backfillResult };
}

module.exports = { captureDailySnapshot, backfillForwardReturns, runDailyMarketReview };
