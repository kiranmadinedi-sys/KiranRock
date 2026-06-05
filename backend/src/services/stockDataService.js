const yfClient = require('../utils/yfClient');
const fs = require('fs');
const path = require('path');
const cacheService = require('./cacheService');
const dataProvider = require('./dataProvider');
const marketDataStore = require('./marketDataStore');

const STOCKS_FILE = path.join(__dirname, '../../stocks.json');

// Helper function to read stocks from file
const readStocksFromFile = () => {
    try {
        const data = fs.readFileSync(STOCKS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading stocks file:', error);
        return ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA']; // fallback
    }
};

// Helper function to write stocks to file
const writeStocksToFile = (stocks) => {
    try {
        fs.writeFileSync(STOCKS_FILE, JSON.stringify(stocks, null, 2));
    } catch (error) {
        console.error('Error writing stocks file:', error);
    }
};

let stocks = readStocksFromFile(); // Initialize from file

function getBarCacheTtlMs(interval) {
    if (interval === '1d') return 24 * 60 * 60 * 1000;
    if (interval === '1wk') return 7 * 24 * 60 * 60 * 1000;
    if (interval === '1mo') return 30 * 24 * 60 * 60 * 1000;
    if (interval === '5m') return 30 * 60 * 1000;
    if (interval === '1m') return 5 * 60 * 1000;
    return 24 * 60 * 60 * 1000;
}

function getQuoteCacheTtlMs(symbol) {
    return symbol.startsWith('^') ? 30 * 60 * 1000 : 60 * 1000;
}

const getStockData = async (symbol, interval = '1d', includePrePost = true) => {
    const fs = require('fs');
    const path = require('path');
    const storageDir = path.join(__dirname, '../storage');
    if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
    }
    const candleFile = path.join(storageDir, `candles_${symbol}_${interval}.json`);
    const inMemoryKey = `bars:${symbol}:${interval}`;
    const cachedBars = cacheService.get(inMemoryKey);
    if (cachedBars) {
        return cachedBars;
    }
    try {
        // If 1m interval, combine historical (lower-res) and recent (1m) data
        if (interval === '1m') {
            // 1. Load historical data (e.g., 5m or 15m) from storage if exists
            let historical = [];
            const histInterval = '5m';
            const histFile = path.join(storageDir, `candles_${symbol}_${histInterval}.json`);
            if (!fs.existsSync(storageDir)) {
                fs.mkdirSync(storageDir, { recursive: true });
            }
            if (fs.existsSync(histFile)) {
                try {
                    historical = JSON.parse(fs.readFileSync(histFile, 'utf8'));
                } catch (e) { historical = []; }
            } else {
                // Download and store historical data if not present
                // Yahoo only allows 5m data for last 60 days
                const histStart = new Date();
                histStart.setDate(histStart.getDate() - 59); // 60 days max
                const histOptions = {
                    period1: histStart.toISOString().slice(0, 10),
                    period2: new Date().toISOString().slice(0, 10),
                    interval: histInterval,
                    includePrePost: includePrePost,
                };
                const histResult = await yfClient._raw.chart(symbol, histOptions);
                const histQuotes = (histResult.quotes || []).map(d => ({
                    time: Math.floor(new Date(d.date).getTime() / 1000),
                    open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume, isExtendedHours: d.isExtendedHours || false
                }));
                historical = histQuotes;
                fs.writeFileSync(histFile, JSON.stringify(histQuotes, null, 2));
            }
            // 2. Fetch latest 1m data (max 7 days)
            const now = new Date();
            const min1mStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            const min1mOptions = {
                period1: min1mStart.toISOString().slice(0, 10),
                period2: now.toISOString().slice(0, 10),
                interval: '1m',
                includePrePost: includePrePost,
            };
            const min1mResult = await yfClient._raw.chart(symbol, min1mOptions);
            const min1mQuotes = (min1mResult.quotes || []).map(d => ({
                time: Math.floor(new Date(d.date).getTime() / 1000),
                open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume, isExtendedHours: d.isExtendedHours || false
            }));
            // 3. Merge historical and 1m data (avoid overlap, deduplicate)
            let merged = [];
            if (historical.length === 0 && min1mQuotes.length === 0) {
                return [];
            }
            if (historical.length === 0) {
                merged = min1mQuotes;
            } else if (min1mQuotes.length === 0) {
                merged = historical;
            } else {
                // Only add historical candles that end before the first 1m candle
                const cutoff = min1mQuotes[0].time;
                merged = [...historical.filter(c => c.time < cutoff), ...min1mQuotes];
            }
            // Remove any duplicate timestamps (shouldn't happen, but just in case)
            const seen = new Set();
            const deduped = merged.filter(c => {
                if (seen.has(c.time)) return false;
                seen.add(c.time);
                return true;
            });
            return deduped;
        } else {
            const CACHE_TTL_MS = getBarCacheTtlMs(interval);
            const persistentKey = `bars_${symbol}_${interval}`;

            let candles = [];
            let cacheValid = false;
            if (fs.existsSync(candleFile)) {
                try {
                    const stat = fs.statSync(candleFile);
                    const age  = Date.now() - stat.mtimeMs;
                    if (age < CACHE_TTL_MS) {
                        candles   = JSON.parse(fs.readFileSync(candleFile, 'utf8'));
                        cacheValid = candles.length > 0;
                    }
                } catch (e) { candles = []; }
            }

            if (!cacheValid) {
                let periodMonths = 3;
                if (interval === '1wk') periodMonths = 24;
                else if (interval === '1mo') periodMonths = 60;
                else if (interval === 'all') periodMonths = 120;
                const lookbackDays = periodMonths * 31;
                const fetchInterval = interval === 'all' ? '1d' : interval;
                try {
                    const bars = await dataProvider.getBars(symbol, fetchInterval, lookbackDays);
                    const quotes = (bars || []).filter(b => b && b.time).map(b => ({
                        time:   Math.floor(new Date(b.time).getTime() / 1000),
                        open:   b.open,
                        high:   b.high,
                        low:    b.low,
                        close:  b.close,
                        volume: b.volume,
                        isExtendedHours: false
                    }));
                    candles = quotes;
                    if (quotes.length > 0) {
                        fs.writeFileSync(candleFile, JSON.stringify(quotes, null, 2));
                        marketDataStore.writeEntry(persistentKey, quotes);
                    }
                } catch (fetchError) {
                    console.warn(`[StockData] Fresh bars fetch failed for ${symbol} ${interval}:`, fetchError.message);
                    const staleBars = marketDataStore.getStaleValue(persistentKey);
                    if (Array.isArray(staleBars) && staleBars.length > 0) {
                        candles = staleBars;
                    } else {
                        throw fetchError;
                    }
                }
            }
            cacheService.set(inMemoryKey, candles, Math.min(CACHE_TTL_MS, 15 * 60 * 1000));
            return candles;
        }
    } catch (error) {
        console.error(`Failed to fetch data for ${symbol}:`, error);
        const staleBars = marketDataStore.getStaleValue(`bars_${symbol}_${interval}`);
        if (Array.isArray(staleBars) && staleBars.length > 0) {
            return staleBars;
        }
        return [];
    }
};

const getCurrentPrice = async (symbol) => {
    const cacheKey = `quote:${symbol}`;
    const cachedQuote = cacheService.get(cacheKey);
    if (cachedQuote !== null) {
        return cachedQuote;
    }

    const persistentKey = `quote_${symbol}`;
    const quoteTtlMs = getQuoteCacheTtlMs(symbol);
    const storedQuote = marketDataStore.getValue(persistentKey, quoteTtlMs);
    if (typeof storedQuote === 'number') {
        cacheService.set(cacheKey, storedQuote, quoteTtlMs);
        return storedQuote;
    }

    try {
        let price = null;

        try {
            const providerQuote = await dataProvider.getQuote(symbol);
            price = providerQuote?.price ?? null;
        } catch (providerError) {
            console.warn(`[StockData] dataProvider quote failed for ${symbol}:`, providerError.message);
        }

        if (price === null) {
            const quote = await yfClient.quote(symbol);
            if (quote) {
                if (quote.preMarketPrice) {
                    price = quote.preMarketPrice;
                } else if (quote.postMarketPrice) {
                    price = quote.postMarketPrice;
                } else if (quote.regularMarketPrice) {
                    price = quote.regularMarketPrice;
                }
            }
        }

        if (typeof price === 'number') {
            cacheService.set(cacheKey, price, quoteTtlMs);
            marketDataStore.writeEntry(persistentKey, price);
        }
        return price;
    } catch (error) {
        console.error(`Failed to fetch current price for ${symbol}:`, error && error.message ? error.message : error);
        const staleQuote = marketDataStore.getStaleValue(persistentKey);
        if (typeof staleQuote === 'number') {
            cacheService.set(cacheKey, staleQuote, Math.min(quoteTtlMs, 5 * 60 * 1000));
            return staleQuote;
        }
        return null;
    }
};

const searchSymbols = async (query) => {
    try {
        // Try Yahoo Finance autocomplete API for real symbol search
        const results = await yfClient.search(query);
        if (results && results.quotes && results.quotes.length > 0) {
            // Return objects with symbol and name (exclude currency pairs, etc.)
            return results.quotes
                .filter(q => q.symbol && q.exchange && /^[A-Z.]+$/.test(q.symbol) && !q.symbol.includes('='))
                .slice(0, 10) // Limit to top 10 results
                .map(q => ({
                    symbol: q.symbol,
                    name: q.shortname || q.longname || q.symbol,
                    type: q.quoteType || 'EQUITY',
                    exchange: q.exchange
                }));
        }
        // No results from Yahoo — fall through to local fallback
    } catch (error) {
        console.warn(`Yahoo search failed for "${query}" (${error.message}), using local fallback`);
        // Fall through to local fallback below
    }

    // Local fallback when Yahoo is rate-limited or unavailable
    const stockNames = {
        'AMD': 'Advanced Micro Devices', 'AAPL': 'Apple Inc.', 'GOOGL': 'Alphabet Inc.',
        'MSFT': 'Microsoft Corporation', 'TSLA': 'Tesla Inc.', 'NVDA': 'NVIDIA Corporation',
        'V': 'Visa Inc.', 'META': 'Meta Platforms Inc.', 'NFLX': 'Netflix Inc.',
        'DIS': 'The Walt Disney Company', 'BAC': 'Bank of America Corp',
        'JPM': 'JPMorgan Chase & Co.', 'WMT': 'Walmart Inc.', 'INTC': 'Intel Corporation',
        'CSCO': 'Cisco Systems Inc.', 'ORCL': 'Oracle Corporation', 'PYPL': 'PayPal Holdings Inc.',
        'ADBE': 'Adobe Inc.', 'CRM': 'Salesforce Inc.', 'UBER': 'Uber Technologies Inc.',
        'LYFT': 'Lyft Inc.', 'SHOP': 'Shopify Inc.', 'SQ': 'Block Inc.',
        'COIN': 'Coinbase Global Inc.', 'PLTR': 'Palantir Technologies Inc.',
        'SNOW': 'Snowflake Inc.', 'SPOT': 'Spotify Technology S.A.',
        'TWLO': 'Twilio Inc.', 'ZM': 'Zoom Video Communications', 'ROKU': 'Roku Inc.',
        'F': 'Ford Motor Company', 'GM': 'General Motors Company', 'T': 'AT&T Inc.',
        'VZ': 'Verizon Communications', 'PEP': 'PepsiCo Inc.', 'KO': 'The Coca-Cola Company',
        'MCD': "McDonald's Corporation", 'SBUX': 'Starbucks Corporation',
        'NKE': 'Nike Inc.', 'COST': 'Costco Wholesale Corporation',
        'AMZN': 'Amazon.com Inc.', 'GOOG': 'Alphabet Inc. Class C',
        'MRVL': 'Marvell Technology Inc.', 'QCOM': 'QUALCOMM Inc.',
        'AVGO': 'Broadcom Inc.', 'TXN': 'Texas Instruments Inc.',
        'GS': 'Goldman Sachs Group Inc.', 'MS': 'Morgan Stanley',
        'UNH': 'UnitedHealth Group Inc.', 'JNJ': 'Johnson & Johnson',
        'PFE': 'Pfizer Inc.', 'ABBV': 'AbbVie Inc.',
        'XOM': 'Exxon Mobil Corporation', 'CVX': 'Chevron Corporation'
    };
    const q = query.toLowerCase();
    const matched = Object.keys(stockNames).filter(s =>
        s.toLowerCase().includes(q) || stockNames[s].toLowerCase().includes(q)
    );
    return matched.slice(0, 10).map(s => ({
        symbol: s, name: stockNames[s], type: 'EQUITY', exchange: 'NASDAQ/NYSE'
    }));
};


const getAvailableSymbols = () => {
    stocks = readStocksFromFile(); // Always read fresh from file
    return stocks;
};

const removeSymbol = (symbol) => {
    const upperSymbol = symbol.toUpperCase();
    stocks = readStocksFromFile();
    const idx = stocks.indexOf(upperSymbol);
    if (idx !== -1) {
        stocks.splice(idx, 1);
        writeStocksToFile(stocks);
    }
};

const addSymbol = (symbol) => {
    if (!stocks.includes(symbol)) {
        stocks.push(symbol);
        writeStocksToFile(stocks); // Persist to file
    }
};



module.exports = { getStockData, getAvailableSymbols, searchSymbols, addSymbol, getCurrentPrice, removeSymbol };
