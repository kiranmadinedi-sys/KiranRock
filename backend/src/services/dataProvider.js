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

    // Use the unpatched originals stored by bootstrapRuntime so yahooProvider never
    // routes back through the dataProvider patch (prevents infinite recursion when
    // Alpaca falls back to Yahoo while the patch routes Yahoo → Alpaca → Yahoo → …).
    function _chart(symbol, opts) {
        const fn = yf._originalChart || yf.chart;
        return fn.call(yf, symbol, opts);
    }
    function _quote(symbol) {
        const fn = yf._originalQuote || yf.quote;
        return fn.call(yf, symbol);
    }

    // Retry helper: re-attempts fn() up to maxAttempts times when Yahoo returns 429.
    // Delays: 3 s then 8 s — Yahoo's crumb rate-limit window is ~10 s.
    async function _withRetry(fn, symbol) {
        const delays = [3000, 8000];
        for (let i = 0; i <= delays.length; i++) {
            try {
                return await fn();
            } catch (err) {
                const is429 = String(err.message || '').includes('429') || err.status === 429 || err.statusCode === 429;
                if (is429 && i < delays.length) {
                    logger.debug(`[DataProvider:Yahoo] 429 on ${symbol}, retry ${i + 1} in ${delays[i] / 1000}s`);
                    await new Promise(r => setTimeout(r, delays[i]));
                } else {
                    throw err;
                }
            }
        }
    }

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
        const result = await _withRetry(() => _chart(symbol, { period1, period2, interval }), symbol);
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
        const q = await _withRetry(() => _quote(symbol), symbol);
        return {
            symbol,
            price:         q.regularMarketPrice,
            open:          q.regularMarketOpen || null,  // today's opening price for intraday direction filter
            change:        q.regularMarketChange || 0,
            changePercent: q.regularMarketChangePercent || 0,
            volume:        q.regularMarketVolume || 0,
            avgVolume:     q.averageDailyVolume10Day || q.regularMarketVolume || 0,
            marketCap:     q.marketCap || 0,
            high52w:       q.fiftyTwoWeekHigh || q.regularMarketPrice,
            low52w:        q.fiftyTwoWeekLow  || q.regularMarketPrice,
            sector:        q.sector || null,
            exchange:      q.exchange || null,
            _fetchedAt:    Date.now()
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

// ─── YAHOO-ONLY SYMBOLS ──────────────────────────────────────────────────────
// Symbols that must bypass Alpaca IEX (IEX only carries individual stocks, not all ETFs).
// These route to Polygon directly (which covers all US-listed ETFs on Starter plan).
// Sector ETFs were previously Yahoo-only but Polygon/Alpaca cover them — removing Yahoo
// dependency eliminates the 429 bursts during market-open/nightly scan startup.
// Only truly un-fetchable symbols stay here (none currently).
const YAHOO_ONLY_SYMBOLS = new Set([
    // Intentionally empty — all ETFs now served by Polygon/Alpaca IEX.
    // International ETFs (EEM, EFA) fall back from Alpaca → Polygon automatically.
]);

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

    // Shared, global throttle for every Alpaca market-data call (getQuote + getBars),
    // regardless of which scheduler makes it. This module is a singleton imported by
    // every caller in the codebase (aiTradingScheduler, nightlyUniverseScanService,
    // istPipelineScheduler, trailingStopService, marketMonitorService, optionsBotScheduler,
    // etc.) — each one independently batches/throttles its OWN calls assuming it's the
    // only consumer of the Alpaca key, but none of them know about each other. When
    // enough overlap in the same few seconds the combined burst exceeds Alpaca's rate
    // limit (observed 2026-07-20: 12 different symbols 429'd within ~1-2s during a live
    // scan). A per-symbol cache alone doesn't help since it's different symbols each
    // time. This paces every call through one shared budget so bursts queue instead of
    // all firing at once and getting rejected.
    const ALPACA_RATE_LIMIT_PER_MIN = parseInt(process.env.ALPACA_RATE_LIMIT_PER_MIN || '170', 10);
    const ALPACA_MIN_INTERVAL_MS    = 60000 / Math.max(1, ALPACA_RATE_LIMIT_PER_MIN);
    let _nextAlpacaSlot = 0;
    async function _throttleAlpaca() {
        const now  = Date.now();
        const slot = Math.max(now, _nextAlpacaSlot);
        _nextAlpacaSlot = slot + ALPACA_MIN_INTERVAL_MS;
        const wait = slot - now;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }

    // ── Stale-trade guard for gate-critical symbols (2026-07-06 incident) ──────────
    // Alpaca's free IEX snapshot served a stuck LatestTrade for QQQ for 6+ hours,
    // implying a price ~3% off the real (unremarkable) intraday range. Because
    // QQQGate/SPYGate use this single quote to block ALL new buys bot-wide, a stuck
    // feed for one of these symbols silently costs a full trading day of opportunity.
    // Fix: for this small set of gate-critical, highly-liquid symbols, reject a quote
    // whose LatestTrade hasn't updated in STALE_TRADE_MAX_AGE_MS during regular market
    // hours — the caller's existing Polygon fallback then takes over automatically.
    // Scoped narrowly (not all symbols) so illiquid names with genuinely sparse IEX
    // prints aren't penalized.
    const STALE_TRADE_GUARD_SYMBOLS = new Set(['QQQ', 'SPY']);
    const STALE_TRADE_MAX_AGE_MS    = 5 * 60 * 1000; // 5 minutes

    function isRegularMarketHoursET() {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short'
        }).formatToParts(new Date());
        const day    = parts.find(p => p.type === 'weekday').value;
        if (day === 'Sat' || day === 'Sun') return false;
        const hour   = parseInt(parts.find(p => p.type === 'hour').value,   10);
        const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
        const mins   = hour * 60 + minute;
        return mins >= (9 * 60 + 30) && mins < (16 * 60);
    }

    // Alpaca's equity IEX feed can't serve indices (^VIX, ^GSPC) or futures contracts
    // (ES=F, NQ=F, DX=F, CL=F, GC=F — used by globalSentimentService/ATLAS for macro
    // context every 15 min) — both guaranteed to 400 on every attempt, not a coverage
    // gap that improves over time. Skip straight to Yahoo instead of wasting a
    // throttled Alpaca call on a request that can never succeed (2026-07-20).
    function isIndexSymbol(symbol) {
        return symbol.startsWith('^') || symbol.startsWith('=') || /=F$/.test(symbol);
    }

    // ETFs not carried by Alpaca IEX free feed — skip directly to real Yahoo to avoid
    // noisy warn logs. SPY is excluded (works on IEX). QQQ is excluded (withYahooFallback
    // handles it cleanly now that yahooProvider uses the unpatched chart/quote functions).
    // (Uses module-level YAHOO_ONLY_SYMBOLS)

    function isYahooOnly(symbol) {
        return isIndexSymbol(symbol) || YAHOO_ONLY_SYMBOLS.has((symbol || '').toUpperCase());
    }

    async function getBars(symbol, interval = '1d', lookbackDays = 90) {
        // Indices/ETFs not supported by Alpaca IEX — fall back to Yahoo
        if (isYahooOnly(symbol)) return yahooProvider.getBars(symbol, interval, lookbackDays);

        await _throttleAlpaca();
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
        // Indices/ETFs not supported by Alpaca IEX — fall back to Yahoo
        if (isYahooOnly(symbol)) return yahooProvider.getQuote(symbol);

        // Return cached result if fresh (prevents 429 rate-limit errors on burst calls)
        const cached = _quoteCache.get(symbol);
        if (cached && Date.now() - cached.ts < QUOTE_CACHE_TTL) return cached.data;

        await _throttleAlpaca();
        const client = getClient();
        const snap = await client.getSnapshot(symbol);
        // Alpaca SDK returns PascalCase keys: LatestTrade, DailyBar, LatestQuote
        const t = snap.LatestTrade   || snap.latestTrade   || {};
        const d = snap.DailyBar      || snap.dailyBar      || {};
        const p = snap.PrevDailyBar  || snap.prevDailyBar  || {};
        const q = snap.LatestQuote   || snap.latestQuote   || {};

        const sym = (symbol || '').toUpperCase();
        if (STALE_TRADE_GUARD_SYMBOLS.has(sym) && t.Timestamp && isRegularMarketHoursET()) {
            const tradeAgeMs = Date.now() - new Date(t.Timestamp).getTime();
            if (tradeAgeMs > STALE_TRADE_MAX_AGE_MS) {
                logger.warn(`[DataProvider:Alpaca] Stale IEX trade for ${sym} during market hours — rejecting, will fall back to Polygon`, {
                    symbol: sym, tradeAgeMin: Math.round(tradeAgeMs / 60000), tradeTimestamp: t.Timestamp
                });
                throw new Error(`Stale Alpaca IEX trade for ${sym} (${Math.round(tradeAgeMs / 60000)}min old)`);
            }
        }

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
            ask:           q.AskPrice || 0,
            _fetchedAt:    Date.now()
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
        // Try Polygon first when key is available — one call returns all contracts
        // with real Greeks, no per-expiration Yahoo requests needed.
        // Falls back to Yahoo if Polygon returns nothing (free tier = 403, no options access).
        if (process.env.POLYGON_API_KEY) {
            const polygonResult = await polygonProvider.getOptionsChain(symbol);
            if (polygonResult && Array.isArray(polygonResult.results) && polygonResult.results.length > 0) {
                return polygonResult;
            }
            // Polygon key set but no options data (free tier) — fall through to Yahoo
            logger.info('[DataProvider:Alpaca] Polygon options unavailable (free tier?), falling back to Yahoo');
        }
        return yahooProvider.getOptionsChain(symbol);
    }

    return { getBars, getQuote, searchSymbols, getOptionsChain, name: 'Alpaca Markets' };
})();

// ─── POLYGON PROVIDER ────────────────────────────────────────────────────────
const polygonProvider = (() => {
    let axios = null;
    const BASE = 'https://api.polygon.io';

    function hasApiKey() {
        return Boolean(process.env.POLYGON_API_KEY);
    }

    function apiKey() {
        if (!hasApiKey()) {
            throw new Error('POLYGON_API_KEY not set in .env');
        }
        return process.env.POLYGON_API_KEY;
    }

    function http() {
        if (!axios) axios = require('axios');
        return axios;
    }

    async function getBars(symbol, interval = '1d', lookbackDays = 90) {
        if (!hasApiKey()) {
            logger.warn('[DataProvider:Polygon] POLYGON_API_KEY missing, falling back to Yahoo bars');
            return yahooProvider.getBars(symbol, interval, lookbackDays);
        }
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
        if (!hasApiKey()) {
            logger.warn('[DataProvider:Polygon] POLYGON_API_KEY missing, falling back to Yahoo quote');
            return yahooProvider.getQuote(symbol);
        }
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
        if (!hasApiKey()) {
            logger.warn('[DataProvider:Polygon] POLYGON_API_KEY missing, falling back to Yahoo symbol search');
            return yahooProvider.searchSymbols(query);
        }
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
        if (!hasApiKey()) {
            logger.warn('[DataProvider:Polygon] POLYGON_API_KEY missing, falling back to Yahoo options chain');
            return yahooProvider.getOptionsChain(symbol);
        }
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

// ─── INDEX SYMBOL CACHE ──────────────────────────────────────────────────────
// ^VIX etc. are fetched by multiple services concurrently.
// Cache for 15 minutes — matches ATLAS TTL and prevents any source from being
// hammered across parallel bot cycles and nightly scan batches.
const _indexQuoteCache = new Map(); // symbol → { data, ts }
const INDEX_QUOTE_TTL  = 15 * 60 * 1000; // 15 minutes (was 5 min — enough for ^VIX accuracy)

// ── VIX source 1: CBOE free delayed endpoint ─────────────────────────────────
// CBOE is the creator and authoritative source for VIX. Their CDN returns the
// current index value for free with no API key and no rate limit concerns.
async function _getVixFromCBOE() {
    const axios = require('axios');
    const resp  = await axios.get(
        'https://cdn.cboe.com/api/global/delayed_quotes/quotes/_VIX.json',
        { timeout: 8000, headers: { 'User-Agent': 'Mozilla/5.0' } }
    );
    const d = resp.data?.data;
    if (!d) throw new Error('CBOE VIX: no data field in response');
    const value     = d.current_price ?? d.close ?? 0;
    const prevClose = d.prev_day_close ?? value;
    if (!value) throw new Error('CBOE VIX: zero/null value returned');
    return {
        symbol:        '^VIX',
        price:         value,
        change:        value - prevClose,
        changePercent: prevClose ? ((value - prevClose) / prevClose) * 100 : 0,
        volume:        0,
        avgVolume:     0,
        marketCap:     0,
        high52w:       null,
        low52w:        null
    };
}

// ── VIX source 2: Polygon indices (requires index-tier subscription) ──────────
async function _getVixFromPolygon() {
    const axios = require('axios');
    const key   = process.env.POLYGON_API_KEY;
    const resp  = await axios.get('https://api.polygon.io/v3/snapshot', {
        params:  { 'ticker.any_of': 'I:VIX', apiKey: key },
        timeout: 8000
    });
    const r = (resp.data?.results || [])[0];
    if (!r || r.error) throw new Error(`Polygon VIX: ${r?.error || 'no data'}`);
    const value     = r.value ?? r.session?.close ?? 0;
    if (!value) throw new Error('Polygon VIX: no value in response');
    const prevClose = r.session?.previous_close ?? value;
    return {
        symbol:        '^VIX',
        price:         value,
        change:        value - prevClose,
        changePercent: prevClose ? ((value - prevClose) / prevClose) * 100 : 0,
        volume: 0, avgVolume: 0, marketCap: 0, high52w: null, low52w: null
    };
}

async function getIndexQuote(symbol) {
    const now    = Date.now();
    const cached = _indexQuoteCache.get(symbol);
    if (cached && now - cached.ts < INDEX_QUOTE_TTL) return cached.data;

    // ^VIX: try CBOE → Polygon → Yahoo → stale cache → throw
    if (symbol === '^VIX') {
        // 1. CBOE — free, authoritative, no rate limit
        try {
            const data = await _getVixFromCBOE();
            _indexQuoteCache.set(symbol, { data, ts: now });
            logger.info('[DataProvider] VIX from CBOE', { vix: data.price });
            return data;
        } catch (cboeErr) {
            logger.warn('[DataProvider] CBOE VIX failed', { error: cboeErr.message });
        }
        // 2. Polygon (works if subscription includes indices)
        if (process.env.POLYGON_API_KEY) {
            try {
                const data = await _getVixFromPolygon();
                _indexQuoteCache.set(symbol, { data, ts: now });
                logger.info('[DataProvider] VIX from Polygon', { vix: data.price });
                return data;
            } catch (polyErr) {
                logger.debug('[DataProvider] Polygon VIX unavailable', { error: polyErr.message });
            }
        }
        // 3. Yahoo last resort — may 429 but worth one attempt
    }

    try {
        const data = await yahooProvider.getQuote(symbol);
        _indexQuoteCache.set(symbol, { data, ts: now });
        return data;
    } catch (err) {
        if (cached) {
            // Return stale value — a 15-min-old VIX is far better than crashing the bot
            logger.warn(`[DataProvider] Index quote stale-served for ${symbol} (${Math.round((now - cached.ts) / 60000)}min old)`, { error: err.message });
            return cached.data;
        }
        throw err;
    }
}

// Wrap primary provider calls with Yahoo fallback so a transient Alpaca/Polygon
// error never takes down the signal pipeline.
async function withYahooFallback(method, label, ...args) {
    // Index symbols (^VIX, ^GSPC…) route through getIndexQuote() which tries CBOE/Polygon
    // first, Yahoo last — shared 15-min cache prevents 429 bursts across parallel callers.
    if (method === 'getQuote' && args[0]) {
        const sym = (args[0] || '').toUpperCase();
        if (args[0].startsWith('^') || args[0].startsWith('=') || YAHOO_ONLY_SYMBOLS.has(sym)) {
            return getIndexQuote(args[0]);
        }
    }

    // Real-time quote guardrail: when DATA_PROVIDER=polygon (15-min delayed quotes),
    // prefer Alpaca's free IEX feed for stocks it carries — gives real-time prices
    // during market hours for intraday entry/exit decisions.
    // Polygon (delayed) is the fallback for symbols Alpaca IEX doesn't carry.
    if (method === 'getQuote' && activeProvider === polygonProvider && args[0]) {
        const sym = (args[0] || '').toUpperCase();
        if (!args[0].startsWith('^') && !args[0].startsWith('=') && !YAHOO_ONLY_SYMBOLS.has(sym)) {
            try {
                return await alpacaProvider.getQuote(sym);
            } catch (_alpacaErr) {
                // Alpaca IEX doesn't carry this symbol — fall through to Polygon
            }
        }
    }

    try {
        return await activeProvider[method](...args);
    } catch (err) {
        if (activeProvider === yahooProvider) throw err; // already Yahoo — no fallback

        // 404 = symbol not in provider's universe (OTC, delisted, pink-sheet).
        // Skip Yahoo fallback — it burns rate limit for a symbol that has no data there either.
        // DataPatch catches the rethrown error and returns { regularMarketPrice: 0 } gracefully.
        const httpStatus = err.response?.status || err.status;
        const is404 = httpStatus === 404 || /status code 404/.test(err.message || '');
        if (is404) {
            logger.debug(`[DataProvider] ${activeProvider.name} 404 for ${args[0]} — not in universe, skipping Yahoo fallback`);
            throw err;
        }

        logger.warn(`[DataProvider] ${activeProvider.name} ${label} failed, falling back to Yahoo`, {
            symbol: args[0], error: err.message
        });
        return yahooProvider[method](...args);
    }
}

// ─── LOCAL DATA WAREHOUSE PROVIDER (Wrapper) ─────────────────────────────────
// local-first strategy: serve from daily_bars when fresh, delta-fetch only
// missing tail days, full fetch only on first encounter.
const localProvider = (() => {
    const { query } = require('../config/database');
    // Use the real configured provider as the API fallback — not Yahoo by default.
    // When PROVIDER=polygon, Polygon has full bar history; falling back to Yahoo would
    // silently give stale/rate-limited data and completely bypass our paid subscription.
    const underlyingProvider = PROVIDER === 'polygon' ? polygonProvider
                             : PROVIDER === 'alpaca'  ? alpacaProvider
                             : yahooProvider;
    const name = `Local Cache -> ${underlyingProvider.name}`;
    logger.info(`[DataProvider] Initializing with main provider: ${name}`);

    // Batch upsert bars into daily_bars — much faster than one INSERT per row.
    async function _batchUpsert(bars, symbol) {
        if (!bars || bars.length === 0) return;
        const BATCH = 500;
        const normalized = bars
            .filter(b => b.time && b.close != null)
            .map(b => ({
                symbol,
                timestamp: new Date(b.time),
                open:   b.open  ?? b.close,
                high:   b.high  ?? b.close,
                low:    b.low   ?? b.close,
                close:  b.close,
                volume: Math.round(b.volume || 0),
            }));
        if (!normalized.length) return;
        for (let i = 0; i < normalized.length; i += BATCH) {
            const chunk = normalized.slice(i, i + BATCH);
            const vals = [], params = [];
            let p = 1;
            chunk.forEach(b => {
                vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
                params.push(b.symbol, b.timestamp, b.open, b.high, b.low, b.close, b.volume);
            });
            await query(
                `INSERT INTO daily_bars (symbol, timestamp, open, high, low, close, volume)
                 VALUES ${vals.join(',')}
                 ON CONFLICT (symbol, timestamp) DO NOTHING`,
                params
            );
        }
        logger.debug(`[DataProvider] Stored ${normalized.length} bars for ${symbol}`);
    }

    // Fire-and-forget cache write — never blocks the caller.
    function _cacheBg(bars, symbol) {
        setImmediate(() => _batchUpsert(bars, symbol).catch(err =>
            logger.error(`[DataProvider] Background cache write failed for ${symbol}`, { error: err.message })
        ));
    }

    /**
     * Get OHLCV bars — local-first with smart delta fetch.
     *
     * Logic:
     *   1. Query daily_bars for the requested window.
     *   2. Have enough trading-day rows?
     *      a. Tail is fresh (≤ yesterday)?  → serve from DB (zero API call).
     *      b. Tail is stale?                → delta-fetch only missing days,
     *                                         merge + cache, serve merged result.
     *   3. Too few rows?                    → full fetch from provider, cache, serve.
     *
     * Why "trading days" not "calendar days":
     *   lookbackDays=220 calendar days ≈ 157 trading days (weekends + ~10 holidays).
     *   Old code required 215 rows for a 220-day window — the cache NEVER hit.
     */
    async function getBars(symbol, interval = '1d', lookbackDays = 90) {
        // Index symbols (^VIX, ^GSPC …) are not in daily_bars and not served by Polygon/Alpaca.
        if (symbol.startsWith('^') || symbol.startsWith('=')) {
            return yahooProvider.getBars(symbol, interval, lookbackDays);
        }
        if (interval !== '1d') {
            return underlyingProvider.getBars(symbol, interval, lookbackDays);
        }

        const sinceStr = new Date(Date.now() - lookbackDays * 86400000)
            .toISOString().split('T')[0];
        // Expected trading days ≈ 5/7 of calendar days, minus 3 for holidays + today's bar
        const expectedRows = Math.max(5, Math.floor(lookbackDays * 5 / 7) - 3);
        const yesterday    = new Date(Date.now() - 86400000).toISOString().split('T')[0];

        try {
            const { rows } = await query(
                `SELECT timestamp AS time,
                        open::float, high::float, low::float, close::float, volume::bigint
                 FROM daily_bars
                 WHERE symbol = $1 AND timestamp >= $2
                 ORDER BY timestamp ASC`,
                [symbol, sinceStr]
            );

            if (rows.length >= expectedRows) {
                const latestTs   = rows[rows.length - 1].time;
                const latestDate = new Date(latestTs).toISOString().split('T')[0];

                if (latestDate >= yesterday) {
                    // Fully fresh — zero API call
                    logger.debug(`[DataProvider] Cache hit ${symbol} (${rows.length} bars)`);
                    return rows.map(r => ({ ...r, time: new Date(r.time).toISOString() }));
                }

                // Tail stale — delta-fetch only the gap
                const gapDays = Math.ceil(
                    (Date.now() - new Date(latestTs).getTime()) / 86400000
                ) + 2;
                logger.debug(`[DataProvider] Delta fetch ${symbol}: ${gapDays} days since ${latestDate}`);
                const newBars = await underlyingProvider.getBars(symbol, interval, gapDays)
                    .catch(() => []);
                if (newBars.length) _cacheBg(newBars, symbol);

                // Merge: existing rows + net-new bars (dedup by date string)
                const knownDates = new Set(
                    rows.map(r => new Date(r.time).toISOString().split('T')[0])
                );
                const fresh = newBars.filter(
                    b => !knownDates.has(new Date(b.time).toISOString().split('T')[0])
                );
                return [
                    ...rows.map(r => ({ ...r, time: new Date(r.time).toISOString() })),
                    ...fresh,
                ];
            }

            logger.info(
                `[DataProvider] Cache miss ${symbol} (${rows.length}/${expectedRows} bars) — full fetch`
            );
        } catch (err) {
            logger.warn(`[DataProvider] DB query error for ${symbol}, falling back to API`, {
                error: err.message,
            });
        }

        // Full fetch from provider
        const apiBars = await underlyingProvider.getBars(symbol, interval, lookbackDays);
        if (apiBars && apiBars.length > 0) _cacheBg(apiBars, symbol);
        return apiBars;
    }

    async function getQuote(symbol)        { return underlyingProvider.getQuote(symbol); }
    async function searchSymbols(q)        { return underlyingProvider.searchSymbols(q); }
    async function getOptionsChain(symbol) { return underlyingProvider.getOptionsChain(symbol); }

    return { getBars, getQuote, searchSymbols, getOptionsChain, name };
})();

module.exports = {
    // Route daily bar requests through localProvider so the 112k+ rows in daily_bars
    // are actually used. localProvider handles: cache-hit (zero API call), delta-fetch
    // (only missing tail days), and full-fetch on first encounter. Quotes, options, and
    // symbol search still go through the normal provider-with-Yahoo-fallback path.
    getBars:         (...args) => localProvider.getBars(...args),
    getQuote:        (...args) => withYahooFallback('getQuote',      'quote fetch',   ...args),
    searchSymbols:   (...args) => withYahooFallback('searchSymbols', 'symbol search', ...args),
    getOptionsChain: (...args) => withYahooFallback('getOptionsChain', 'options chain fetch', ...args),
    getActiveProvider: () => activeProvider
};
