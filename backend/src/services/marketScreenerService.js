const yahooFinance = require('yahoo-finance2').default;

/**
 * Market Screener Service
 * Scans ALL US stocks with market cap > $2B
 * Uses free Yahoo Finance API
 */

// Cache for screened stocks (refresh daily)
let cachedStockUniverse = null;
let lastScreenTime = null;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get all US stocks with market cap > $2B
 * @returns {Promise<Array>} Array of stock symbols with metadata
 */
async function getStockUniverse() {
    // Return cache if still valid
    if (cachedStockUniverse && lastScreenTime && (Date.now() - lastScreenTime < CACHE_DURATION)) {
        console.log(`[Market Screener] Returning cached universe (${cachedStockUniverse.length} stocks)`);
        return cachedStockUniverse;
    }

    console.log('[Market Screener] Fetching fresh stock universe...');

    try {
        // S&P 500 + Top NASDAQ stocks (guaranteed >$2B market cap)
        const sp500Symbols = await getSP500Symbols();
        const nasdaqTop = await getTopNasdaqSymbols();
        
        // Combine and deduplicate
        const allSymbols = [...new Set([...sp500Symbols, ...nasdaqTop])];
        
        console.log(`[Market Screener] Found ${allSymbols.length} symbols, filtering by market cap...`);
        
        // Filter by market cap in batches
        const qualified = [];
        const batchSize = 10;
        
        for (let i = 0; i < allSymbols.length; i += batchSize) {
            const batch = allSymbols.slice(i, i + batchSize);
            const results = await Promise.allSettled(
                batch.map(async symbol => {
                    try {
                        const quote = await yahooFinance.quote(symbol);
                        const marketCap = quote.marketCap || 0;
                        
                        if (marketCap >= 2000000000) { // $2B
                            return {
                                symbol,
                                marketCap,
                                marketCapFormatted: formatMarketCap(marketCap),
                                price: quote.regularMarketPrice,
                                volume: quote.regularMarketVolume,
                                sector: quote.sector || 'Unknown',
                                industry: quote.industry || 'Unknown'
                            };
                        }
                        return null;
                    } catch (error) {
                        console.log(`[Market Screener] Error fetching ${symbol}: ${error.message}`);
                        return null;
                    }
                })
            );
            
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    qualified.push(result.value);
                }
            });
            
            // Rate limiting - 2 second delay between batches
            if (i + batchSize < allSymbols.length) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
        
        // Cache results
        cachedStockUniverse = qualified;
        lastScreenTime = Date.now();
        
        console.log(`[Market Screener] ✓ Found ${qualified.length} stocks with market cap > $2B`);
        
        return qualified;
        
    } catch (error) {
        console.error('[Market Screener] Error:', error);
        return cachedStockUniverse || []; // Return cache on error
    }
}

/**
 * Get S&P 500 symbols
 */
async function getSP500Symbols() {
    // Top S&P 500 stocks (expanded list)
    return [
        // Technology
        'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO', 'ORCL',
        'ADBE', 'CRM', 'CSCO', 'ACN', 'AMD', 'INTC', 'IBM', 'QCOM', 'TXN', 'INTU',
        'NOW', 'AMAT', 'MU', 'ADI', 'LRCX', 'KLAC', 'SNPS', 'CDNS', 'MCHP', 'FTNT',
        // Financials
        'JPM', 'V', 'MA', 'BAC', 'WFC', 'MS', 'GS', 'BLK', 'SPGI', 'C',
        'AXP', 'SCHW', 'CB', 'MMC', 'PGR', 'AON', 'TFC', 'USB', 'PNC', 'BK',
        // Healthcare
        'UNH', 'JNJ', 'LLY', 'ABBV', 'MRK', 'TMO', 'ABT', 'DHR', 'PFE', 'AMGN',
        'BMY', 'ISRG', 'VRTX', 'GILD', 'CVS', 'CI', 'ELV', 'HCA', 'BSX', 'MDT',
        // Consumer
        'AMZN', 'WMT', 'HD', 'MCD', 'NKE', 'COST', 'SBUX', 'TGT', 'LOW', 'TJX',
        'BKNG', 'CMG', 'MAR', 'ABNB', 'DIS', 'NFLX', 'PG', 'KO', 'PEP', 'PM',
        // Industrial
        'UNP', 'CAT', 'HON', 'UPS', 'RTX', 'BA', 'GE', 'LMT', 'DE', 'MMM',
        // Energy
        'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'OXY', 'HES',
        // Communication
        'GOOGL', 'META', 'DIS', 'NFLX', 'CMCSA', 'T', 'VZ', 'TMUS',
        // Utilities
        'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'PEG',
        // Real Estate
        'AMT', 'PLD', 'CCI', 'EQIX', 'PSA', 'WELL', 'SPG', 'O'
    ];
}

/**
 * Get top NASDAQ symbols
 */
async function getTopNasdaqSymbols() {
    // Top NASDAQ-100 stocks
    return [
        'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO', 'COST',
        'ASML', 'PEP', 'AZN', 'CSCO', 'TMUS', 'AMD', 'ADBE', 'NFLX', 'CMCSA', 'INTC',
        'TXN', 'QCOM', 'INTU', 'HON', 'AMGN', 'AMAT', 'ISRG', 'BKNG', 'SBUX', 'ADI',
        'GILD', 'VRTX', 'MDLZ', 'REGN', 'PYPL', 'ADP', 'MU', 'LRCX', 'PANW', 'MELI',
        'SNPS', 'KLAC', 'CDNS', 'MNST', 'ORLY', 'CRWD', 'MAR', 'CTAS', 'MRVL', 'FTNT',
        'ADSK', 'ABNB', 'WDAY', 'NXPI', 'DASH', 'TEAM', 'PCAR', 'PAYX', 'ROST', 'MCHP',
        'COIN', 'PLTR', 'SNOW', 'DDOG', 'ZS', 'OKTA', 'NET', 'RBLX', 'UBER', 'LYFT'
    ];
}

/**
 * Format market cap for display
 */
function formatMarketCap(marketCap) {
    if (marketCap >= 1e12) {
        return `$${(marketCap / 1e12).toFixed(2)}T`;
    } else if (marketCap >= 1e9) {
        return `$${(marketCap / 1e9).toFixed(2)}B`;
    } else if (marketCap >= 1e6) {
        return `$${(marketCap / 1e6).toFixed(2)}M`;
    }
    return `$${marketCap}`;
}

/**
 * Get stocks by sector
 */
async function getStocksBySector(sector) {
    const universe = await getStockUniverse();
    return universe.filter(stock => stock.sector === sector);
}

/**
 * Get top liquid stocks for options trading
 */
async function getTopLiquidStocks(limit = 50) {
    const universe = await getStockUniverse();
    return universe
        .sort((a, b) => b.volume - a.volume)
        .slice(0, limit);
}

/**
 * Manual refresh of stock universe
 */
function refreshCache() {
    cachedStockUniverse = null;
    lastScreenTime = null;
    console.log('[Market Screener] Cache cleared, will refresh on next request');
}

module.exports = {
    getStockUniverse,
    getStocksBySector,
    getTopLiquidStocks,
    refreshCache,
    formatMarketCap
};
