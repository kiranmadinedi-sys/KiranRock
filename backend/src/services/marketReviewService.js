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

// Forward returns are measured from base_close — the last daily close on or before
// scan_date — not from price_at_scan. Found 2026-10-06: price_at_scan is the quote the
// nightly analysis happened to see, and in a 3,000-row sample only 8% matched the scan
// day's close (23% were the PREVIOUS day's close, 64% neither, e.g. intraday/stale
// quotes). Forward bars start the day after scan_date, so part of the scan day's own move
// leaked into every "forward" return — it made DayChange look like the single strongest
// predictor in the score (t=+16) when on clean close-to-close returns it's negative.
// price_at_scan is kept as the record of what the scan saw. Rows with no base_close are
// (re)computed, which also rebuilt all pre-fix history.
let _baseCloseColumnReady = false;

async function backfillForwardReturns() {
    if (!_baseCloseColumnReady) {
        await query(`ALTER TABLE market_review_snapshots ADD COLUMN IF NOT EXISTS base_close NUMERIC`);
        _baseCloseColumnReady = true;
    }
    // The 21-day window stops rows that can never complete (delisted symbols, no bars)
    // from being re-picked forever — ORDER BY scan_date ASC + LIMIT would otherwise let
    // enough of them permanently starve newer rows.
    const pending = await query(`
        SELECT id, scan_date, symbol, price_at_scan, (scan_date <= CURRENT_DATE - 21) AS expired
        FROM market_review_snapshots
        WHERE scan_date < CURRENT_DATE
          AND price_at_scan IS NOT NULL
          AND (
                base_close IS NULL
             OR ((return_1d_pct IS NULL OR return_3d_pct IS NULL OR return_5d_pct IS NULL)
                 AND scan_date > CURRENT_DATE - 21)
          )
        ORDER BY scan_date ASC
        LIMIT 20000
    `);
    // 20000 (was 2000): ~1,700 new rows per scan day each need several passes as 1d/3d/5d
    // bars arrive, so 2000/run fell behind permanently — the newest rows never got a turn.
    // Each row is three small indexed queries (~1ms), so a full batch is seconds.

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

            // Last close on or before scan_date (a weekend/holiday-stamped scan used the
            // prior session's data, so that close is its true starting point).
            const baseRes = await query(`
                SELECT close FROM daily_bars
                WHERE symbol = $1 AND timestamp::date <= $2::date
                ORDER BY timestamp DESC LIMIT 1
            `, [row.symbol, row.scan_date]);
            const baseClose = baseRes.rows[0] ? parseFloat(baseRes.rows[0].close) : null;
            if (!(baseClose > 0)) {
                // No price history for this symbol. Retried within the 21-day window; after
                // that, base_close = 0 marks it unresolvable so it's never re-picked.
                if (row.expired) {
                    await query(`UPDATE market_review_snapshots SET base_close = 0, updated_at = NOW() WHERE id = $1`, [row.id]);
                }
                continue;
            }

            const closeAt = (idx) => bars.rows[idx] ? parseFloat(bars.rows[idx].close) : null;
            const pct = (c) => c != null
                ? Number((((c - baseClose) / baseClose) * 100).toFixed(3))
                : null;

            const c1 = closeAt(0), c3 = closeAt(2), c5 = closeAt(4);

            await query(`
                UPDATE market_review_snapshots
                SET close_1d = $1, return_1d_pct = $2,
                    close_3d = $3, return_3d_pct = $4,
                    close_5d = $5, return_5d_pct = $6,
                    base_close = $7,
                    updated_at = NOW()
                WHERE id = $8
            `, [c1, pct(c1), c3, pct(c3), c5, pct(c5), baseClose, row.id]);
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
