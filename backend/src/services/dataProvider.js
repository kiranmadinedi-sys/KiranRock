/**
 * Data Provider Abstraction Layer
 * ================================
 * Switch between data sources by changing DATA_PROVIDER in .env:
 *
 *   DATA_PROVIDER=yahoo    — Yahoo Finance (free, works now, ~15 min delay on some feeds)
 *   DATA_PROVIDER=alpaca   — Alpaca Markets (real-time, requires ALPACA_KEY_ID + ALPACA_SECRET_KEY)
 *   DATA_PROVIDER=polygon  — Polygon.io (real-time + options, requires POLYGON_API_KEY)
 *
 * All callers use this module — never import yahoo-finance2 or Alpaca directly.
 * When you subscribe to a paid provider, set DATA_PROVIDER in .env and restart.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { logger } = require('../utils/logger');

const PROVIDER = (process.env.DATA_PROVIDER || 'yahoo').toLowerCase();

logger.info(`[DataProvider] Using provider: ${PROVIDER.toUpperCase()}`);

// ─── YAHOO FINANCE PROVIDER ──────────────────────────────────────────────────
const yahooProvider = (() => {
    const YahooFinance = require('yahoo-finance2').default;
    const yf = new YahooFinance();

    /**
     * Get OHLCV bars for a symbol
     * @param {string} symbol
     * @param {string} interval  '1d' | '1wk' | '1mo' | '5m' | '1m'
     * @param {number} lookbackDays
     * @returns {Promise<Array<{time,open,high,low,close,volume}>>}
     */
    async function getBars(symbol, interval = '1d', lookbackDays = 90) {
        const period1 = new Date(Date.now() - lookbackDays * 86400000)
            .toISOString().split('T')[0];
        const period2 = new Date().toISOString().split('T')[0];
        const result = await yf.chart(symbol, { period1, period2, interval });
        return (result.quotes || [])
            .filter(q => q.close != null)
            .map(q => ({
                time:   new Date(q.date).toISOString(),
                open:   q.open,
                high:   q.high,
                low:    q.low,
                close:  q.close,
                volume: q.volume || 0
            }));
    }

    /**
     * Get latest quote for a symbol
     * @param {string} symbol
     * @returns {Promise<{symbol,price,change,changePercent,volume,marketCap,high52w,low52w}>}
     */
    async function getQuote(symbol) {
        const q = await yf.quote(symbol);
        return {
            symbol,
            price:         q.regularMarketPrice,
            change:        q.regularMarketChange || 0,
            changePercent: q.regularMarketChangePercent || 0,
            volume:        q.regularMarketVolume || 0,
            avgVolume:     q.averageDailyVolume10Day || q.regularMarketVolume || 0,
            marketCap:     q.marketCap || 0,
            high52w:       q.fiftyTwoWeekHigh || q.regularMarketPrice,
            low52w:        q.fiftyTwoWeekLow  || q.regularMarketPrice,
            sector:        q.sector || null,
            exchange:      q.exchange || null
        };
    }

    /**
     * Search for symbols by query string
     */
    async function searchSymbols(query) {
        const results = await yf.search(query);
        return (results?.quotes || [])
            .filter(q => q.symbol && /^[A-Z.]+$/.test(q.symbol) && !q.symbol.includes('='))
            .slice(0, 15)
            .map(q => ({
                symbol:   q.symbol,
                name:     q.shortname || q.longname || q.symbol,
                type:     q.quoteType || 'EQUITY',
                exchange: q.exchange || ''
            }));
    }

    /**
     * Get options chain (basic — Yahoo has limited Greeks)
     */
    async function getOptionsChain(symbol) {
        try {
            const result = await yf.options(symbol);
            return result;
        } catch (e) {
            logger.warn(`[DataProvider:Yahoo] Options unavailable for ${symbol}`, { error: e.message });
            return null;
        }
    }

    return { getBars, getQuote, searchSymbols, getOptionsChain, name: 'Yahoo Finance' };
})();

// ─── ALPACA PROVIDER ─────────────────────────────────────────────────────────
const alpacaProvider = (() => {
    // Lazy-load so app doesn't crash if Alpaca SDK not installed or keys missing
    let alpaca = null;

    function getClient() {
        if (alpaca) return alpaca;
        if (!process.env.ALPACA_KEY_ID || !process.env.ALPACA_SECRET_KEY) {
            throw new Error(
                'Alpaca keys not configured. Set ALPACA_KEY_ID and ALPACA_SECRET_KEY in .env'
            );
        }
        const Alpaca = require('@alpacahq/alpaca-trade-api');
        alpaca = new Alpaca({
            keyId:     process.env.ALPACA_KEY_ID,
            secretKey: process.env.ALPACA_SECRET_KEY,
            paper:     process.env.ALPACA_PAPER !== 'false',
            feed:      'iex'   // 'iex' = free real-time, 'sip' = full NMS (paid)
        });
        logger.info('[DataProvider:Alpaca] Client initialised', {
            paper: process.env.ALPACA_PAPER !== 'false'
        });
        return alpaca;
    }

    // In-process quote cache — prevents rate-limit 429s on burst requests
    const _quoteCache = new Map();
    const QUOTE_CACHE_TTL = 60 * 1000; // 60 seconds

    // Alpaca doesn't support index symbols (^VIX, ^GSPC etc.) — fall back to Yahoo
    function isIndexSymbol(symbol) {
        return symbol.startsWith('^') || symbol.startsWith('=');
    }

    async function getBars(symbol, interval = '1d', lookbackDays = 90) {
        // Indices not supported by Alpaca data feed — fall back to Yahoo
        if (isIndexSymbol(symbol)) return yahooProvider.getBars(symbol, interval, lookbackDays);

        const client = getClient();
        const alpacaTimeframe = {
            '1m':  '1Min',
            '5m':  '5Min',
            '15m': '15Min',
            '1h':  '1Hour',
            '1d':  '1Day',
            '1wk': '1Week'
        }[interval] || '1Day';

        const start = new Date(Date.now() - lookbackDays * 86400000).toISOString();
        const resp = await client.getBarsV2(symbol, {
            timeframe: alpacaTimeframe,
            start,
            limit: 1000
        });

        const bars = [];
        for await (const bar of resp) {
            bars.push({
                time:   bar.Timestamp,
                open:   bar.OpenPrice,
                high:   bar.HighPrice,
                low:    bar.LowPrice,
                close:  bar.ClosePrice,
                volume: bar.Volume || 0
            });
        }
        return bars;
    }

    async function getQuote(symbol) {
        // Indices (^VIX, ^GSPC) not supported by Alpaca — fall back to Yahoo
        if (isIndexSymbol(symbol)) return yahooProvider.getQuote(symbol);

        // Return cached result if fresh (prevents 429 rate-limit errors on burst calls)
        const cached = _quoteCache.get(symbol);
        if (cached && Date.now() - cached.ts < QUOTE_CACHE_TTL) return cached.data;

        const client = getClient();
        const snap = await client.getSnapshot(symbol);
        // Alpaca SDK returns PascalCase keys: LatestTrade, DailyBar, LatestQuote
        const t = snap.LatestTrade   || snap.latestTrade   || {};
        const d = snap.DailyBar      || snap.dailyBar      || {};
        const p = snap.PrevDailyBar  || snap.prevDailyBar  || {};
        const q = snap.LatestQuote   || snap.latestQuote   || {};
        const price = t.Price || d.ClosePrice || 0;
        const prevClose = p.ClosePrice || d.OpenPrice || price;
        const result = {
            symbol,
            price,
            change:        price && prevClose ? price - prevClose : 0,
            changePercent: price && prevClose ? ((price - prevClose) / prevClose) * 100 : 0,
            volume:        d.Volume   || 0,
            avgVolume:     d.Volume   || 0,
            marketCap:     0,
            high52w:       null,
            low52w:        null,
            sector:        null,
            bid:           q.BidPrice || 0,
            ask:           q.AskPrice || 0
        };
        _quoteCache.set(symbol, { data: result, ts: Date.now() });
        return result;
    }

    async function searchSymbols(query) {
        const client = getClient();
        const assets = await client.getAssets({ status: 'active', asset_class: 'us_equity' });
        const q = query.toUpperCase();
        return assets
            .filter(a => a.symbol.startsWith(q) || a.name.toUpperCase().includes(q))
            .slice(0, 15)
            .map(a => ({
                symbol:   a.symbol,
                name:     a.name,
                type:     'EQUITY',
                exchange: a.exchange
            }));
    }

    async function getOptionsChain(symbol) {
        // Alpaca does not yet support options chains — fall back to Yahoo
        logger.warn('[DataProvider:Alpaca] Options not supported, falling back to Yahoo');
        return yahooProvider.getOptionsChain(symbol);
    }

    return { getBars, getQuote, searchSymbols, getOptionsChain, name: 'Alpaca Markets' };
})();

// ─── POLYGON PROVIDER ────────────────────────────────────────────────────────
const polygonProvider = (() => {
    let axios = null;
    const BASE = 'https://api.polygon.io';

    function apiKey() {
        if (!process.env.POLYGON_API_KEY) {
            throw new Error('POLYGON_API_KEY not set in .env');
        }
        return process.env.POLYGON_API_KEY;
    }

    function http() {
        if (!axios) axios = require('axios');
        return axios;
    }

    async function getBars(symbol, interval = '1d', lookbackDays = 90) {
        const multiplier = interval === '1d' ? 1 : interval === '1wk' ? 7 : 1;
        const timespan   = interval === '1m' ? 'minute' :
                           interval === '5m' ? 'minute' :
                           interval === '1h' ? 'hour'   :
                           interval === '1wk'? 'week'   : 'day';
        const from = new Date(Date.now() - lookbackDays * 86400000).toISOString().split('T')[0];
        const to   = new Date().toISOString().split('T')[0];

        const url = `${BASE}/v2/aggs/ticker/${symbol}/range/${multiplier}/${timespan}/${from}/${to}`;
        const resp = await http().get(url, { params: { apiKey: apiKey(), limit: 5000, adjusted: true } });

        return (resp.data.results || []).map(b => ({
            time:   new Date(b.t).toISOString(),
            open:   b.o,
            high:   b.h,
            low:    b.l,
            close:  b.c,
            volume: b.v
        }));
    }

    async function getQuote(symbol) {
        const url = `${BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`;
        const resp = await http().get(url, { params: { apiKey: apiKey() } });
        const t = resp.data.ticker || {};
        const d = t.day || {};
        const lq = t.lastQuote || {};
        return {
            symbol,
            price:         t.lastTrade?.p  || d.c || 0,
            change:        d.c && d.o ? d.c - d.o : 0,
            changePercent: d.c && d.o ? ((d.c - d.o) / d.o) * 100 : 0,
            volume:        d.v  || 0,
            avgVolume:     t.prevDay?.v || 0,
            marketCap:     0,
            high52w:       null,
            low52w:        null,
            bid:           lq.P || 0,
            ask:           lq.P || 0
        };
    }

    async function searchSymbols(query) {
        const url = `${BASE}/v3/reference/tickers`;
        const resp = await http().get(url, {
            params: { search: query, apiKey: apiKey(), active: true, limit: 15, market: 'stocks' }
        });
        return (resp.data.results || []).map(t => ({
            symbol:   t.ticker,
            name:     t.name,
            type:     t.type || 'CS',
            exchange: t.primary_exchange || ''
        }));
    }

    async function getOptionsChain(symbol) {
        try {
            const url = `${BASE}/v3/snapshot/options/${symbol}`;
            const resp = await http().get(url, {
                params: { apiKey: apiKey(), limit: 250 }
            });
            return resp.data;
        } catch (e) {
            logger.warn(`[DataProvider:Polygon] Options error for ${symbol}`, { error: e.message });
            return null;
        }
    }

    return { getBars, getQuote, searchSymbols, getOptionsChain, name: 'Polygon.io' };
})();

// ─── ACTIVE PROVIDER SELECTION ───────────────────────────────────────────────
const PROVIDERS = { yahoo: yahooProvider, alpaca: alpacaProvider, polygon: polygonProvider };
const activeProvider = PROVIDERS[PROVIDER] || yahooProvider;

if (!PROVIDERS[PROVIDER]) {
    logger.warn(`[DataProvider] Unknown provider '${PROVIDER}', falling back to Yahoo Finance`);
}

module.exports = {
    /**
     * Get historical OHLCV bars
     * @param {string} symbol
     * @param {string} interval  '1d'|'1wk'|'1mo'|'5m'|'1m'
     * @param {number} lookbackDays
     */
    getBars:        (symbol, interval, lookbackDays) =>
                        activeProvider.getBars(symbol, interval, lookbackDays),

    /** Get real-time quote */
    getQuote:       (symbol) => activeProvider.getQuote(symbol),

    /** Search symbols by query string */
    searchSymbols:  (query)  => activeProvider.searchSymbols(query),

    /** Get options chain */
    getOptionsChain:(symbol) => activeProvider.getOptionsChain(symbol),

    /** Name of the active provider (for logging/UI) */
    providerName:   activeProvider.name,

    /** Current provider key ('yahoo'|'alpaca'|'polygon') */
    providerKey:    PROVIDER
};
