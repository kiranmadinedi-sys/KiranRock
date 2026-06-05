/**
 * Daily Bars Service
 * ==================
 * Backfills and serves OHLCV data from local PostgreSQL daily_bars table.
 * Source: configured DATA_PROVIDER (alpaca / yahoo / polygon) via dataProvider.js.
 *         When DATA_PROVIDER=alpaca (default), uses Alpaca Markets API — no Yahoo rate limits.
 *
 * Schema: id, symbol, timestamp, open, high, low, close, volume, vwap, trade_count
 *
 * Usage:
 *   await dailyBarsService.backfillSymbols(['SPY','AAPL','NVDA'], 365)
 *   const bars = await dailyBarsService.getBars('AAPL', 180)
 */

const dataProvider = require('./dataProvider');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch OHLCV bars from the configured data provider (Alpaca / Yahoo / Polygon).
 * Returns array of { symbol, timestamp, open, high, low, close, volume }
 */
async function fetchFromProvider(symbol, days = 365) {
    try {
        const raw = await dataProvider.getBars(symbol, '1d', days);
        return raw
            .filter(q => q.open && q.high && q.low && q.close)
            .map(q => ({
                symbol,
                timestamp: new Date(q.time),
                open:   parseFloat((q.open  || 0).toFixed(4)),
                high:   parseFloat((q.high  || 0).toFixed(4)),
                low:    parseFloat((q.low   || 0).toFixed(4)),
                close:  parseFloat((q.close || 0).toFixed(4)),
                volume: Math.round(q.volume || 0),
                vwap:   null,
                trade_count: null,
            }));
    } catch (err) {
        logger.warn(`[DailyBars] Fetch failed for ${symbol}: ${err.message}`);
        return [];
    }
}

/**
 * Upsert bars into daily_bars table (ON CONFLICT updates close/volume).
 * Uses batched inserts of 500 rows for performance.
 */
async function upsertBars(bars) {
    if (!bars.length) return 0;
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < bars.length; i += BATCH) {
        const chunk = bars.slice(i, i + BATCH);
        const values = [];
        const params = [];
        let p = 1;
        chunk.forEach(b => {
            values.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
            params.push(b.symbol, b.timestamp, b.open, b.high, b.low, b.close, b.volume, b.vwap, b.trade_count);
        });
        const sql = `
            INSERT INTO daily_bars (symbol, timestamp, open, high, low, close, volume, vwap, trade_count)
            VALUES ${values.join(',')}
            ON CONFLICT (symbol, timestamp) DO UPDATE
              SET open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
                  close=EXCLUDED.close, volume=EXCLUDED.volume, vwap=EXCLUDED.vwap`;
        await query(sql, params);
        inserted += chunk.length;
    }
    return inserted;
}

/**
 * Ensure the unique constraint exists (idempotent).
 */
async function ensureSchema() {
    await query(`
        CREATE UNIQUE INDEX IF NOT EXISTS daily_bars_symbol_timestamp_uidx
        ON daily_bars (symbol, timestamp)
    `);
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Backfill daily_bars for a list of symbols.
 * Skips symbols that already have data newer than `gapDays` ago.
 *
 * @param {string[]} symbols
 * @param {number}   days      — lookback window (default 365)
 * @param {number}   delayMs   — delay between requests to avoid rate limits
 */
async function backfillSymbols(symbols, days = 365, delayMs = 800) {
    await ensureSchema();

    // Check which symbols are already up-to-date (have bar within last 5 calendar days)
    const cutoff = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const existing = await query(
        `SELECT DISTINCT symbol FROM daily_bars WHERE timestamp > $1`,
        [cutoff]
    );
    const upToDate = new Set(existing.rows.map(r => r.symbol));

    const toFetch = symbols.filter(s => !upToDate.has(s));
    logger.info(`[DailyBars] Backfill: ${toFetch.length} symbols to fetch, ${upToDate.size} already current`);

    let total = 0;
    for (let i = 0; i < toFetch.length; i++) {
        const sym = toFetch[i];
        const bars = await fetchFromProvider(sym, days);
        if (bars.length) {
            await upsertBars(bars);
            total += bars.length;
            logger.info(`[DailyBars] ${sym}: ${bars.length} bars stored (${i + 1}/${toFetch.length})`);
        }
        if (i < toFetch.length - 1) await sleep(delayMs);
    }
    logger.info(`[DailyBars] Backfill complete — ${total} total bars for ${toFetch.length} symbols`);
    return { fetched: toFetch.length, total };
}

/**
 * Get OHLCV bars for a symbol from local DB.
 * Falls back to Yahoo if local data is stale or missing.
 *
 * @param {string} symbol
 * @param {number} days — lookback days
 * @returns {Array<{timestamp, open, high, low, close, volume}>}
 */
async function getBars(symbol, days = 252) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await query(
        `SELECT timestamp, open, high, low, close, volume, vwap
         FROM daily_bars WHERE symbol = $1 AND timestamp >= $2
         ORDER BY timestamp ASC`,
        [symbol, since]
    );
    if (result.rows.length >= 20) return result.rows;

    // Fallback: fetch from Yahoo and cache
    logger.info(`[DailyBars] ${symbol} local data insufficient (${result.rows.length} rows) — fetching from Yahoo`);
    const bars = await fetchFromProvider(symbol, days);
    if (bars.length) {
        await ensureSchema();
        await upsertBars(bars);
    }
    return bars;
}

/**
 * Get the most recent closing price from daily_bars.
 */
async function getLastClose(symbol) {
    const r = await query(
        `SELECT close FROM daily_bars WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 1`,
        [symbol]
    );
    return r.rows[0]?.close ?? null;
}

/**
 * Compute ATR(14) from local bars — used for stop-loss sizing.
 * Returns ATR dollar value or null if insufficient data.
 */
async function getATR(symbol, period = 14) {
    const bars = await getBars(symbol, period * 3);
    if (bars.length < period + 1) return null;
    const recent = bars.slice(-period - 1);
    let atrSum = 0;
    for (let i = 1; i <= period; i++) {
        const high  = parseFloat(recent[i].high);
        const low   = parseFloat(recent[i].low);
        const prev  = parseFloat(recent[i - 1].close);
        const tr = Math.max(high - low, Math.abs(high - prev), Math.abs(low - prev));
        atrSum += tr;
    }
    return parseFloat((atrSum / period).toFixed(4));
}

/**
 * Get all distinct symbols in daily_bars.
 */
async function getAvailableSymbols() {
    const r = await query(`SELECT DISTINCT symbol FROM daily_bars ORDER BY symbol`);
    return r.rows.map(row => row.symbol);
}

/**
 * Get all symbols that have been traded (from trades + holdings tables).
 * Used to know what to backfill.
 */
async function getTradedSymbols() {
    const r = await query(`
        SELECT DISTINCT symbol FROM (
            SELECT symbol FROM trades
            UNION
            SELECT symbol FROM holdings
        ) t ORDER BY symbol
    `);
    return r.rows.map(row => row.symbol);
}

module.exports = {
    backfillSymbols,
    getBars,
    getLastClose,
    getATR,
    getAvailableSymbols,
    getTradedSymbols,
};
