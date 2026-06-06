/**
 * Global Market Connector — ATLAS data source
 *
 * Two-pass fetch strategy:
 *   Pass 1 — Yahoo Finance via the project's shared dataProvider
 *             (crumb-cached, 429-aware, used by the entire bot already)
 *   Pass 2 — FRED API fallback for the two most critical signals when Yahoo fails:
 *             VIX level  (VIXCLS)    — used as a direct level, not % change
 *             WTI Oil    (DCOILWTICO) — 1-day lag % change from previous close
 *
 * International index signals (Nikkei, DAX, etc.) degrade gracefully to null
 * when Yahoo is unavailable; globalSentimentService handles null → neutral score.
 * In production, Yahoo rarely fails: 15-min cache means ~13 calls per 15 minutes,
 * well below Yahoo's actual rate limit. The 429s here are a testing artefact.
 *
 * Symbols:
 *   Asia-Pacific : ^N225 ^HSI ^BSESN ^AXJO
 *   Europe       : ^GDAXI ^FTSE
 *   Macro / FX   : DX=F  CL=F  GC=F
 *   US Market    : ES=F  NQ=F  ^VIX  ^VVIX
 */

const dataProvider   = require('../services/dataProvider');
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

// ── Pass 1: Yahoo Finance via dataProvider ────────────────────────────────────

async function _fetchFromYahoo() {
    const out = {};
    let fetched = 0;

    for (const sym of SYMBOLS) {
        out[sym] = _emptyEntry(sym);
        try {
            const q = await dataProvider.getQuote(sym);
            if (q && q.price != null) {
                out[sym] = {
                    price:         q.price         ?? null,
                    changePercent: q.changePercent ?? null,
                    prevClose:     null,
                    preMarketPct:  null,
                    name:          sym,
                };
                fetched++;
            }
        } catch { /* leave null */ }
        await new Promise(r => setTimeout(r, 80));   // gentle burst control
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

    // Pass 1: Yahoo Finance
    const { data, fetched: yahooFetched } = await _fetchFromYahoo().catch(() => ({
        data:    Object.fromEntries(SYMBOLS.map(s => [s, _emptyEntry(s)])),
        fetched: 0,
    }));

    // Pass 2: FRED for VIX / Oil / Gold when Yahoo is rate-limited
    let fredFilled = 0;
    if (yahooFetched < 4) {
        logger.warn(`[GlobalMarket] Yahoo: only ${yahooFetched} symbols — using FRED for VIX/Oil/Gold`);
        fredFilled = await _fillFromFRED(data).catch(() => 0);
    }

    const total = yahooFetched + fredFilled;
    cacheService.set(CACHE_KEY, data, total > 0 ? CACHE_TTL : 90_000);

    logger.info('[GlobalMarket] Quotes ready', {
        yahoo: yahooFetched,
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
