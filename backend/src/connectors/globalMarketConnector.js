/**
 * Global Market Connector — ATLAS data source
 *
 * Two-pass fetch strategy:
 *   Pass 1 — Alpaca snapshots of US-listed ETF stand-ins (one call, ~0.2s). Replaced
 *             Yahoo on 2026-11-05: Yahoo had been returning 1 of 13 symbols for weeks, so
 *             ATLAS scored from VIX + oil/gold alone and a 1.8% oil dip put -4 on every
 *             stock. The ETFs trade in US hours, so Asia/Europe read as their latest US-
 *             session move (incl. extended hours), not the overnight index — a lagged but
 *             real signal, where Yahoo gave none.
 *   Pass 2 — FRED for VIX level (always — no ETF tracks the index level) and for oil/gold
 *             when Alpaca fails.
 *
 * Symbols (keys kept so the scorer is unchanged) → stand-in:
 *   Asia-Pacific : ^N225 EWJ · ^HSI EWH · ^BSESN INDA · ^AXJO EWA
 *   Europe       : ^GDAXI EWG · ^FTSE EWU
 *   Macro / FX   : DX=F UUP · CL=F USO · GC=F GLD
 *   US Market    : ES=F SPY · NQ=F QQQ · ^VIX (FRED) · ^VVIX (none)
 */

const axios          = require('axios');
const fredMacroSvc   = require('../services/fredMacroService');
const cacheService   = require('../services/cacheService');
const { logger }     = require('../utils/logger');

const CACHE_KEY = 'global_market_raw';
const CACHE_TTL = 15 * 60 * 1000;

const SYMBOLS = [
    '^N225', '^HSI', '^BSESN', '^AXJO',
    '^GDAXI', '^FTSE',
    'DX=F', 'CL=F', 'GC=F',
    'ES=F', 'NQ=F',
    '^VIX', '^VVIX',
];

// FRED series for our most critical signals — no API-key rate limit issues
const FRED_SERIES = {
    '^VIX': 'VIXCLS',          // level  (score uses price, not changePercent)
    'CL=F': 'DCOILWTICO',      // daily close — we compute 1-day change% from 2 obs
    'GC=F': 'GOLDAMGBD228NLBM',// daily close — same
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _emptyEntry(sym) {
    return { price: null, changePercent: null, prevClose: null, preMarketPct: null, name: sym };
}

// ── Pass 1: Alpaca ETF stand-ins ──────────────────────────────────────────────

const PROXIES = {
    '^N225': 'EWJ', '^HSI': 'EWH', '^BSESN': 'INDA', '^AXJO': 'EWA',
    '^GDAXI': 'EWG', '^FTSE': 'EWU',
    'DX=F': 'UUP', 'CL=F': 'USO', 'GC=F': 'GLD',
    'ES=F': 'SPY', 'NQ=F': 'QQQ',
};

async function _fetchFromAlpaca() {
    const out = Object.fromEntries(SYMBOLS.map(s => [s, _emptyEntry(s)]));
    let fetched = 0;
    if (!process.env.ALPACA_KEY_ID) return { data: out, fetched };
    const resp = await axios.get('https://data.alpaca.markets/v2/stocks/snapshots', {
        headers: { 'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY },
        params:  { symbols: Object.values(PROXIES).join(',') },
        timeout: 15000,
    });
    for (const [sym, etf] of Object.entries(PROXIES)) {
        const snap  = resp.data?.[etf];
        const price = snap?.latestTrade?.p;
        const prev  = snap?.prevDailyBar?.c;
        if (price > 0 && prev > 0) {
            out[sym] = { price, changePercent: +((price / prev - 1) * 100).toFixed(4), prevClose: prev, preMarketPct: null, name: `${sym} (${etf})` };
            fetched++;
        }
    }
    return { data: out, fetched };
}

// ── Pass 2: FRED fallback for VIX and commodities ─────────────────────────────

/**
 * Fetch the two most-recent FRED observations for a series so we can compute
 * the 1-day % change.  Uses the existing fredMacroService cache infra for the
 * latest value; makes a direct call for the second-to-last value (short TTL).
 */
async function _fredChangePct(seriesId) {
    const FRED_KEY = process.env.FRED_API_KEY;
    if (!FRED_KEY) return null;

    const cacheKey = `fred_2obs_${seriesId}`;
    const cached   = cacheService.get(cacheKey);
    if (cached !== null) return cached;

    try {
        const axios = require('axios');
        const resp  = await axios.get('https://api.stlouisfed.org/fred/series/observations', {
            params: {
                series_id:          seriesId,
                api_key:            FRED_KEY,
                file_type:          'json',
                sort_order:         'desc',
                limit:              2,
                observation_start:  new Date(Date.now() - 30 * 86400_000).toISOString().split('T')[0],
            },
            timeout: 8000,
        });

        const obs = (resp.data?.observations || [])
            .filter(o => o.value && o.value !== '.')
            .map(o => parseFloat(o.value));

        if (obs.length < 2 || obs[1] === 0) return null;

        const pct = (obs[0] - obs[1]) / obs[1] * 100;
        const result = { latest: obs[0], pct: +pct.toFixed(4) };
        cacheService.set(cacheKey, result, 6 * 60 * 60 * 1000);  // 6h — FRED is daily
        return result;

    } catch {
        return null;
    }
}

async function _fillFromFRED(data) {
    let filled = 0;

    // VIX level from FRED (VIXCLS) — scorer uses price field, not changePercent
    if (data['^VIX'].price === null) {
        const vixVal = await fredMacroSvc.getLatestValue('VIXCLS').catch(() => null);
        if (vixVal !== null) {
            data['^VIX'] = { ...data['^VIX'], price: vixVal };
            filled++;
            logger.info(`[GlobalMarket] FRED fallback VIX: ${vixVal}`);
        }
    }

    // Oil and Gold — need % change; fetch 2 observations from FRED
    for (const [sym, seriesId] of [['CL=F', 'DCOILWTICO'], ['GC=F', 'GOLDAMGBD228NLBM']]) {
        if (data[sym].price !== null) continue;
        const r = await _fredChangePct(seriesId).catch(() => null);
        if (r) {
            data[sym] = { ...data[sym], price: r.latest, changePercent: r.pct };
            filled++;
            logger.info(`[GlobalMarket] FRED fallback ${sym}: price=${r.latest} chg%=${r.pct}`);
        }
    }

    return filled;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function fetchGlobalQuotes() {
    const cached = cacheService.get(CACHE_KEY);
    if (cached !== null) return cached;

    // Pass 1: Alpaca ETF stand-ins
    const { data, fetched: alpacaFetched } = await _fetchFromAlpaca().catch(err => {
        logger.warn(`[GlobalMarket] Alpaca snapshots failed: ${err.message}`);
        return { data: Object.fromEntries(SYMBOLS.map(s => [s, _emptyEntry(s)])), fetched: 0 };
    });

    // Pass 2: FRED — VIX level always, oil/gold only if Alpaca missed them
    const fredFilled = await _fillFromFRED(data).catch(() => 0);

    const total = alpacaFetched + fredFilled;
    cacheService.set(CACHE_KEY, data, total > 0 ? CACHE_TTL : 90_000);

    logger.info('[GlobalMarket] Quotes ready', {
        alpaca: alpacaFetched,
        fred:  fredFilled,
        VIX:   data['^VIX']?.price?.toFixed(1),
        ES:    data['ES=F']?.changePercent?.toFixed(2),
        N225:  data['^N225']?.changePercent?.toFixed(2),
        DAX:   data['^GDAXI']?.changePercent?.toFixed(2),
        DXY:   data['DX=F']?.changePercent?.toFixed(2),
    });

    return data;
}

module.exports = { fetchGlobalQuotes, SYMBOLS };
