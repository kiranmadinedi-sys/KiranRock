/**
 * Company Name + Market Cap Lookup — for the Most Active page (2026-07-12, extended
 * 2026-07-13 for market cap). Both fields come from the same Polygon reference call and
 * essentially never change day-to-day, so they're cached permanently: in-memory first,
 * then ticker_company_names (survives restarts), and only fetched from Polygon for
 * symbols never seen before. A bulk lookup runs uncached symbols with limited
 * concurrency instead of firing 100 simultaneous requests at Polygon.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const _memCache = new Map(); // symbol -> { name, marketCap }
const CONCURRENCY = 5;

async function _fetchFromPolygon(symbol) {
    const apiKey = process.env.POLYGON_API_KEY;
    if (!apiKey) return null;
    try {
        const resp = await axios.get(`https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(symbol)}`, {
            params: { apiKey },
            timeout: 5000
        });
        const r = resp.data?.results;
        if (!r) return null;
        return { name: r.name || null, marketCap: r.market_cap != null ? Number(r.market_cap) : null };
    } catch (err) {
        logger.debug('[CompanyName] Polygon lookup failed', { symbol, error: err.message });
        return null;
    }
}

async function getCompanyInfo(symbol) {
    const sym = symbol.toUpperCase();
    if (_memCache.has(sym)) return _memCache.get(sym);

    try {
        const cached = await query('SELECT name, market_cap FROM ticker_company_names WHERE symbol = $1', [sym]);
        // A row cached before market_cap was tracked (or backfilled from a symbol Polygon
        // has no cap for) has market_cap NULL — treat that as incomplete and re-fetch,
        // rather than permanently serving a stale null.
        if (cached.rows[0] && cached.rows[0].market_cap != null) {
            const info = { name: cached.rows[0].name, marketCap: Number(cached.rows[0].market_cap) };
            _memCache.set(sym, info);
            return info;
        }
    } catch (err) {
        logger.debug('[CompanyName] DB cache read failed', { symbol: sym, error: err.message });
    }

    const info = await _fetchFromPolygon(sym);
    if (info) {
        _memCache.set(sym, info);
        query(
            `INSERT INTO ticker_company_names (symbol, name, market_cap) VALUES ($1, $2, $3)
             ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name, market_cap = EXCLUDED.market_cap, cached_at = NOW()`,
            [sym, info.name, info.marketCap]
        ).catch(err => logger.debug('[CompanyName] DB cache write failed', { symbol: sym, error: err.message }));
    }
    return info;
}

/** Resolves { name, marketCap } for many symbols at once, batching uncached lookups with limited concurrency. */
async function getCompanyInfoBatch(symbols) {
    const unique = [...new Set(symbols.map(s => s.toUpperCase()))];
    const result = {};

    const uncached = [];
    for (const sym of unique) {
        if (_memCache.has(sym)) {
            result[sym] = _memCache.get(sym);
        } else {
            uncached.push(sym);
        }
    }
    if (uncached.length > 0) {
        try {
            const dbRows = await query('SELECT symbol, name, market_cap FROM ticker_company_names WHERE symbol = ANY($1)', [uncached]);
            for (const row of dbRows.rows) {
                // Same staleness check as getCompanyInfo — a pre-market_cap cached row
                // must not short-circuit here, or it never gets backfilled.
                if (row.market_cap == null) continue;
                const info = { name: row.name, marketCap: Number(row.market_cap) };
                result[row.symbol] = info;
                _memCache.set(row.symbol, info);
            }
        } catch (err) {
            logger.debug('[CompanyName] Bulk DB cache read failed', { error: err.message });
        }
    }

    const stillMissing = unique.filter(sym => !result[sym]);
    for (let i = 0; i < stillMissing.length; i += CONCURRENCY) {
        const batch = stillMissing.slice(i, i + CONCURRENCY);
        const infos = await Promise.all(batch.map(sym => getCompanyInfo(sym)));
        batch.forEach((sym, idx) => { if (infos[idx]) result[sym] = infos[idx]; });
    }

    return result;
}

async function getCompanyName(symbol) {
    const info = await getCompanyInfo(symbol);
    return info?.name || null;
}

/** Resolves names for many symbols at once (legacy shape — name string only). */
async function getCompanyNames(symbols) {
    const infoMap = await getCompanyInfoBatch(symbols);
    const result = {};
    for (const [sym, info] of Object.entries(infoMap)) {
        if (info?.name) result[sym] = info.name;
    }
    return result;
}

module.exports = { getCompanyName, getCompanyNames, getCompanyInfo, getCompanyInfoBatch };
