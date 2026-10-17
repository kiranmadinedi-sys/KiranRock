/**
 * Research archive (built 2026-10-17): every news article and every insider trade, for
 * every ticker, kept from now on — plus a backfill to 2023 — so they can be studied
 * against price history (history_bars) the same way the price rules were.
 *
 * Why: the scan reads news and insider data live but never kept it. news_alerts covers
 * only ~16 tickers (mostly market-wide), so the Visa China-clearing and stablecoin
 * headlines (Oct 13-16) were never stored even though Alpaca's feed carried them.
 *
 *   news_archive          — Alpaca news (Benzinga), all symbols, ~1,000 articles/day.
 *                           Synced every 5-min tick (incremental), 24/7.
 *   insider_transactions  — Finnhub Form 4 transactions per symbol. Full sweep of the
 *                           scan universe every Saturday (last 60 days), rate-limited.
 *
 * Storage only: nothing here changes trading.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

let _ready = false;
async function ensureTables() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS news_archive (
            id          BIGINT      PRIMARY KEY,
            created_at  TIMESTAMPTZ NOT NULL,
            updated_at  TIMESTAMPTZ,
            headline    TEXT        NOT NULL,
            summary     TEXT,
            author      TEXT,
            source      TEXT,
            url         TEXT,
            symbols     TEXT[]      NOT NULL DEFAULT '{}'
        )`);
    await query(`CREATE INDEX IF NOT EXISTS news_archive_created_idx ON news_archive (created_at)`);
    await query(`CREATE INDEX IF NOT EXISTS news_archive_symbols_idx ON news_archive USING GIN (symbols)`);
    await query(`
        CREATE TABLE IF NOT EXISTS insider_transactions (
            symbol            TEXT    NOT NULL,
            filing_id         TEXT    NOT NULL,
            name              TEXT    NOT NULL,
            transaction_date  DATE,
            filing_date       DATE,
            transaction_code  TEXT,
            change            NUMERIC,
            shares_after      NUMERIC,
            price             NUMERIC,
            is_derivative     BOOLEAN,
            source            TEXT,
            stored_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (symbol, filing_id, name, transaction_date, transaction_code, change)
        )`);
    await query(`CREATE INDEX IF NOT EXISTS insider_tx_symbol_date_idx ON insider_transactions (symbol, transaction_date)`);
    _ready = true;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function _insertNews(articles) {
    if (!articles.length) return 0;
    const params = [], values = [];
    articles.forEach((a, i) => {
        const o = i * 9;
        values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9})`);
        params.push(a.id, a.created_at, a.updated_at || null, a.headline || '', a.summary || null,
            a.author || null, a.source || null, a.url || null, (a.symbols || []).map(s => String(s).toUpperCase()));
    });
    const r = await query(
        `INSERT INTO news_archive (id, created_at, updated_at, headline, summary, author, source, url, symbols)
         VALUES ${values.join(',')}
         ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at, headline = EXCLUDED.headline,
             summary = EXCLUDED.summary, symbols = EXCLUDED.symbols`,
        params
    );
    return r.rowCount || 0;
}

/** All Alpaca news between start and end (ISO), stored as it pages. Returns articles stored. */
async function fetchNews(start, end) {
    await ensureTables();
    const headers = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY };
    let token = null, total = 0;
    do {
        let res;
        for (let attempt = 1; ; attempt++) {
            try {
                res = await axios.get('https://data.alpaca.markets/v1beta1/news', {
                    headers, timeout: 30000,
                    params: { start, end, limit: 50, sort: 'asc', ...(token ? { page_token: token } : {}) },
                });
                break;
            } catch (err) {
                if (attempt >= 4) throw err;
                await sleep((err.response?.status === 429 ? 15000 : 3000) * attempt);
            }
        }
        total += await _insertNews(res.data.news || []);
        token = res.data.next_page_token;
    } while (token);
    return total;
}

/** Incremental: from the newest stored article (minus overlap for late edits) to now. */
let _syncRunning = false;
async function syncRecentNews(now = new Date()) {
    if (_syncRunning) return null;
    _syncRunning = true;
    try {
        await ensureTables();
        const r = await query(`SELECT MAX(created_at) AS m FROM news_archive`);
        const last = r.rows[0]?.m ? new Date(r.rows[0].m) : new Date(now.getTime() - 86400000);
        // Look back at most 2 days: older gaps are the backfill's job, and while a history
        // backfill is mid-way (MAX(created_at) in 2023) this must not re-download years.
        const floor = now.getTime() - 2 * 86400000;
        const start = new Date(Math.max(floor, Math.min(last.getTime() - 3600000, now.getTime() - 3600000))).toISOString();
        return await fetchNews(start, now.toISOString());
    } catch (err) {
        logger.warn('[ResearchArchive] News sync failed (non-blocking)', { error: err.message });
        return null;
    } finally {
        _syncRunning = false;
    }
}

const FINNHUB_PER_MIN = parseInt(process.env.FINNHUB_SWEEP_PER_MIN || "50", 10); // free tier is 60/min — leave room for sector lookups

async function _insertInsider(symbol, rows) {
    let stored = 0;
    for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const params = [], values = [];
        chunk.forEach((t, j) => {
            const o = j * 11;
            values.push(`($${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7},$${o + 8},$${o + 9},$${o + 10},$${o + 11})`);
            params.push(symbol, t.id || t.filingId || '', t.name || '', t.transactionDate || null, t.filingDate || null,
                t.transactionCode || null, t.change ?? null, t.share ?? null, t.transactionPrice ?? null,
                t.isDerivative ?? null, t.source || null);
        });
        const r = await query(
            `INSERT INTO insider_transactions (symbol, filing_id, name, transaction_date, filing_date, transaction_code, change, shares_after, price, is_derivative, source)
             VALUES ${values.join(',')} ON CONFLICT DO NOTHING`,
            params
        );
        stored += r.rowCount || 0;
    }
    return stored;
}

/** Finnhub insider transactions for each symbol since `from` (YYYY-MM-DD), rate-limited. */
async function sweepInsiders(symbols, { from, onProgress } = {}) {
    await ensureTables();
    const token = process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY;
    if (!token) throw new Error('No Finnhub API key configured');
    const gap = Math.ceil(60000 / FINNHUB_PER_MIN);
    let stored = 0, failed = 0;
    for (let i = 0; i < symbols.length; i++) {
        const t0 = Date.now();
        try {
            const res = await axios.get('https://finnhub.io/api/v1/stock/insider-transactions', {
                params: { symbol: symbols[i], from, token }, timeout: 20000,
            });
            stored += await _insertInsider(symbols[i], res.data?.data || []);
        } catch (err) {
            failed++;
            if (err.response?.status === 429) await sleep(30000);
        }
        if (onProgress && (i + 1) % 250 === 0) onProgress(i + 1, symbols.length, stored, failed);
        const wait = gap - (Date.now() - t0);
        if (wait > 0) await sleep(wait);
    }
    return { symbols: symbols.length, stored, failed };
}

/** Saturday job: last 60 days of insider trades for the whole scan universe. Never throws. */
async function weeklyInsiderSweep(now = new Date()) {
    try {
        const symbols = await require('./historyBarsService').scanUniverse();
        const from = new Date(now.getTime() - 60 * 86400000).toISOString().slice(0, 10);
        const r = await sweepInsiders(symbols, { from });
        logger.info('[ResearchArchive] Weekly insider sweep done', r);
        return r;
    } catch (err) {
        logger.warn('[ResearchArchive] Weekly insider sweep failed (non-blocking)', { error: err.message });
        return null;
    }
}

/** For reports: counts of what's stored. */
async function archiveStats() {
    await ensureTables();
    const n = await query(`SELECT COUNT(*)::int AS n, MIN(created_at)::date::text AS a, MAX(created_at) AS b FROM news_archive`);
    const i = await query(`SELECT COUNT(*)::int AS n, COUNT(DISTINCT symbol)::int AS s, MIN(transaction_date)::text AS a FROM insider_transactions`);
    return { news: n.rows[0], insiders: i.rows[0] };
}

module.exports = { ensureTables, fetchNews, syncRecentNews, sweepInsiders, weeklyInsiderSweep, archiveStats };
