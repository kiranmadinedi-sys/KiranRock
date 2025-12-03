const yahooFinance = require('yahoo-finance2').default;

/**
 * Options Data Service
 * Fetches options chain data and calculates Greeks
 * Note: Yahoo Finance provides limited options data. For production, consider:
 * - TradierOptions API
 * - TD Ameritrade API
 * - Interactive Brokers API
 */

/**
 * Get options chain for a symbol
 * @param {string} symbol - Stock symbol
 * @param {Date} expirationDate - Options expiration date (optional)
 * @returns {Promise<Object>} Options chain data
 */
async function getOptionsChain(symbol) {
    try {
        const options = await yahooFinance.options(symbol);
        return options;
    } catch (error) {
        console.error(`[Options] Error fetching options chain for ${symbol}:`, error.message);
        throw error;
    }
}

/**
 * Calculate implied volatility using Newton-Raphson approximation
 * @param {number} price - Current stock price
 * @param {number} strike - Strike price
 * @param {number} timeToExpiry - Time to expiration in years
 * @param {number} riskFreeRate - Risk-free interest rate
 * @param {number} optionPrice - Current option price
 * @param {string} optionType - 'call' or 'put'
 * @returns {number} Implied volatility
 */
function calculateImpliedVolatility(price, strike, timeToExpiry, riskFreeRate, optionPrice, optionType) {
    // Simplified IV calculation - in production, use proper Black-Scholes IV solver
    let volatility = 0.3; // Initial guess 30%
    const tolerance = 0.0001;
    const maxIterations = 100;
    
    for (let i = 0; i < maxIterations; i++) {
        const theoreticalPrice = calculateBlackScholes(price, strike, timeToExpiry, riskFreeRate, volatility, optionType);
        const vega = calculateVega(price, strike, timeToExpiry, riskFreeRate, volatility);
        
        const diff = optionPrice - theoreticalPrice;
        if (Math.abs(diff) < tolerance) break;
        
        volatility += diff / vega;
        
        if (volatility < 0.01) volatility = 0.01; // Min 1%
        if (volatility > 5) volatility = 5; // Max 500%
    }
    
    return volatility;
}

/**
 * Standard normal cumulative distribution function
 */
function normalCDF(x) {
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const probability = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - probability : probability;
}

/**
 * Standard normal probability density function
 */
function normalPDF(x) {
    return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Calculate Black-Scholes option price
 * @param {number} S - Current stock price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiration in years
 * @param {number} r - Risk-free rate
 * @param {number} sigma - Volatility
 * @param {string} type - 'call' or 'put'
 * @returns {number} Option price
 */
function calculateBlackScholes(S, K, T, r, sigma, type) {
    if (T <= 0) return type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
    
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    
    if (type === 'call') {
        return S * normalCDF(d1) - K * Math.exp(-r * T) * normalCDF(d2);
    } else {
        return K * Math.exp(-r * T) * normalCDF(-d2) - S * normalCDF(-d1);
    }
}

/**
 * Calculate Delta - Rate of change of option price with respect to underlying price
 * @param {number} S - Current stock price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiration in years
 * @param {number} r - Risk-free rate
 * @param {number} sigma - Volatility
 * @param {string} type - 'call' or 'put'
 * @returns {number} Delta
 */
function calculateDelta(S, K, T, r, sigma, type) {
    if (T <= 0) {
        if (type === 'call') return S > K ? 1 : 0;
        return S < K ? -1 : 0;
    }
    
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
    
    if (type === 'call') {
        return normalCDF(d1);
    } else {
        return normalCDF(d1) - 1;
    }
}

/**
 * Calculate Gamma - Rate of change of delta with respect to underlying price
 * @param {number} S - Current stock price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiration in years
 * @param {number} r - Risk-free rate
 * @param {number} sigma - Volatility
 * @returns {number} Gamma
 */
function calculateGamma(S, K, T, r, sigma) {
    if (T <= 0) return 0;
    
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
    return normalPDF(d1) / (S * sigma * Math.sqrt(T));
}

/**
 * Calculate Theta - Rate of change of option price with respect to time
 * @param {number} S - Current stock price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiration in years
 * @param {number} r - Risk-free rate
 * @param {number} sigma - Volatility
 * @param {string} type - 'call' or 'put'
 * @returns {number} Theta (daily)
 */
function calculateTheta(S, K, T, r, sigma, type) {
    if (T <= 0) return 0;
    
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    
    const part1 = -(S * normalPDF(d1) * sigma) / (2 * Math.sqrt(T));
    
    if (type === 'call') {
        const part2 = r * K * Math.exp(-r * T) * normalCDF(d2);
        return (part1 - part2) / 365; // Convert to daily
    } else {
        const part2 = r * K * Math.exp(-r * T) * normalCDF(-d2);
        return (part1 + part2) / 365; // Convert to daily
    }
}

/**
 * Calculate Vega - Rate of change of option price with respect to volatility
 * @param {number} S - Current stock price
 * @param {number} K - Strike price
 * @param {number} T - Time to expiration in years
 * @param {number} r - Risk-free rate
 * @param {number} sigma - Volatility
 * @returns {number} Vega
 */
function calculateVega(S, K, T, r, sigma) {
    if (T <= 0) return 0;
    
    const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
    return S * normalPDF(d1) * Math.sqrt(T) / 100; // Divide by 100 for 1% change
}

/**
 * Calculate all Greeks for an option
 * @param {Object} params - Option parameters
 * @returns {Object} Greeks
 */
function calculateGreeks(params) {
    const { 
        stockPrice, 
        strikePrice, 
        daysToExpiration, 
        volatility, 
        riskFreeRate = 0.05, 
        optionType 
    } = params;
    
    const T = daysToExpiration / 365;
    
    const delta = calculateDelta(stockPrice, strikePrice, T, riskFreeRate, volatility, optionType);
    const gamma = calculateGamma(stockPrice, strikePrice, T, riskFreeRate, volatility);
    const theta = calculateTheta(stockPrice, strikePrice, T, riskFreeRate, volatility, optionType);
    const vega = calculateVega(stockPrice, strikePrice, T, riskFreeRate, volatility);
    const theoreticalPrice = calculateBlackScholes(stockPrice, strikePrice, T, riskFreeRate, volatility, optionType);
    
    return {
        delta: parseFloat(delta.toFixed(4)),
        gamma: parseFloat(gamma.toFixed(4)),
        theta: parseFloat(theta.toFixed(4)),
        vega: parseFloat(vega.toFixed(4)),
        theoreticalPrice: parseFloat(theoreticalPrice.toFixed(2)),
        intrinsicValue: optionType === 'call' 
            ? Math.max(0, stockPrice - strikePrice)
            : Math.max(0, strikePrice - stockPrice),
        timeValue: Math.max(0, theoreticalPrice - (optionType === 'call' 
            ? Math.max(0, stockPrice - strikePrice)
            : Math.max(0, strikePrice - stockPrice)))
    };
}

/**
 * Get options with calculated Greeks
 * @param {string} symbol - Stock symbol
 * @param {number} marketCap - Market cap in millions (filter if < $2B)
 * @returns {Promise<Object>} Options with Greeks
 */
async function getOptionsWithGreeks(symbol, marketCap = null) {
    try {
        // Filter by market cap if provided
        if (marketCap && marketCap < 2000) { // $2B minimum
            return {
                symbol,
                error: 'Market cap below $2B threshold',
                options: []
            };
        }
        
        const optionsChain = await getOptionsChain(symbol);
        const quote = await yahooFinance.quote(symbol);
        const stockPrice = quote.regularMarketPrice;
        
        // Default volatility if not available
        const historicVolatility = quote.fiftyTwoWeekRange 
            ? (quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow) / quote.regularMarketPrice
            : 0.3;
        
        const optionsWithGreeks = [];
        
        // Process each expiration date
        for (const exp of optionsChain.expirationDates || []) {
            const expirationDate = new Date(exp);
            const daysToExpiration = Math.max(1, Math.ceil((expirationDate - new Date()) / (1000 * 60 * 60 * 24)));
            
            // Get options for this expiration
            const chainData = await yahooFinance.options(symbol, { date: exp });
            
            // Process calls
            for (const call of chainData.calls || []) {
                const greeks = calculateGreeks({
                    stockPrice,
                    strikePrice: call.strike,
                    daysToExpiration,
                    volatility: call.impliedVolatility || historicVolatility,
                    optionType: 'call'
                });
                
                optionsWithGreeks.push({
                    symbol,
                    type: 'call',
                    strike: call.strike,
                    expiration: expirationDate.toISOString().split('T')[0],
                    daysToExpiration,
                    bid: call.bid,
                    ask: call.ask,
                    lastPrice: call.lastPrice,
                    volume: call.volume,
                    openInterest: call.openInterest,
                    impliedVolatility: call.impliedVolatility,
                    ...greeks
                });
            }
            
            // Process puts
            for (const put of chainData.puts || []) {
                const greeks = calculateGreeks({
                    stockPrice,
                    strikePrice: put.strike,
                    daysToExpiration,
                    volatility: put.impliedVolatility || historicVolatility,
                    optionType: 'put'
                });
                
                optionsWithGreeks.push({
                    symbol,
                    type: 'put',
                    strike: put.strike,
                    expiration: expirationDate.toISOString().split('T')[0],
                    daysToExpiration,
                    bid: put.bid,
                    ask: put.ask,
                    lastPrice: put.lastPrice,
                    volume: put.volume,
                    openInterest: put.openInterest,
                    impliedVolatility: put.impliedVolatility,
                    ...greeks
                });
            }
        }
        
        return {
            symbol,
            stockPrice,
            optionsCount: optionsWithGreeks.length,
            options: optionsWithGreeks
        };
    } catch (error) {
        console.error(`[Options] Error getting options with Greeks for ${symbol}:`, error.message);
        throw error;
    }
}

/**
 * Find options opportunities based on criteria
 * @param {string} symbol - Stock symbol
 * @param {Object} criteria - Selection criteria
 * @returns {Promise<Array>} Filtered options
 */
async function findOptionsOpportunities(symbol, criteria = {}) {
    try {
        const {
            minDelta = 0.3,
            maxDelta = 0.7,
            minGamma = 0.01,
            maxTheta = -0.5,
            minVolume = 100,
            minOpenInterest = 500,
            optionType = 'call' // 'call', 'put', or 'both'
        } = criteria;
        
        const data = await getOptionsWithGreeks(symbol);
        
        let filtered = data.options.filter(option => {
            // Type filter
            if (optionType !== 'both' && option.type !== optionType) return false;
            
            // Greeks filters
            if (Math.abs(option.delta) < minDelta || Math.abs(option.delta) > maxDelta) return false;
            if (option.gamma < minGamma) return false;
            if (option.theta < maxTheta) return false;
            
            // Liquidity filters
            if (option.volume < minVolume) return false;
            if (option.openInterest < minOpenInterest) return false;
            
            return true;
        });
        
        // Sort by delta (strongest signal)
        filtered.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
        
        return filtered;
    } catch (error) {
        console.error(`[Options] Error finding opportunities for ${symbol}:`, error.message);
        throw error;
    }
}

module.exports = {
    getOptionsChain,
    getOptionsWithGreeks,
    calculateGreeks,
    calculateDelta,
    calculateGamma,
    calculateTheta,
    calculateVega,
    findOptionsOpportunities
};
