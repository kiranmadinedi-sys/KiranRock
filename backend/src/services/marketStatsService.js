/**
 * Avg Vol (3M), 52-week range/change, and a price sparkline — all derived from daily_bars,
 * which we already ingest for MFE/MAE tracking, so no new external data source is needed
 * (2026-07-13). Symbols missing enough history (new listings, sparse tickers) simply come
 * back with nulls for the fields that can't be computed, rather than a wrong estimate.
 */
const { query } = require('../config/database');

async function getMarketStats(symbols, { sparklineLen = 30 } = {}) {
    const result = {};
    if (symbols.length === 0) return result;
    symbols.forEach(s => { result[s] = { avgVolume3M: null, week52Low: null, week52High: null, week52ChangePercent: null, sparkline: [] }; });

    const [avgVolRes, rangeRes, changeRes, sparkRes] = await Promise.all([
        query(`
            SELECT symbol, AVG(volume) AS avg_vol
            FROM daily_bars
            WHERE symbol = ANY($1) AND timestamp >= NOW() - INTERVAL '95 days'
            GROUP BY symbol
        `, [symbols]),
        query(`
            SELECT symbol, MIN(low) AS lo, MAX(high) AS hi
            FROM daily_bars
            WHERE symbol = ANY($1) AND timestamp >= NOW() - INTERVAL '365 days'
            GROUP BY symbol
        `, [symbols]),
        query(`
            WITH latest_bar AS (
                SELECT DISTINCT ON (symbol) symbol, close AS latest_close
                FROM daily_bars WHERE symbol = ANY($1) ORDER BY symbol, timestamp DESC
            ),
            year_ago_bar AS (
                SELECT DISTINCT ON (symbol) symbol, close AS year_ago_close
                FROM daily_bars
                WHERE symbol = ANY($1) AND timestamp <= NOW() - INTERVAL '350 days'
                ORDER BY symbol, timestamp DESC
            )
            SELECT l.symbol, ((l.latest_close - y.year_ago_close) / NULLIF(y.year_ago_close, 0) * 100) AS change_52w
            FROM latest_bar l JOIN year_ago_bar y ON y.symbol = l.symbol
        `, [symbols]),
        query(`
            SELECT symbol, close, timestamp
            FROM (
                SELECT symbol, close, timestamp,
                       ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY timestamp DESC) AS rn
                FROM daily_bars
                WHERE symbol = ANY($1)
            ) t
            WHERE rn <= $2
            ORDER BY symbol, timestamp ASC
        `, [symbols, sparklineLen])
    ]);

    for (const row of avgVolRes.rows) {
        if (result[row.symbol]) result[row.symbol].avgVolume3M = Math.round(parseFloat(row.avg_vol)) || null;
    }
    for (const row of rangeRes.rows) {
        if (result[row.symbol]) {
            result[row.symbol].week52Low = parseFloat(row.lo);
            result[row.symbol].week52High = parseFloat(row.hi);
        }
    }
    for (const row of changeRes.rows) {
        if (result[row.symbol] && row.change_52w != null) {
            result[row.symbol].week52ChangePercent = Number(parseFloat(row.change_52w).toFixed(2));
        }
    }
    for (const row of sparkRes.rows) {
        if (result[row.symbol]) result[row.symbol].sparkline.push(parseFloat(row.close));
    }

    return result;
}

module.exports = { getMarketStats };
