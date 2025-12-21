const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
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
                const histResult = await yahooFinance.chart(symbol, histOptions);
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
            const min1mResult = await yahooFinance.chart(symbol, min1mOptions);
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
            // For other intervals, fetch and store if not present
            let candles = [];
            if (!fs.existsSync(storageDir)) {
                fs.mkdirSync(storageDir, { recursive: true });
            }
            if (fs.existsSync(candleFile)) {
                try {
                    candles = JSON.parse(fs.readFileSync(candleFile, 'utf8'));
                } catch (e) { candles = []; }
            } else {
                // Download and store
                let periodMonths = 3;
                if (interval === '1wk') periodMonths = 24;
                else if (interval === '1mo') periodMonths = 60;
                else if (interval === 'all') periodMonths = 120;
                const startDate = new Date();
                startDate.setMonth(startDate.getMonth() - periodMonths);
                const queryOptions = {
                    period1: startDate.toISOString().slice(0, 10),
                    period2: new Date().toISOString().slice(0, 10),
                    interval: interval === 'all' ? '1d' : interval,
                    includePrePost: includePrePost,
                };
                const result = await yahooFinance.chart(symbol, queryOptions);
                const quotes = (result.quotes || []).map(d => ({
                    time: Math.floor(new Date(d.date).getTime() / 1000),
                    open: d.open, high: d.high, low: d.low, close: d.close, volume: d.volume, isExtendedHours: d.isExtendedHours || false
                }));
                candles = quotes;
                fs.writeFileSync(candleFile, JSON.stringify(quotes, null, 2));
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
        const quote = await yahooFinance.quote(symbol);
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
        console.error(`Failed to fetch current price for ${symbol}:`, error);
        return null;
    }
};

const searchSymbols = async (query) => {
    try {
        // Try Yahoo Finance autocomplete API for real symbol search
        const results = await yahooFinance.search(query);
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
        // Fallback to demo list if no results
        const stockNames = {
            'AMD': 'Advanced Micro Devices',
            'AAPL': 'Apple Inc.',
            'GOOGL': 'Alphabet Inc.',
            'MSFT': 'Microsoft Corporation',
            'TSLA': 'Tesla Inc.',
            'NVDA': 'NVIDIA Corporation',
            'V': 'Visa Inc.',
            'META': 'Meta Platforms Inc.',
            'NFLX': 'Netflix Inc.',
            'DIS': 'The Walt Disney Company',
            'BAC': 'Bank of America Corp',
            'JPM': 'JPMorgan Chase & Co.',
            'WMT': 'Walmart Inc.',
            'INTC': 'Intel Corporation',
            'CSCO': 'Cisco Systems Inc.',
            'ORCL': 'Oracle Corporation',
            'PYPL': 'PayPal Holdings Inc.',
            'ADBE': 'Adobe Inc.',
            'CRM': 'Salesforce Inc.',
            'UBER': 'Uber Technologies Inc.',
            'LYFT': 'Lyft Inc.',
            'SHOP': 'Shopify Inc.',
            'SQ': 'Block Inc.',
            'COIN': 'Coinbase Global Inc.',
            'PLTR': 'Palantir Technologies Inc.',
            'SNOW': 'Snowflake Inc.',
            'SPOT': 'Spotify Technology S.A.',
            'TWLO': 'Twilio Inc.',
            'ZM': 'Zoom Video Communications',
            'ROKU': 'Roku Inc.',
            'F': 'Ford Motor Company',
            'GM': 'General Motors Company',
            'T': 'AT&T Inc.',
            'VZ': 'Verizon Communications',
            'PEP': 'PepsiCo Inc.',
            'KO': 'The Coca-Cola Company',
            'MCD': 'McDonald\'s Corporation',
            'SBUX': 'Starbucks Corporation',
            'NKE': 'Nike Inc.',
            'COST': 'Costco Wholesale Corporation'
        };
        const matchedSymbols = Object.keys(stockNames).filter(s => 
            s.toLowerCase().includes(query.toLowerCase()) || 
            stockNames[s].toLowerCase().includes(query.toLowerCase())
        );
        return matchedSymbols.slice(0, 10).map(s => ({
            symbol: s,
            name: stockNames[s],
            type: 'EQUITY',
            exchange: 'NASDAQ/NYSE'
        }));
    } catch (error) {
        console.error(`Failed to search for symbols with query "${query}":`, error);
        return [];
    }
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
