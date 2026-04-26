const yfClient = require('../utils/yfClient');
const fs = require('fs');
const path = require('path');

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

// In-memory cache for stock prices (per symbol)
const priceCache = {};

const getStockData = async (symbol, interval = '1d', includePrePost = true) => {
    const fs = require('fs');
    const path = require('path');
    const storageDir = path.join(__dirname, '../storage');
    if (!fs.existsSync(storageDir)) {
        fs.mkdirSync(storageDir, { recursive: true });
    }
    const candleFile = path.join(storageDir, `candles_${symbol}_${interval}.json`);
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
            // For other intervals, use file cache with TTL
            // 1d candles: refresh every 24 hours | weekly/monthly: 7 days
            const CACHE_TTL_MS = (interval === '1d')  ? 24 * 60 * 60 * 1000
                               : (interval === '1wk') ?  7 * 24 * 60 * 60 * 1000
                               :                        30 * 24 * 60 * 60 * 1000;

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
                // Fetch fresh data via dataProvider (routes to Alpaca/Polygon/Yahoo per .env)
                const dataProvider = require('./dataProvider');
                let periodMonths = 3;
                if (interval === '1wk') periodMonths = 24;
                else if (interval === '1mo') periodMonths = 60;
                else if (interval === 'all') periodMonths = 120;
                const lookbackDays = periodMonths * 31;
                const fetchInterval = interval === 'all' ? '1d' : interval;

                const bars = await dataProvider.getBars(symbol, fetchInterval, lookbackDays);
                const quotes = bars.map(b => ({
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
                }
            }
            return candles;
        }
    } catch (error) {
        console.error(`Failed to fetch data for ${symbol}:`, error);
        return [];
    }
};

// Fetch current price with 1-second cache
const getCurrentPrice = async (symbol) => {
    try {
        const quote = await yfClient.quote(symbol);
        // Use the freshest available price: preMarket > postMarket > regularMarket
        let price = null;
        if (quote) {
            if (quote.preMarketPrice) {
                price = quote.preMarketPrice;
            } else if (quote.postMarketPrice) {
                price = quote.postMarketPrice;
            } else if (quote.regularMarketPrice) {
                price = quote.regularMarketPrice;
            }
        }
        return price;
    } catch (error) {
        console.error(`Failed to fetch current price for ${symbol}:`, error && error.message ? error.message : error);
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
