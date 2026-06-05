/**
 * Historical Data Service
 * =======================
 * Downloads and caches 2 years of daily OHLCV bars for all symbols
 * in the scan universe. Data is stored in PostgreSQL `ohlcv_cache` table
 * and used by:
 *   - EVOLVE Lite (ML signal training)
 *   - LOCAL BRAIN (win-rate context)
 *   - Historical backtest engine
 *
 * Download is incremental — only fetches dates not already in the DB.
 * Rate-limited to avoid Yahoo Finance throttling (300ms between symbols).
 *
 * Usage:
 *   node -e "require('./src/services/historicalDataService').downloadAll()"
 *   Or scheduled nightly via the enhancedAIScheduler.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { query, pool } = require('../config/database');
const { logger }      = require('../utils/logger');

const DOWNLOAD_YEARS    = 2;         // years of history to maintain
const BATCH_SIZE        = 5;         // symbols per concurrent batch
const DELAY_MS          = 350;       // ms between batches (Yahoo rate limit)
const STALE_HOURS       = 20;        // re-download if last bar older than this

// ── Schema ────────────────────────────────────────────────────────────────────

async function ensureSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS ohlcv_cache (
            id         BIGSERIAL PRIMARY KEY,
            symbol     VARCHAR(10)   NOT NULL,
            date       DATE          NOT NULL,
            open       NUMERIC(14,4),
            high       NUMERIC(14,4),
            low        NUMERIC(14,4),
            close      NUMERIC(14,4) NOT NULL,
            volume     BIGINT,
            created_at TIMESTAMPTZ   DEFAULT NOW(),
            UNIQUE (symbol, date)
        )
    `);
    await query(`CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_date ON ohlcv_cache(symbol, date DESC)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ohlcv_date ON ohlcv_cache(date DESC)`);
}

// ── Download helpers ──────────────────────────────────────────────────────────

async function getYahooChart(symbol, period1, period2) {
    // Use the same YahooFinance instance as the rest of the app
    const YahooFinance = require('yahoo-finance2').default;
    const yf = new YahooFinance();
    try {
        const result = await yf.chart(symbol, {
            period1,
            period2,
            interval: '1d',
        });
        return result?.quotes || [];
    } catch (err) {
        logger.warn(`[HistData] Failed to fetch ${symbol}: ${err.message}`);
        return [];
    }
}

async function getLastStoredDate(symbol) {
    const res = await query(
        `SELECT MAX(date) AS last_date FROM ohlcv_cache WHERE symbol = $1`,
        [symbol]
    );
    return res.rows[0]?.last_date || null;
}

async function insertBars(symbol, bars) {
    if (!bars.length) return 0;
    let inserted = 0;
    for (const bar of bars) {
        if (!bar.close || !bar.date) continue;
        try {
            const d = new Date(bar.date);
            await query(`
                INSERT INTO ohlcv_cache (symbol, date, open, high, low, close, volume)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
                ON CONFLICT (symbol, date) DO UPDATE
                SET open=$3, high=$4, low=$5, close=$6, volume=$7
            `, [
                symbol,
                d.toISOString().slice(0, 10),
                bar.open  || null,
                bar.high  || null,
                bar.low   || null,
                bar.close,
                bar.volume || null,
            ]);
            inserted++;
        } catch { /* skip bad rows */ }
    }
    return inserted;
}

/**
 * Download (or update) OHLCV history for a single symbol.
 * Only fetches dates after the last stored bar.
 */
async function downloadSymbol(symbol) {
    const lastDate = await getLastStoredDate(symbol);
    const now      = new Date();
    const startDate = lastDate
        ? new Date(new Date(lastDate).getTime() + 86400000) // day after last bar
        : new Date(now.getTime() - DOWNLOAD_YEARS * 365 * 86400000);

    if (lastDate) {
        const staleHours = (now - new Date(lastDate)) / 3600000;
        if (staleHours < STALE_HOURS) return { symbol, skipped: true };
    }

    const bars = await getYahooChart(symbol, startDate, now);
    const inserted = await insertBars(symbol, bars);
    logger.debug(`[HistData] ${symbol}: +${inserted} bars (from ${startDate.toISOString().slice(0, 10)})`);
    return { symbol, inserted, from: startDate.toISOString().slice(0, 10) };
}

/**
 * Download history for all symbols in the scan universe.
 * Runs batched with rate limiting.
 */
async function downloadAll(symbols = null) {
    await ensureSchema();

    let list = symbols;
    if (!list) {
        // Use the same universe the bot scans
        const { ALL_STOCKS } = require('./stockUniverse');
        list = ALL_STOCKS.slice(0, 120); // top 120 — enough for EVOLVE training
    }

    logger.info(`[HistData] Starting download for ${list.length} symbols`);
    const results = { downloaded: 0, skipped: 0, failed: 0 };

    for (let i = 0; i < list.length; i += BATCH_SIZE) {
        const batch = list.slice(i, i + BATCH_SIZE);
        const settled = await Promise.allSettled(batch.map(s => downloadSymbol(s)));

        for (const r of settled) {
            if (r.status === 'fulfilled') {
                if (r.value.skipped) results.skipped++;
                else results.downloaded++;
            } else {
                results.failed++;
            }
        }

        if (i + BATCH_SIZE < list.length) {
            await new Promise(r => setTimeout(r, DELAY_MS));
        }

        if ((i / BATCH_SIZE) % 10 === 0) {
            logger.info(`[HistData] Progress: ${i}/${list.length} symbols`, results);
        }
    }

    logger.info(`[HistData] Download complete`, results);
    return results;
}

/**
 * Read cached OHLCV bars for a symbol (newest first, up to maxBars rows).
 * Returns array of { date, open, high, low, close, volume } oldest→newest.
 */
async function getBars(symbol, maxBars = 504) {
    const res = await query(`
        SELECT date, open, high, low, close, volume
        FROM ohlcv_cache
        WHERE symbol = $1
        ORDER BY date DESC
        LIMIT $2
    `, [symbol, maxBars]);

    // Reverse to oldest→newest (standard for indicators)
    return res.rows.reverse().map(r => ({
        date:   r.date,
        open:   parseFloat(r.open  || r.close),
        high:   parseFloat(r.high  || r.close),
        low:    parseFloat(r.low   || r.close),
        close:  parseFloat(r.close),
        volume: parseInt(r.volume  || 0),
    }));
}

/**
 * Return all symbols that have at least minBars rows in the cache.
 */
async function getCachedSymbols(minBars = 100) {
    const res = await query(`
        SELECT symbol, COUNT(*) AS bar_count, MAX(date) AS last_date
        FROM ohlcv_cache
        GROUP BY symbol
        HAVING COUNT(*) >= $1
        ORDER BY last_date DESC
    `, [minBars]);
    return res.rows;
}

// ── CLI runner ────────────────────────────────────────────────────────────────
if (require.main === module) {
    (async () => {
        await downloadAll();
        await pool.end();
    })();
}

module.exports = { ensureSchema, downloadAll, downloadSymbol, getBars, getCachedSymbols };
