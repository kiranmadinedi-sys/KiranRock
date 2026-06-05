require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// When DATA_PROVIDER != yahoo, intercept yahoo-finance2 quote/chart calls and
// route them through the active data provider so existing services keep working.
(function patchYahooFinance() {
    const provider = (process.env.DATA_PROVIDER || 'yahoo').toLowerCase();
    if (provider === 'yahoo') return;

    const YahooFinance = require('yahoo-finance2').default;
    const proto = YahooFinance.prototype;

    const originalQuote = proto.quote;
    const originalChart = proto.chart;

    proto.quote = async function(symbol) {
        if (symbol.startsWith('^') || symbol.startsWith('=')) {
            return originalQuote.call(this, symbol);
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
            return originalChart.call(this, symbol, opts);
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

    // Store originals on the prototype so yahooProvider can call real Yahoo directly
    // without going through the patch (prevents infinite recursion when Alpaca falls back to Yahoo).
    proto._originalChart = originalChart;
    proto._originalQuote = originalQuote;

    console.log(`[DataPatch] yahoo-finance2 patched → routing quote()+chart() through ${provider.toUpperCase()}`);
})();