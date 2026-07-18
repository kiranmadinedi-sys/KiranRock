/**
 * EOD Ingestion Service — Data Warehouse Builder
 * ================================================
 * Proactively pulls end-of-day OHLCV bars for the entire symbol universe
 * and stores them in the local daily_bars table.
 *
 * KEY ARCHITECTURE:
 *   Polygon's grouped daily bars endpoint returns ALL ~8,000 US stocks in ONE
 *   API call. 450+ universe symbols are ingested in a single request rather than
 *   450 individual provider calls. This is the core efficiency driver.
 *
 * DAILY SCHEDULE (6:30 PM ET, Mon–Fri):
 *   4:00 PM  — Market closes
 *   4:00–6:00 PM — Polygon publishes consolidated OHLCV (SIP + CT feeds)
 *   6:30 PM  — This service fetches grouped bars (30-min buffer for data propagation)
 *
 * SPLIT SAFETY:
 *   When a stock splits, Polygon retroactively adjusts ALL historical prices.
 *   Our cached pre-split prices become stale/inconsistent. We detect splits by
 *   comparing today's adjusted open (Polygon) vs yesterday's cached close (local DB).
 *   If the ratio matches a known split factor (within 4% tolerance), we:
 *     1. DELETE all rows for that symbol from daily_bars
 *     2. Re-fetch 500 days of adjusted history from Polygon
 *   This ensures indicators (RSI, MACD, SMA) always compute on consistent price series.
 *
 * GROWTH TRAJECTORY:
 *   After 6 months of daily runs, analyzeStockWithAI reads 100% from local DB —
 *   zero Polygon bar calls during the nightly scan, cutting scan time by ~80%.
 */

'use strict';

const cron  = require('node-cron');
const axios = require('axios');
const { query }  = require('../config/database');
const { logger } = require('../utils/logger');

// ── Constants ────────────────────────────────────────────────────────────────

const POLYGON_BASE        = 'https://api.polygon.io';
const FULL_HISTORY_DAYS   = 500;   // days of history for split-invalidated / new symbols
const BATCH_UPSERT_SIZE   = 500;   // rows per INSERT batch
const PARALLEL_REFETCH    = 3;     // concurrent full-history fetches (rate-limit aware)
const REFETCH_DELAY_MS    = 700;   // ms between parallel refetch batches
const CRON_TZ             = { timezone: 'America/New_York' };

let job = null;

// ── Polygon helpers ──────────────────────────────────────────────────────────

function hasPolygonKey() { return Boolean(process.env.POLYGON_API_KEY); }
function polygonKey()    { return process.env.POLYGON_API_KEY; }

/**
 * Fetch ALL US equity daily bars for one trading date in a SINGLE API call.
 *
 * Polygon grouped endpoint: /v2/aggs/grouped/locale/us/market/stocks/{date}
 * Returns every listed US stock — we filter to our universe after the call.
 *
 * @param {string} dateStr  YYYY-MM-DD
 * @returns {Array<{symbol, timestamp, open, high, low, close, volume}>}
 */
async function fetchGroupedDailyBars(dateStr) {
    const resp = await axios.get(
        `${POLYGON_BASE}/v2/aggs/grouped/locale/us/market/stocks/${dateStr}`,
        {
            params:  { adjusted: true, apiKey: polygonKey() },
            timeout: 30000
        }
    );

    const results = resp.data.results;
    if (!results || results.length === 0) {
        const status = resp.data.status || 'unknown';
        logger.warn('[EOD] Polygon grouped bars: no results', { date: dateStr, status });
        return [];
    }

    return results.map(b => ({
        symbol:    b.T,
        timestamp: new Date(b.t),
        open:      b.o,
        high:      b.h,
        low:       b.l,
        close:     b.c,
        volume:    Math.round(b.v || 0),
    }));
}

/**
 * Fetch full adjusted history for a single symbol.
 * Used for: (a) splits — get clean re-adjusted series; (b) new symbols — backfill.
 *
 * @param {string} symbol
 * @param {number} days   lookback window (default 500)
 * @returns {Array<{symbol, timestamp, open, high, low, close, volume}>}
 */
async function fetchFullHistory(symbol, days = FULL_HISTORY_DAYS) {
    const from = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const to   = new Date().toISOString().split('T')[0];
    const url  = `${POLYGON_BASE}/v2/aggs/ticker/${symbol}/range/1/day/${from}/${to}`;
    try {
        const resp = await axios.get(url, {
            params:  { apiKey: polygonKey(), limit: 5000, adjusted: true },
            timeout: 15000
        });
        return (resp.data.results || []).map(b => ({
            symbol,
            timestamp: new Date(b.t),
            open:   b.o,
            high:   b.h,
            low:    b.l,
            close:  b.c,
            volume: Math.round(b.v || 0),
        }));
    } catch (err) {
        logger.warn(`[EOD] Full history fetch failed for ${symbol}`, { error: err.message });
        return [];
    }
}

// ── Local DB helpers ─────────────────────────────────────────────────────────

/**
 * Batch-load the most recent closing price for each symbol in one query.
 * Used to detect price discontinuities (splits) before upserting today's bar.
 *
 * @param {string[]} symbols
 * @returns {Map<string, number>}  symbol → lastClose
 */
async function getLastCloseMap(symbols) {
    if (!symbols.length) return new Map();
    try {
        // DISTINCT ON ensures we get exactly the latest bar per symbol.
        const result = await query(
            `SELECT DISTINCT ON (symbol) symbol, close::float AS close
             FROM daily_bars
             WHERE symbol = ANY($1)
             ORDER BY symbol, timestamp DESC`,
            [symbols]
        );
        return new Map(result.rows.map(r => [r.symbol, parseFloat(r.close)]));
    } catch (err) {
        logger.warn('[EOD] getLastCloseMap failed', { error: err.message });
        return new Map();
    }
}

/**
 * Batch-upsert bars into daily_bars.
 *
 * Uses DO UPDATE (not DO NOTHING) so that Polygon's retroactive adjustments
 * (e.g., dividend corrections) propagate on each nightly run.
 *
 * @param {Array}  bars
 * @returns {number} rows processed
 */
async function upsertBarsBatch(bars) {
    if (!bars.length) return 0;
    const clean = bars.filter(b => b.symbol && b.timestamp && b.close != null);
    if (!clean.length) return 0;

    let total = 0;
    for (let i = 0; i < clean.length; i += BATCH_UPSERT_SIZE) {
        const chunk = clean.slice(i, i + BATCH_UPSERT_SIZE);
        const vals = [], params = [];
        let p = 1;
        chunk.forEach(b => {
            vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
            params.push(
                b.symbol,
                b.timestamp instanceof Date ? b.timestamp : new Date(b.timestamp),
                b.open   ?? b.close,
                b.high   ?? b.close,
                b.low    ?? b.close,
                b.close,
                b.volume ?? 0
            );
        });
        await query(
            `INSERT INTO daily_bars (symbol, timestamp, open, high, low, close, volume)
             VALUES ${vals.join(',')}
             ON CONFLICT (symbol, timestamp) DO UPDATE
               SET open   = EXCLUDED.open,
                   high   = EXCLUDED.high,
                   low    = EXCLUDED.low,
                   close  = EXCLUDED.close,
                   volume = EXCLUDED.volume`,
            params
        );
        total += chunk.length;
    }
    return total;
}

/**
 * Delete all cached bars for a symbol.
 * Called when a split is detected — stale pre-split prices must be purged
 * before inserting the re-adjusted history so indicators compute correctly.
 */
async function purgeSymbol(symbol) {
    const res = await query(`DELETE FROM daily_bars WHERE symbol = $1`, [symbol]);
    return res.rowCount || 0;
}

// ── Split detection ──────────────────────────────────────────────────────────

// Known forward / reverse split ratios and their price-ratio effect.
// After a 2:1 forward split Polygon serves prices at ~50% of pre-split level,
// so todayAdjOpen / yesterdayCachedClose ≈ 0.500.
const SPLIT_RATIOS = [
    { inverse: 0.5000, label: '2:1 forward'   },
    { inverse: 0.3333, label: '3:1 forward'   },
    { inverse: 0.2500, label: '4:1 forward'   },
    { inverse: 0.2000, label: '5:1 forward'   },
    { inverse: 0.1000, label: '10:1 forward'  },
    { inverse: 2.0000, label: '1:2 reverse'   },
    { inverse: 4.0000, label: '1:4 reverse'   },
    { inverse: 10.000, label: '1:10 reverse'  },
];

// 4% tolerance — tight to avoid false positives from earnings gap-downs.
// A genuine 50% crash (e.g., biotech FDA rejection) is extremely rare for liquid
// large-caps and has ratio 0.5, same as a 2:1 split. We accept this trade-off;
// the alert in the Telegram message lets the user review manually if needed.
const SPLIT_TOLERANCE = 0.04;

/**
 * Return split metadata if today's open vs yesterday's close suggests a split,
 * or null if the gap is within normal price action (±30%).
 *
 * @param {number} todayOpen   adjusted open from Polygon (post-split price)
 * @param {number} lastClose   cached close from daily_bars (pre-split price)
 * @returns {{ ratio, expected, label } | null}
 */
function detectSplit(todayOpen, lastClose) {
    if (!todayOpen || !lastClose || lastClose < 1) return null;
    const ratio = todayOpen / lastClose;

    // Normal intraday gap range — definitely not a split
    if (ratio > 0.70 && ratio < 1.45) return null;

    for (const s of SPLIT_RATIOS) {
        if (Math.abs(ratio - s.inverse) / s.inverse <= SPLIT_TOLERANCE) {
            return { ratio: +ratio.toFixed(5), expected: s.inverse, label: s.label };
        }
    }

    // Large gap that doesn't match a known split ratio — log but do NOT invalidate.
    // This protects against false positives from crashes, halts, or delistings.
    logger.warn('[EOD] Large unexplained price gap — NOT invalidating cache', {
        ratio: +ratio.toFixed(4), todayOpen, lastClose,
        note: 'Possible crash/halt, not a standard split ratio'
    });
    return null;
}

// ── Telegram ─────────────────────────────────────────────────────────────────

// Bar-ingestion completion is an ops concern (did the data pipeline run
// cleanly?), not any individual trader's business — admin-only, single send.
async function sendTelegramAlert(message) {
    try {
        const telegramAlertService = require('./telegramAlertService');
        await telegramAlertService.sendAdminMessage(message, 'HTML');
    } catch { /* non-fatal — never block ingestion for a notification failure */ }
}

// ── Full-refetch batch (splits + new symbols) ─────────────────────────────────

/**
 * Purge stale data (splits) and re-fetch full adjusted history for each symbol.
 * Runs PARALLEL_REFETCH symbols concurrently with a small delay between batches
 * to stay within Polygon's rate limits on the free / starter plan.
 *
 * @param {Array<{symbol, reason}>} items
 * @param {object} result  — mutated in place with counts/errors
 */
async function runFullRefetchBatch(items, result) {
    for (let i = 0; i < items.length; i += PARALLEL_REFETCH) {
        const batch = items.slice(i, i + PARALLEL_REFETCH);
        await Promise.all(batch.map(async ({ symbol, reason }) => {
            try {
                if (reason === 'split') {
                    const purged = await purgeSymbol(symbol);
                    logger.info('[EOD] Pre-split cache purged', { symbol, rows: purged });
                }
                const bars = await fetchFullHistory(symbol, FULL_HISTORY_DAYS);
                if (bars.length) {
                    const n = await upsertBarsBatch(bars);
                    result.barsUpserted += n;
                    logger.info('[EOD] Full history stored', { symbol, bars: n, reason });
                } else {
                    logger.warn('[EOD] Full history returned no bars', { symbol });
                }
            } catch (err) {
                logger.warn('[EOD] Full refetch failed', { symbol, error: err.message });
                result.errors.push(`${symbol}: ${err.message}`);
            }
        }));
        if (i + PARALLEL_REFETCH < items.length) {
            await new Promise(r => setTimeout(r, REFETCH_DELAY_MS));
        }
    }
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run the complete EOD bar ingestion for one trading date.
 *
 * Steps:
 *   1. Load symbol universe
 *   2. Fetch ALL US stock bars for `tradingDate` in one Polygon grouped call
 *   3. Load last-close prices from daily_bars for split detection
 *   4. Classify each symbol: normal upsert | split (purge+refetch) | new (backfill)
 *   5. Batch-upsert normal bars (fast path — no extra API calls)
 *   6. Full refetch for splits and new symbols (slow path — per-symbol API calls)
 *   7. Send Telegram summary
 *
 * @param {object} [options]
 * @param {string}  [options.tradingDate]  YYYY-MM-DD (defaults to today ET)
 * @param {boolean} [options.forceAll]     skip split logic; upsert every bar as-is
 */
async function runEodIngestion(options = {}) {
    const startTime = Date.now();
    const tradingDate = options.tradingDate
        || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

    logger.info('[EOD] Starting EOD bar ingestion', { date: tradingDate });

    if (!hasPolygonKey()) {
        logger.warn('[EOD] POLYGON_API_KEY not set — skipping EOD ingestion');
        return { skipped: true, reason: 'no-polygon-key' };
    }

    const result = {
        date:           tradingDate,
        barsUpserted:   0,
        splitsDetected: [],
        newSymbols:     [],
        missingBars:    0,
        errors:         [],
        durationMs:     0,
    };

    try {
        // STEP 1 — Universe
        const { getStockOnlySymbolList } = require('./marketScreenerService');
        const universe = await getStockOnlySymbolList();
        logger.info('[EOD] Universe loaded', { symbols: universe.length });

        // STEP 2 — ONE Polygon call → bars for all ~8k US stocks
        let allBars;
        try {
            allBars = await fetchGroupedDailyBars(tradingDate);
        } catch (err) {
            logger.error('[EOD] Polygon grouped fetch failed', { date: tradingDate, error: err.message });
            result.errors.push(`grouped-fetch: ${err.message}`);
            result.durationMs = Date.now() - startTime;
            return result;
        }

        const barMap = new Map(allBars.map(b => [b.symbol, b]));
        const inUniverse = universe.filter(s => barMap.has(s)).length;
        logger.info('[EOD] Polygon bars received', {
            totalUS:    allBars.length,
            inUniverse,
            missing:    universe.length - inUniverse,
        });

        // STEP 3 — Last-close map for split detection
        const lastCloseMap = await getLastCloseMap(universe);

        // STEP 4 — Classify
        const toUpsert      = [];
        const toFullRefetch = [];

        for (const symbol of universe) {
            const bar = barMap.get(symbol);
            if (!bar) { result.missingBars++; continue; }

            const lastClose = lastCloseMap.get(symbol);

            if (!lastClose) {
                // Brand-new to our DB — needs full 500-day backfill
                result.newSymbols.push(symbol);
                toFullRefetch.push({ symbol, reason: 'new' });
                continue;
            }

            if (!options.forceAll) {
                const split = detectSplit(bar.open, lastClose);
                if (split) {
                    logger.warn('[EOD] Split detected — queuing full refetch', { symbol, ...split });
                    result.splitsDetected.push({ symbol, ...split });
                    toFullRefetch.push({ symbol, reason: 'split' });
                    continue;
                }
            }

            toUpsert.push(bar);
        }

        // STEP 5 — Fast path: batch-upsert today's bar for normal symbols
        if (toUpsert.length) {
            result.barsUpserted += await upsertBarsBatch(toUpsert);
            logger.info('[EOD] Today\'s bars upserted (fast path)', { count: result.barsUpserted });
        }

        // STEP 6 — Slow path: full history for splits and new symbols
        if (toFullRefetch.length) {
            logger.info('[EOD] Full history refetch starting', {
                splits: result.splitsDetected.length,
                new:    result.newSymbols.length,
            });
            await runFullRefetchBatch(toFullRefetch, result);
        }

        result.durationMs = Date.now() - startTime;
        logger.info('[EOD] Ingestion complete', {
            date:        result.date,
            bars:        result.barsUpserted,
            splits:      result.splitsDetected.length,
            newSymbols:  result.newSymbols.length,
            missingBars: result.missingBars,
            errors:      result.errors.length,
            durationMs:  result.durationMs,
        });

        // STEP 7 — Telegram summary
        const splitLine = result.splitsDetected.length
            ? `\n⚡ <b>Splits</b>: ${result.splitsDetected.map(s => `${s.symbol} (${s.label})`).join(', ')}`
            : '';
        const newLine = result.newSymbols.length
            ? `\n🆕 New symbols backfilled: ${result.newSymbols.slice(0, 8).join(', ')}${result.newSymbols.length > 8 ? '…' : ''}`
            : '';
        const errLine = result.errors.length
            ? `\n⚠️ Errors: ${result.errors.length}`
            : '';

        await sendTelegramAlert(
            `📊 <b>EOD Bar Ingestion</b> — ${tradingDate}\n` +
            `✅ Bars stored: ${result.barsUpserted.toLocaleString()}\n` +
            `🔍 Universe: ${universe.length} symbols | Missing: ${result.missingBars}\n` +
            `⏱ Duration: ${(result.durationMs / 1000).toFixed(1)}s` +
            splitLine + newLine + errLine
        );

    } catch (err) {
        logger.error('[EOD] Ingestion failed unexpectedly', { error: err.message, stack: err.stack });
        result.errors.push(err.message);
        result.durationMs = Date.now() - startTime;
    }

    return result;
}

/**
 * Backfill specific symbols that have no history in daily_bars.
 * Called when new symbols are added to the universe mid-cycle (e.g., new IPOs
 * detected by getRecentIPOSymbols() that weren't caught in the last EOD run).
 *
 * @param {string[]} symbols
 */
async function backfillNewSymbols(symbols) {
    if (!symbols.length) return { backfilled: 0, symbols: 0 };
    if (!hasPolygonKey()) return { skipped: true, reason: 'no-polygon-key' };

    logger.info('[EOD] Backfilling new symbols', { count: symbols.length });

    const lastCloseMap = await getLastCloseMap(symbols);
    const toFetch = symbols.filter(s => !lastCloseMap.has(s));

    if (!toFetch.length) {
        logger.info('[EOD] All symbols already have history — no backfill needed');
        return { backfilled: 0, symbols: 0 };
    }

    const dummy = { barsUpserted: 0, errors: [] };
    await runFullRefetchBatch(toFetch.map(s => ({ symbol: s, reason: 'new' })), dummy);

    logger.info('[EOD] Backfill complete', { symbols: toFetch.length, bars: dummy.barsUpserted });
    return { backfilled: dummy.barsUpserted, symbols: toFetch.length };
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

/**
 * Start the EOD ingestion cron job.
 *
 * Runs at 6:30 PM ET Monday–Friday — 2.5 hours after market close,
 * giving Polygon time to consolidate SIP + CT feeds into final OHLCV.
 *
 * Called once from worker.js at startup.
 */
function startEodScheduler() {
    if (job) {
        logger.warn('[EOD] Scheduler already running');
        return;
    }

    job = cron.schedule('30 18 * * 1-5', async () => {
        logger.info('[EOD] Cron triggered — EOD ingestion starting');
        try {
            await runEodIngestion();
        } catch (err) {
            logger.error('[EOD] Cron job failed', { error: err.message });
        }
    }, CRON_TZ);

    logger.info('[EOD] Scheduler started — runs at 6:30 PM ET, Mon–Fri');
}

function stopEodScheduler() {
    if (job) {
        job.stop();
        job = null;
        logger.info('[EOD] Scheduler stopped');
    }
}

module.exports = {
    runEodIngestion,
    backfillNewSymbols,
    startEodScheduler,
    stopEodScheduler,
};
