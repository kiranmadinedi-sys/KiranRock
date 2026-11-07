/**
 * Long price history for research (built 2026-10-17) — kept in its own table so the live
 * trading tables (daily_bars, ohlcv_cache) are never touched by it.
 *
 * history_bars holds split/dividend-adjusted daily bars from Alpaca (IEX feed) back to
 * 2023-01-01 for every symbol the nightly scan has seen. The Saturday market study tops it
 * up each week (appendRecent), so the history keeps growing without anyone re-running a
 * backfill. Used for multi-year rule tests (historyBacktestService) — prices only: news,
 * Gemini, ORACLE and SEC parts of the live score can't be rebuilt for the past.
 *
 * Caveat: the symbol list is today's scan universe, so stocks delisted since 2023 are
 * missing (survivorship bias). Compare methods against each other, not against zero.
 */
const axios = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const HISTORY_START = '2023-01-01';

let _tableReady = false;
async function ensureTable() {
    if (_tableReady) return;
    await query(`
        CREATE TABLE IF NOT EXISTS history_bars (
            symbol TEXT    NOT NULL,
            d      DATE    NOT NULL,
            o      REAL    NOT NULL,
            h      REAL    NOT NULL,
            l      REAL    NOT NULL,
            c      REAL    NOT NULL,
            v      BIGINT  NOT NULL,
            PRIMARY KEY (symbol, d)
        )`);
    _tableReady = true;
}

async function _fetch(symbols, start, end, onBars) {
    const headers = { 'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY };
    let token = null;
    do {
        let res;
        for (let attempt = 1; ; attempt++) {
            try {
                res = await axios.get('https://data.alpaca.markets/v2/stocks/bars', {
                    headers, timeout: 60000,
                    params: { symbols: symbols.join(','), timeframe: '1Day', start, end, limit: 10000, feed: 'iex', adjustment: 'all', ...(token ? { page_token: token } : {}) },
                });
                break;
            } catch (err) {
                if (attempt >= 4) throw err;
                await new Promise(r => setTimeout(r, (err.response?.status === 429 ? 15000 : 3000) * attempt));
            }
        }
        await onBars(res.data.bars || {});
        token = res.data.next_page_token;
    } while (token);
}

/**
 * Newest bar date that is a finished session. Alpaca returns today's bar while the market
 * is still trading, and storing it made a midday price look like the close (2026-11-02:
 * SPY 762.91 on 236K volume vs the real 752.10 on 50.9M, written by the satellite's
 * first-trading-day top-up). Today's bar counts only after 16:30 ET.
 */
function _lastCompleteDay(now = new Date()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now).map(p => [p.type, p.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    if (minutes >= 16 * 60 + 30) return today;
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

async function _insert(barsBySymbol, lastDay = _lastCompleteDay()) {
    const rows = [];
    for (const [sym, bars] of Object.entries(barsBySymbol)) {
        for (const b of bars) {
            const d = b.t.slice(0, 10);
            if (d > lastDay) continue; // session still trading
            rows.push([sym, d, b.o, b.h, b.l, b.c, Math.round(b.v)]);
        }
    }
    for (let i = 0; i < rows.length; i += 2000) {
        const chunk = rows.slice(i, i + 2000);
        const params = [], values = [];
        chunk.forEach((r, j) => {
            const o = j * 7;
            values.push(`($${o + 1},$${o + 2}::date,$${o + 3},$${o + 4},$${o + 5},$${o + 6},$${o + 7})`);
            params.push(...r);
        });
        await query(
            `INSERT INTO history_bars (symbol, d, o, h, l, c, v) VALUES ${values.join(',')}
             ON CONFLICT (symbol, d) DO UPDATE SET o = EXCLUDED.o, h = EXCLUDED.h, l = EXCLUDED.l, c = EXCLUDED.c, v = EXCLUDED.v`,
            params
        );
    }
    return rows.length;
}

/** Full history for the given symbols (idempotent — re-running just refreshes rows). */
async function backfill(symbols, { start = HISTORY_START, end = new Date().toISOString().slice(0, 10), batch = 100, onProgress } = {}) {
    await ensureTable();
    let total = 0;
    for (let i = 0; i < symbols.length; i += batch) {
        await _fetch(symbols.slice(i, i + batch), start, end, async bars => { total += await _insert(bars); });
        if (onProgress) onProgress(Math.min(i + batch, symbols.length), symbols.length, total);
    }
    return total;
}

/** Symbols the nightly scan has seen (any day) — the research universe. */
async function scanUniverse() {
    const r = await query(`SELECT DISTINCT symbol FROM daily_universe_analysis WHERE symbol ~ '^[A-Z.]+$' ORDER BY symbol`);
    return r.rows.map(x => x.symbol);
}

/**
 * Weekly top-up: the last ~3 weeks for symbols already stored, and full history for any
 * scan symbol not stored yet. Never throws — research data must not break the report.
 */
async function appendRecent({ now = new Date() } = {}) {
    try {
        await ensureTable();
        const universe = await scanUniverse();
        const have = new Set((await query(`SELECT DISTINCT symbol FROM history_bars`)).rows.map(r => r.symbol));
        const missing = universe.filter(s => !have.has(s));
        const recentStart = new Date(now.getTime() - 21 * 86400000).toISOString().slice(0, 10);
        const end = now.toISOString().slice(0, 10);
        const recent = await backfill(universe.filter(s => have.has(s)), { start: recentStart, end });
        const added = missing.length ? await backfill(missing, { end }) : 0;
        logger.info('[HistoryBars] Weekly top-up done', { symbols: universe.length, newSymbols: missing.length, rowsRefreshed: recent, rowsAdded: added });
        return { symbols: universe.length, newSymbols: missing.length, rows: recent + added };
    } catch (err) {
        logger.warn('[HistoryBars] Weekly top-up failed (non-blocking)', { error: err.message });
        return null;
    }
}

module.exports = { ensureTable, backfill, appendRecent, scanUniverse, HISTORY_START, _lastCompleteDay, _insert };
