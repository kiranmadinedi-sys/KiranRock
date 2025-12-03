const stockDataService = require('../services/stockDataService');
const aiSignalService = require('../services/aiSignalService');
const newsMonitoringService = require('../services/newsMonitoringService');

const getAvailableStocks = (req, res) => { 
    const symbols = stockDataService.getAvailableSymbols();
    res.json(symbols);
};

const searchStocks = async (req, res) => {
    const { query } = req.query;
    if (!query) {
        return res.status(400).json({ message: 'Query parameter is required' });
    }
    const symbols = await stockDataService.searchSymbols(query);
    // Create a new array with only valid symbols
    const cleanSymbols = [];
    for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        if (symbol && typeof symbol === 'string' && symbol.trim() !== '') {
            cleanSymbols.push(symbol);
        }
    }
    console.log(`Clean symbols for "${query}":`, cleanSymbols);
    res.json(cleanSymbols);
};

const getStockData = async (req, res) => {
    console.log(`[${new Date().toISOString()}] GET /api/stocks/${req.params.symbol}`);
    const { symbol } = req.params;
    const { interval, includePrePost } = req.query; // Get interval and includePrePost from query params
    
    try {
        const includeExtended = includePrePost === 'true' || includePrePost === true;
        const data = await stockDataService.getStockData(symbol.toUpperCase(), interval || '1d', includeExtended);
        if (data && data.length > 0) {
            console.log(`[${new Date().toISOString()}] Found ${data.length} data points for ${symbol} (${interval || '1d'}${includeExtended ? ' with extended hours' : ''})`);
            res.json(data);
        } else {
            console.log(`[${new Date().toISOString()}] No data found for ${symbol}`);
            res.status(404).send('Stock not found or failed to fetch data');
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in getStockData for ${symbol}:`, error);
        res.status(500).send('Server error while fetching stock data');
    }
};

const getSignal = async (req, res) => {
    console.log(`[${new Date().toISOString()}] GET /api/signals/${req.params.symbol}`);
    const { symbol } = req.params;
    try {
        const signal = await aiSignalService.getSignal(symbol.toUpperCase());
        if (signal) {
            console.log(`[${new Date().toISOString()}] Generated signal for ${symbol}: ${signal}`);
            res.json({ signal });
        } else {
            console.log(`[${new Date().toISOString()}] Could not generate signal for ${symbol}`);
            res.status(404).send('Could not generate signal for stock');
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in getSignal for ${symbol}:`, error);
        res.status(500).send('Server error while generating signal');
    }
};

const getHistoricalSignals = async (req, res) => {
    console.log(`[${new Date().toISOString()}] GET /api/signals/historical/${req.params.symbol}`);
    const { symbol } = req.params;
    const { shortPeriod, longPeriod, interval } = req.query;
    
    try {
        const short = shortPeriod ? parseInt(shortPeriod) : 5;
        const long = longPeriod ? parseInt(longPeriod) : 15;
        const timeframe = interval || '1d';
        
        const signals = await aiSignalService.getHistoricalSignals(symbol.toUpperCase(), short, long, timeframe);
        console.log(`[${new Date().toISOString()}] Found ${signals.length} historical signals for ${symbol} (EMA ${short}/${long}, ${timeframe})`);
        res.json(signals);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in getHistoricalSignals for ${symbol}:`, error);
        res.status(500).send('Server error while fetching historical signals');
    }
};

const addStockSymbol = (req, res) => {
    const { symbol } = req.body;
    if (!symbol) {
        return res.status(400).json({ message: 'Symbol is required' });
    }
    stockDataService.addSymbol(symbol);
    console.log(`[ADD SYMBOL] Added symbol: ${symbol} to stocks.json`);
    // Also add to news monitoring
    newsMonitoringService.addSymbolsToWatch([symbol.toUpperCase()]);
    res.status(200).json({ message: 'Symbol added', symbol });
};

const removeStockSymbol = (req, res) => {
    const { symbol } = req.params;
    if (!symbol) {
        return res.status(400).json({ message: 'Symbol is required' });
    }
    stockDataService.removeSymbol(symbol);
    console.log(`[REMOVE SYMBOL] Removed symbol: ${symbol} from stocks.json`);
    res.status(200).json({ message: 'Symbol removed', symbol });
};

const getStockPrice = async (req, res) => {
    const { symbol } = req.params;
    try {
        const price = await stockDataService.getCurrentPrice(symbol.toUpperCase());
        if (price !== null) {
            res.json({ price });
        } else {
            res.status(404).send('Could not fetch current price for stock');
        }
    } catch (error) {
        res.status(500).send('Server error while fetching current price');
    }
};

module.exports = {
    getStockData,
    getSignal,
    getAvailableStocks,
    searchStocks,
    getHistoricalSignals,
    addStockSymbol,
    getStockPrice,
    removeStockSymbol
};
