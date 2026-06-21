const fs = require('fs');
const path = require('path');
const dataProvider = require('./dataProvider');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const { query } = require('../config/database');

const optionsCacheDir = path.join(__dirname, '..', 'storage', 'options-cache');
const optionsCacheMaxAgeMs = Math.max(60 * 60 * 1000, Number(process.env.OPTIONS_CACHE_MAX_AGE_MS) || (6 * 60 * 60 * 1000));

function getOptionsCacheFilePath(symbol) {
    const safeSymbol = String(symbol || '').replace(/[^A-Za-z0-9_.-]/g, '_').toUpperCase();
    return path.join(optionsCacheDir, `${safeSymbol}.json`);
}

async function ensureOptionsCacheDir() {
    try {
        await fs.promises.mkdir(optionsCacheDir, { recursive: true });
    } catch (error) {
        // Ignore cache directory failures and continue without persistent cache.
    }
}

async function saveOptionsSnapshot(symbol, payload) {
    if (!payload || !Array.isArray(payload.options) || payload.options.length === 0) {
        return;
    }

    try {
        await ensureOptionsCacheDir();
        await fs.promises.writeFile(
            getOptionsCacheFilePath(symbol),
            JSON.stringify({ cachedAt: new Date().toISOString(), payload }, null, 2),
            'utf8'
        );
    } catch (error) {
        console.warn(`[Options] Failed to persist options cache for ${symbol}:`, error.message);
    }
}

async function loadOptionsSnapshot(symbol) {
    try {
        const raw = await fs.promises.readFile(getOptionsCacheFilePath(symbol), 'utf8');
        const parsed = JSON.parse(raw);
        const cachedAt = parsed?.cachedAt ? new Date(parsed.cachedAt) : null;
        const ageMs = cachedAt ? Date.now() - cachedAt.getTime() : Number.POSITIVE_INFINITY;

        if (!parsed?.payload || !Array.isArray(parsed.payload.options) || parsed.payload.options.length === 0) {
            return null;
        }

        if (!Number.isFinite(ageMs) || ageMs > optionsCacheMaxAgeMs) {
            return null;
        }

        return {
            ...parsed.payload,
            cache: {
                source: 'file-fallback',
                cachedAt: parsed.cachedAt,
                ageMs
            }
        };
    } catch (error) {
        return null;
    }
}

// === DB CACHE LAYER ===

async function loadOptionsFromDB(symbol, maxAgeMs = optionsCacheMaxAgeMs) {
    try {
        const result = await query(
            'SELECT * FROM options_chain_cache WHERE symbol = $1',
            [String(symbol).toUpperCase()]
        );
        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        const ageMs = Date.now() - new Date(row.fetched_at).getTime();
        if (ageMs > maxAgeMs) return null;

        const options = Array.isArray(row.payload) ? row.payload : [];
        if (options.length === 0) return null;

        return {
            symbol: row.symbol,
            stockPrice: row.stock_price ? parseFloat(row.stock_price) : null,
            optionsCount: options.length,
            options,
            cache: { source: 'db-cache', cachedAt: row.fetched_at, ageMs }
        };
    } catch (error) {
        console.warn(`[Options] DB cache read failed for ${symbol}:`, error.message);
        return null;
    }
}

async function saveOptionsToDB(symbol, payload) {
    if (!payload || !Array.isArray(payload.options) || payload.options.length === 0) return;
    const sym = String(symbol).toUpperCase();
    try {
        // Rolling cache — one row per symbol, always fresh
        await query(
            `INSERT INTO options_chain_cache (symbol, fetched_at, stock_price, options_count, payload, source)
             VALUES ($1, NOW(), $2, $3, $4::jsonb, 'yahoo')
             ON CONFLICT (symbol) DO UPDATE SET
               fetched_at    = NOW(),
               stock_price   = EXCLUDED.stock_price,
               options_count = EXCLUDED.options_count,
               payload       = EXCLUDED.payload,
               source        = EXCLUDED.source`,
            [sym, payload.stockPrice ?? null, payload.options.length, JSON.stringify(payload.options)]
        );
    } catch (error) {
        console.warn(`[Options] DB cache write failed for ${sym}:`, error.message);
    }

    // Historical append — build long-term options dataset (one row per contract per day)
    try {
        const today = new Date().toISOString().split('T')[0];
        for (const opt of payload.options) {
            await query(
                `INSERT INTO options_chain_history
                    (symbol, captured_date, expiration_date, option_type, strike,
                     bid, ask, last_price, volume, open_interest, implied_volatility,
                     delta, gamma, theta, vega, stock_price, days_to_exp, source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'yahoo')
                 ON CONFLICT (symbol, captured_date, expiration_date, option_type, strike)
                 DO UPDATE SET
                   bid=EXCLUDED.bid, ask=EXCLUDED.ask, last_price=EXCLUDED.last_price,
                   volume=EXCLUDED.volume, open_interest=EXCLUDED.open_interest,
                   implied_volatility=EXCLUDED.implied_volatility,
                   delta=EXCLUDED.delta, gamma=EXCLUDED.gamma,
                   theta=EXCLUDED.theta, vega=EXCLUDED.vega,
                   stock_price=EXCLUDED.stock_price, days_to_exp=EXCLUDED.days_to_exp`,
                [
                    sym, today, opt.expirationDate, opt.optionType,
                    opt.strikePrice,
                    opt.bid ?? null, opt.ask ?? null, opt.lastPrice ?? null,
                    opt.volume ?? null, opt.openInterest ?? null, opt.impliedVolatility ?? null,
                    opt.greeks?.delta ?? null, opt.greeks?.gamma ?? null,
                    opt.greeks?.theta ?? null, opt.greeks?.vega ?? null,
                    payload.stockPrice ?? null,
                    opt.daysToExpiration ?? null
                ]
            ).catch(() => {}); // ignore per-row conflicts silently
        }
        console.info(`[Options] Persisted ${payload.options.length} contracts to history for ${sym} (${today})`);
    } catch (histErr) {
        console.warn(`[Options] History write failed for ${sym}:`, histErr.message);
    }
}

// === FILE + DB FALLBACK ===

async function buildCachedFallbackResponse(symbol, stockPrice, reason) {
    // DB cache first — faster, more reliable, populated by pre-market job
    const dbCached = await loadOptionsFromDB(symbol);
    if (dbCached) {
        console.warn(`[Options] Using DB-cached options for ${symbol}: ${reason}`);
        return { ...dbCached, stockPrice: stockPrice ?? dbCached.stockPrice ?? null, warning: reason };
    }

    // File cache as last resort
    const fileCached = await loadOptionsSnapshot(symbol);
    if (!fileCached) return null;

    console.warn(`[Options] Using file-cached options snapshot for ${symbol}: ${reason}`);
    return { ...fileCached, stockPrice: stockPrice ?? fileCached.stockPrice ?? null, warning: reason };
}

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
        const options = await dataProvider.getOptionsChain(symbol);
        return options;
    } catch (error) {
        console.error(`[Options] Error fetching options chain for ${symbol}:`, error.message);
        throw error;
    }
}

function normalizeOptionContract({ symbol, stockPrice, strikePrice, expirationDate, daysToExpiration, optionType, bid, ask, lastPrice, volume, openInterest, impliedVolatility, providedGreeks }) {
    const fallbackVolatility = impliedVolatility || 0.3;
    const calculatedGreeks = calculateGreeks({
        stockPrice,
        strikePrice,
        daysToExpiration,
        volatility: fallbackVolatility,
        optionType
    });

    const mergedGreeks = {
        delta: providedGreeks?.delta ?? calculatedGreeks.delta,
        gamma: providedGreeks?.gamma ?? calculatedGreeks.gamma,
        theta: providedGreeks?.theta ?? calculatedGreeks.theta,
        vega: providedGreeks?.vega ?? calculatedGreeks.vega,
        impliedVolatility: parseFloat((providedGreeks?.impliedVolatility ?? fallbackVolatility ?? 0).toFixed(4)),
        theoreticalPrice: providedGreeks?.theoreticalPrice ?? calculatedGreeks.theoreticalPrice,
        intrinsicValue: providedGreeks?.intrinsicValue ?? calculatedGreeks.intrinsicValue,
        timeValue: providedGreeks?.timeValue ?? calculatedGreeks.timeValue
    };

    return {
        symbol,
        type: optionType,
        optionType,
        strike: strikePrice,
        expiration: expirationDate,
        expirationDate,
        daysToExpiration,
        bid: bid || 0,
        ask: ask || 0,
        lastPrice: lastPrice || 0,
        volume: volume || 0,
        openInterest: openInterest || 0,
        impliedVolatility: impliedVolatility || fallbackVolatility,
        greeks: mergedGreeks,
        delta: mergedGreeks.delta,
        gamma: mergedGreeks.gamma,
        theta: mergedGreeks.theta,
        vega: mergedGreeks.vega,
        theoreticalPrice: mergedGreeks.theoreticalPrice,
        intrinsicValue: mergedGreeks.intrinsicValue,
        timeValue: mergedGreeks.timeValue
    };
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

        // Cache-first: serve from DB during market hours to avoid live API calls.
        // The 8 AM pre-market warmup populates this; a 23-hour window keeps the
        // cache valid all day while allowing the next morning's warmup to refresh it.
        const cached = await loadOptionsFromDB(symbol, 23 * 60 * 60 * 1000);
        if (cached && cached.options.length > 0) {
            console.info(`[Options] DB cache hit for ${symbol} — ${cached.options.length} contracts, age ${(cached.cache.ageMs / 3_600_000).toFixed(1)}h`);
            return cached;
        }

        const optionsChain = await getOptionsChain(symbol);
        
        const quote = await dataProvider.getQuote(symbol);
        const stockPrice = quote?.price || quote?.regularMarketPrice || null;
        const historicVolatility = stockPrice && quote?.high52w && quote?.low52w
            ? Math.max(0.1, (quote.high52w - quote.low52w) / stockPrice)
            : 0.3;

        if (!optionsChain) {
            console.warn(`[Options] No options data available for ${symbol}`);
            const cachedFallback = await buildCachedFallbackResponse(symbol, stockPrice, 'Using cached options snapshot because live options chain is unavailable');
            if (cachedFallback) {
                return cachedFallback;
            }
            return {
                symbol,
                stockPrice,
                error: 'No options data available for this symbol',
                options: []
            };
        }
        
        const optionsWithGreeks = [];

        if (Array.isArray(optionsChain.results) && optionsChain.results.length > 0) {
            for (const contract of optionsChain.results) {
                const details = contract.details || {};
                const expirationDate = details.expiration_date;
                const strikePrice = Number(details.strike_price);
                const optionType = String(details.contract_type || '').toLowerCase() === 'put' ? 'put' : 'call';
                const daysToExpiration = Math.max(1, Math.ceil((new Date(expirationDate) - new Date()) / (1000 * 60 * 60 * 24)));

                if (!expirationDate || !strikePrice || daysToExpiration < 7 || daysToExpiration > 60) {
                    continue;
                }

                optionsWithGreeks.push(normalizeOptionContract({
                    symbol,
                    stockPrice,
                    strikePrice,
                    expirationDate,
                    daysToExpiration,
                    optionType,
                    bid: Number(contract.last_quote?.bid || contract.quote?.bid || 0),
                    ask: Number(contract.last_quote?.ask || contract.quote?.ask || 0),
                    lastPrice: Number(contract.last_trade?.price || contract.day?.close || 0),
                    volume: Number(contract.day?.volume || 0),
                    openInterest: Number(contract.open_interest || 0),
                    impliedVolatility: Number(contract.implied_volatility || historicVolatility || 0.3),
                    providedGreeks: contract.greeks ? {
                        delta: Number(contract.greeks.delta),
                        gamma: Number(contract.greeks.gamma),
                        theta: Number(contract.greeks.theta),
                        vega: Number(contract.greeks.vega),
                        impliedVolatility: Number(contract.implied_volatility || historicVolatility || 0.3)
                    } : null
                }));
            }

            return {
                symbol,
                stockPrice,
                optionsCount: optionsWithGreeks.length,
                options: optionsWithGreeks
            };
        }

        // Check if Yahoo-style options data is available
        if (!optionsChain.expirationDates || optionsChain.expirationDates.length === 0) {
            console.warn(`[Options] No Yahoo-style options data available for ${symbol}`);
            const cachedFallback = await buildCachedFallbackResponse(symbol, stockPrice, 'Using cached options snapshot because live Yahoo options expirations are unavailable');
            if (cachedFallback) {
                return cachedFallback;
            }
            return {
                symbol,
                stockPrice,
                error: 'No options data available for this symbol',
                options: []
            };
        }
        
        // Yahoo's initial response already includes calls + puts for the nearest
        // expiration — use them directly.  The old per-expiration loop issued N
        // additional yf.options(symbol, {date}) calls which exhausted the Yahoo
        // crumb rate limit (429).  One call per symbol is all we need.
        const nearExpRaw = (optionsChain.expirationDates || [])[0];
        if (!nearExpRaw) {
            const cachedFallback = await buildCachedFallbackResponse(symbol, stockPrice, 'No Yahoo expirations returned');
            if (cachedFallback) return cachedFallback;
            return { symbol, stockPrice, error: 'No options data available', options: [] };
        }

        // expirationDates may be Unix timestamps (seconds) or ISO strings
        const expirationDate = new Date(
            Number.isFinite(Number(nearExpRaw)) && Number(nearExpRaw) > 1_000_000_000
                ? Number(nearExpRaw) * 1000
                : nearExpRaw
        );
        const daysToExpiration = Math.max(1, Math.ceil((expirationDate - new Date()) / (1000 * 60 * 60 * 24)));
        const expirationDateStr = expirationDate.toISOString().split('T')[0];

        if (daysToExpiration >= 7 && daysToExpiration <= 60) {
            for (const call of optionsChain.calls || []) {
                optionsWithGreeks.push(normalizeOptionContract({
                    symbol,
                    stockPrice,
                    strikePrice: call.strike,
                    expirationDate: expirationDateStr,
                    daysToExpiration,
                    optionType: 'call',
                    bid: call.bid || 0,
                    ask: call.ask || 0,
                    lastPrice: call.lastPrice || 0,
                    volume: call.volume || 0,
                    openInterest: call.openInterest || 0,
                    impliedVolatility: call.impliedVolatility || historicVolatility
                }));
            }
            for (const put of optionsChain.puts || []) {
                optionsWithGreeks.push(normalizeOptionContract({
                    symbol,
                    stockPrice,
                    strikePrice: put.strike,
                    expirationDate: expirationDateStr,
                    daysToExpiration,
                    optionType: 'put',
                    bid: put.bid || 0,
                    ask: put.ask || 0,
                    lastPrice: put.lastPrice || 0,
                    volume: put.volume || 0,
                    openInterest: put.openInterest || 0,
                    impliedVolatility: put.impliedVolatility || historicVolatility
                }));
            }
        }

        if (optionsWithGreeks.length === 0) {
            const cachedFallback = await buildCachedFallbackResponse(symbol, stockPrice, 'Using cached options snapshot because no contracts passed live normalization filters');
            if (cachedFallback) {
                return cachedFallback;
            }
        }

        const payload = {
            symbol,
            stockPrice,
            optionsCount: optionsWithGreeks.length,
            options: optionsWithGreeks
        };

        // Save to both DB (primary) and file (fallback)
        await Promise.all([
            saveOptionsToDB(symbol, payload),
            saveOptionsSnapshot(symbol, payload)
        ]);
        return payload;
    } catch (error) {
        console.error(`[Options] Error getting options with Greeks for ${symbol}:`, error.message);
        const cachedFallback = await buildCachedFallbackResponse(symbol, null, `Using cached options snapshot after live fetch failure: ${error.message}`);
        if (cachedFallback) {
            return cachedFallback;
        }
        // Return graceful error response instead of throwing
        return {
            symbol,
            stockPrice: null,
            error: `Failed to fetch options data: ${error.message}`,
            options: []
        };
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
        // Return empty array instead of throwing
        return [];
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
    findOptionsOpportunities,
    saveOptionsToDB
};
