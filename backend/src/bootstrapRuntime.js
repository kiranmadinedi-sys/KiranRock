require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ─── Global Yahoo Finance throttle ──────────────────────────────────────────
// Same shared-budget pattern as _throttleAlpaca() in dataProvider.js (added
// 2026-07-20 after 12 symbols 429'd within 1-2s during a live scan) — for a
// different provider. Confirmed 2026-08-18: nightlyUniverseScanService,
// options-prewarm, HERMES velocity (day_gainers/most_actives), and the
// per-symbol DataGuard fallback chain all call yahoo-finance2 independently,
// each assuming it's the only consumer. None of them know about each other,
// so their combined burst blew through Yahoo's rate limit for the entire day
// (14,000+ "Failed to get crumb, 429" errors) — including the nightly scan's
// OWN careful BATCH_SIZE=2/3s-delay pacing, since a 429 lockout is per-IP/key,
// not per-caller. This patches every yahoo-finance2 call from every file in
// the codebase (21+ call sites — quote/chart/quoteSummary/options/screener/
// trendingSymbols/search/historical) through one shared pace, at the
// prototype level, so every instance in every file queues through the same
// budget instead of firing independently.
const YAHOO_RATE_LIMIT_PER_MIN = parseInt(process.env.YAHOO_RATE_LIMIT_PER_MIN || '30', 10);
const YAHOO_MIN_INTERVAL_MS    = 60000 / Math.max(1, YAHOO_RATE_LIMIT_PER_MIN);
let _nextYahooSlot = 0;
async function _throttleYahoo() {
    const now  = Date.now();
    const slot = Math.max(now, _nextYahooSlot);
    _nextYahooSlot = slot + YAHOO_MIN_INTERVAL_MS;
    const wait = slot - now;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

// When DATA_PROVIDER != yahoo, intercept yahoo-finance2 quote/chart calls and
// route them through the active data provider so existing services keep working.
(function patchYahooFinance() {
    const provider = (process.env.DATA_PROVIDER || 'yahoo').toLowerCase();

    const YahooFinance = require('yahoo-finance2').default;
    const proto = YahooFinance.prototype;

    const originalQuote        = proto.quote;
    const originalChart        = proto.chart;
    const originalQuoteSummary = proto.quoteSummary;
    const originalOptions      = proto.options;
    const originalScreener     = proto.screener;
    const originalTrending     = proto.trendingSymbols;
    const originalSearch       = proto.search;
    const originalHistorical   = proto.historical;

    // Throttle-only wrapper — call still reaches real Yahoo, just paced.
    function throttled(original) {
        return async function(...args) {
            await _throttleYahoo();
            return original.apply(this, args);
        };
    }

    // These have no redirect logic anywhere in the codebase — every caller
    // wants real Yahoo data regardless of DATA_PROVIDER, so just throttle them.
    proto.quoteSummary    = throttled(originalQuoteSummary);
    proto.options         = throttled(originalOptions);
    proto.screener        = throttled(originalScreener);
    proto.trendingSymbols = throttled(originalTrending);
    proto.search          = throttled(originalSearch);
    proto.historical      = throttled(originalHistorical);

    if (provider === 'yahoo') {
        // Yahoo is the primary provider — quote/chart go straight to real
        // Yahoo too, just throttled like everything else above.
        proto.quote = throttled(originalQuote);
        proto.chart = throttled(originalChart);
        console.log(`[DataPatch] yahoo-finance2 patched — all calls throttled to ${YAHOO_RATE_LIMIT_PER_MIN}/min (provider=YAHOO, no redirect)`);
        return;
    }

    proto.quote = async function(symbol) {
        if (symbol.startsWith('^') || symbol.startsWith('=')) {
            return throttled(originalQuote).call(this, symbol);
        }

        try {
            const dataProvider = require('./services/dataProvider');
            const quote = await dataProvider.getQuote(symbol);

            return {
                symbol,
                regularMarketPrice: quote.price,
                regularMarketChange: quote.change,
                regularMarketChangePercent: quote.changePercent,
                regularMarketVolume: quote.volume,
                averageDailyVolume10Day: quote.avgVolume,
                marketCap: quote.marketCap || 0,
                fiftyTwoWeekHigh: quote.high52w || quote.price,
                fiftyTwoWeekLow: quote.low52w || quote.price,
                sector: quote.sector || null,
                exchange: quote.exchange || null,
                preMarketPrice: null,
                postMarketPrice: null
            };
        } catch (error) {
            console.warn(`[DataPatch] quote(${symbol}) failed, no fallback:`, error.message);
            return { regularMarketPrice: 0, symbol };
        }
    };

    proto.chart = async function(symbol, opts = {}) {
        if (symbol.startsWith('^') || symbol.startsWith('=')) {
            return throttled(originalChart).call(this, symbol, opts);
        }

        try {
            const dataProvider = require('./services/dataProvider');
            const interval = opts.interval || '1d';
            let lookbackDays = 90;

            if (opts.period1) {
                const diff = Date.now() - new Date(opts.period1).getTime();
                lookbackDays = Math.ceil(diff / 86400000) + 5;
            } else if (opts.range) {
                const rangeMap = { '1d': 2, '5d': 6, '1mo': 35, '3mo': 95, '6mo': 185, '1y': 370, '2y': 730, '5y': 1830 };
                lookbackDays = rangeMap[opts.range] || 90;
            }

            const bars = await dataProvider.getBars(symbol, interval, lookbackDays);
            return {
                quotes: bars.map((bar) => ({
                    date: new Date(bar.time),
                    open: bar.open,
                    high: bar.high,
                    low: bar.low,
                    close: bar.close,
                    volume: bar.volume
                }))
            };
        } catch (error) {
            console.warn(`[DataPatch] chart(${symbol}) failed, no fallback:`, error.message);
            return { quotes: [] };
        }
    };

    // Store originals — THROTTLED — on the prototype so yahooProvider's
    // real-Yahoo fallback (dataProvider.js _chart/_quote) is paced too,
    // without going through the redirect above (prevents infinite recursion
    // when Alpaca falls back to Yahoo: Alpaca fail → Yahoo → would re-enter
    // this patch → back to Alpaca → ... ). Every path that reaches real
    // Yahoo — direct calls from any of the 21+ files, or Alpaca's own
    // fallback — now shares the one budget above.
    proto._originalChart = throttled(originalChart);
    proto._originalQuote = throttled(originalQuote);

    console.log(`[DataPatch] yahoo-finance2 patched → routing quote()+chart() through ${provider.toUpperCase()}, all Yahoo calls throttled to ${YAHOO_RATE_LIMIT_PER_MIN}/min`);
})();
