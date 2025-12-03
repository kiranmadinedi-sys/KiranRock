const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

/**
 * Options Scalping Strategy Service
 * Ultra-short-term trading (minutes to hours)
 * Focus: High Gamma, liquid options, quick profits
 */

/**
 * Scalping criteria for options
 */
const SCALPING_CRITERIA = {
    // Greeks requirements
    minGamma: 0.05,        // High gamma for quick delta changes
    minDelta: 0.40,        // Deep enough ITM for reliable movement
    maxDelta: 0.70,        // Not too deep to maintain leverage
    minVega: 0.10,         // Sensitivity to volatility spikes
    maxTheta: -0.50,       // Limit time decay risk
    
    // Liquidity requirements (CRITICAL for scalping)
    minVolume: 500,        // Minimum daily volume
    minOpenInterest: 1000, // Minimum open interest
    maxBidAskSpread: 0.15, // Max 15% spread
    
    // Time requirements
    minDaysToExp: 7,       // Minimum 1 week
    maxDaysToExp: 45,      // Maximum 45 days (sweet spot for gamma)
    
    // Price requirements
    minOptionPrice: 0.50,  // Avoid penny options
    maxOptionPrice: 15.00, // Keep capital requirement reasonable
    
    // Volatility
    minIV: 0.20,          // 20% minimum IV
    maxIV: 1.50           // 150% maximum IV (avoid meme stocks)
};

// Minimum stock volume for considering scalping (configurable)
SCALPING_CRITERIA.stockMinVolume = 200000; // lowered from 1,000,000 to be more inclusive

/**
 * Find scalping opportunities
 * @param {string} symbol - Stock symbol
 * @returns {Promise<Array>} Scalping candidates
 */
async function findScalpingOpportunities(symbol) {
    try {
        console.log(`[Scalping] Scanning ${symbol} for scalping opportunities...`);
        // Get current quote
        const quote = await yahooFinance.quote(symbol);
        const stockPrice = quote && (quote.regularMarketPrice || quote.regularMarketPreviousClose);
        const volume = quote && (quote.regularMarketVolume || quote.averageDailyVolume3Month || 0);
        console.log(`[Scalping] Quote for ${symbol}: price=${stockPrice}, volume=${volume}`);
        if (!stockPrice || volume < SCALPING_CRITERIA.stockMinVolume) {
            return { symbol, opportunities: [], reason: 'Insufficient stock volume for scalping', quote };
        }

        // --- Enhanced: Fetch 1-min and 5-min chart data ---
        const chart1m = await yahooFinance.chart(symbol, { interval: '1m', range: '1d' });
        const chart5m = await yahooFinance.chart(symbol, { interval: '5m', range: '1d' });
        const prices1m = chart1m.quotes || [];
        const prices5m = chart5m.quotes || [];

        // --- Calculate pre-market support/resistance ---
        const preMarketHigh = Math.max(...prices1m.filter(p => p.isExtendedHours).map(p => p.high));
        const preMarketLow = Math.min(...prices1m.filter(p => p.isExtendedHours).map(p => p.low));
        const sessionHigh = Math.max(...prices1m.map(p => p.high));
        const sessionLow = Math.min(...prices1m.map(p => p.low));

        // --- Calculate VWAP, EMA(9), EMA(21) ---
        function ema(data, period) {
            const k = 2 / (period + 1);
            let emaArr = [];
            let prev = data[0].close;
            for (let i = 0; i < data.length; i++) {
                const val = i === 0 ? data[i].close : (data[i].close - prev) * k + prev;
                emaArr.push(val);
                prev = val;
            }
            return emaArr;
        }
        function vwap(data) {
            let totalPV = 0, totalVol = 0, arr = [];
            for (let i = 0; i < data.length; i++) {
                totalPV += data[i].close * data[i].volume;
                totalVol += data[i].volume;
                arr.push(totalPV / (totalVol || 1));
            }
            return arr;
        }
        const ema9 = ema(prices1m, 9);
        const ema21 = ema(prices1m, 21);
        const vwapArr = vwap(prices1m);

        // --- Detect volume spikes ---
        const avgVol = prices1m.reduce((sum, p) => sum + p.volume, 0) / prices1m.length;
        const volumeSpikes = prices1m.filter(p => p.volume > avgVol * 2);

        // --- Get options chain ---
        const optionsChain = await yahooFinance.options(symbol);
        if (!optionsChain || !optionsChain.expirationDates || optionsChain.expirationDates.length === 0) {
            console.log(`[Scalping] No options chain returned for ${symbol}`);
            return { symbol, opportunities: [], reason: 'No options available', quote };
        }
        console.log(`[Scalping] Options expirations for ${symbol}: ${optionsChain.expirationDates.length}`);
        const opportunities = [];
        // Scan near-term expirations (best for scalping)
        const nearTermExps = optionsChain.expirationDates.slice(0, 4);
        for (const exp of nearTermExps) {
            const expirationDate = new Date(exp);
            const daysToExpiration = Math.ceil((expirationDate - new Date()) / (1000 * 60 * 60 * 24));
            if (daysToExpiration < SCALPING_CRITERIA.minDaysToExp || daysToExpiration > SCALPING_CRITERIA.maxDaysToExp) continue;
            const chainData = await yahooFinance.options(symbol, { date: exp });
            const allOptions = [
                ...(chainData.calls || []).map(o => ({ ...o, type: 'call' })),
                ...(chainData.puts || []).map(o => ({ ...o, type: 'put' }))
            ];
            for (const option of allOptions) {
                // Only allow trades with tight spread (<$0.10 for TSLA)
                if (symbol === 'TSLA' && (option.ask - option.bid) > 0.10) continue;
                const analysis = analyzeScalpingCandidate(option, stockPrice, daysToExpiration);
                if (analysis.isGoodScalp) {
                    opportunities.push({
                        symbol,
                        type: option.type,
                        strike: option.strike,
                        expiration: expirationDate.toISOString().split('T')[0],
                        daysToExpiration,
                        bid: option.bid,
                        ask: option.ask,
                        lastPrice: option.lastPrice,
                        volume: option.volume,
                        openInterest: option.openInterest,
                        impliedVolatility: option.impliedVolatility,
                        ...analysis.greeks,
                        scalpScore: analysis.scalpScore,
                        bidAskSpread: analysis.bidAskSpread,
                        bidAskSpreadPercent: analysis.bidAskSpreadPercent,
                        entryPrice: analysis.entryPrice,
                        targetProfit: analysis.targetProfit,
                        stopLoss: analysis.stopLoss,
                        expectedMove: analysis.expectedMove,
                        timeframe: analysis.timeframe
                    });
                }
            }
        }
        opportunities.sort((a, b) => b.scalpScore - a.scalpScore);
        console.log(`[Scalping] Found ${opportunities.length} scalping opportunities for ${symbol}`);
        // --- Return strategy signals ---
        return {
            symbol,
            stockPrice,
            stockVolume: volume,
            preMarketHigh,
            preMarketLow,
            sessionHigh,
            sessionLow,
            ema9: ema9[ema9.length - 1],
            ema21: ema21[ema21.length - 1],
            vwap: vwapArr[vwapArr.length - 1],
            volumeSpikes,
            opportunities: opportunities.slice(0, 10),
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error(`[Scalping] Error scanning ${symbol}:`, error.message);
        return { symbol, opportunities: [], error: error.message };
    }
}

/**
 * Analyze if option is good for scalping
 */
function analyzeScalpingCandidate(option, stockPrice, daysToExpiration) {
    const T = daysToExpiration / 365;
    const sigma = option.impliedVolatility || 0.30;
    const r = 0.05;
    
    // Calculate Greeks
    const d1 = (Math.log(stockPrice / option.strike) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    
    const normalCDF = (x) => {
        const t = 1 / (1 + 0.2316419 * Math.abs(x));
        const d = 0.3989423 * Math.exp(-x * x / 2);
        const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
        return x > 0 ? 1 - prob : prob;
    };
    
    const normalPDF = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    
    const delta = option.type === 'call' ? normalCDF(d1) : normalCDF(d1) - 1;
    const gamma = normalPDF(d1) / (stockPrice * sigma * Math.sqrt(T));
    const theta = (-(stockPrice * normalPDF(d1) * sigma) / (2 * Math.sqrt(T)) - 
                   (option.type === 'call' ? 1 : -1) * r * option.strike * Math.exp(-r * T) * 
                   normalCDF(option.type === 'call' ? d2 : -d2)) / 365;
    const vega = stockPrice * normalPDF(d1) * Math.sqrt(T) / 100;
    
    // Bid-ask spread analysis
    const bidAskSpread = option.ask - option.bid;
    const midPrice = (option.ask + option.bid) / 2;
    const bidAskSpreadPercent = (bidAskSpread / midPrice) * 100;
    
    // Check all criteria
    let passedChecks = 0;
    let totalChecks = 0;
    
    const checks = {
        gamma: gamma >= SCALPING_CRITERIA.minGamma,
        delta: Math.abs(delta) >= SCALPING_CRITERIA.minDelta && Math.abs(delta) <= SCALPING_CRITERIA.maxDelta,
        vega: vega >= SCALPING_CRITERIA.minVega,
        theta: theta >= SCALPING_CRITERIA.maxTheta,
        volume: option.volume >= SCALPING_CRITERIA.minVolume,
        openInterest: option.openInterest >= SCALPING_CRITERIA.minOpenInterest,
        spread: bidAskSpreadPercent <= SCALPING_CRITERIA.maxBidAskSpread,
        price: midPrice >= SCALPING_CRITERIA.minOptionPrice && midPrice <= SCALPING_CRITERIA.maxOptionPrice,
        iv: sigma >= SCALPING_CRITERIA.minIV && sigma <= SCALPING_CRITERIA.maxIV
    };
    
    Object.values(checks).forEach(passed => {
        totalChecks++;
        if (passed) passedChecks++;
    });
    
    // Scalp score (0-100)
    const scalpScore = (passedChecks / totalChecks) * 100;
    
    // Good scalp if passes at least 80% of checks
    const isGoodScalp = scalpScore >= 80;
    
    // Calculate trade parameters
    const entryPrice = option.ask; // Always use ask for entry
    const targetProfit = entryPrice * 0.20; // 20% profit target
    const stopLoss = entryPrice * 0.10; // 10% stop loss
    
    // Expected stock move needed for profit (using delta)
    const expectedMove = (targetProfit / Math.abs(delta)).toFixed(2);
    
    // Recommended timeframe based on theta
    let timeframe = 'Intraday';
    if (Math.abs(theta) < 0.10) timeframe = '1-2 days';
    else if (Math.abs(theta) < 0.30) timeframe = '4-8 hours';
    
    return {
        isGoodScalp,
        scalpScore: scalpScore.toFixed(1),
        greeks: {
            delta: delta.toFixed(4),
            gamma: gamma.toFixed(4),
            theta: theta.toFixed(4),
            vega: vega.toFixed(4)
        },
        bidAskSpread: bidAskSpread.toFixed(2),
        bidAskSpreadPercent: bidAskSpreadPercent.toFixed(2) + '%',
        entryPrice: entryPrice.toFixed(2),
        targetProfit: targetProfit.toFixed(2),
        stopLoss: stopLoss.toFixed(2),
        expectedMove: `$${expectedMove}`,
        timeframe,
        checks
    };
}

/**
 * Scan multiple stocks for scalping
 */
async function scanMarketForScalps(symbols, limit = 20) {
    console.log(`[Scalping] Scanning ${symbols.length} symbols for scalping opportunities...`);
    
    const allOpportunities = [];
    
    for (const symbol of symbols) {
        try {
            const result = await findScalpingOpportunities(symbol);
            
            if (result.opportunities && result.opportunities.length > 0) {
                result.opportunities.forEach(opp => {
                    allOpportunities.push(opp);
                });
            }
            
            // Rate limiting
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`[Scalping] Error with ${symbol}:`, error.message);
        }
    }
    
    // Sort by scalp score
    allOpportunities.sort((a, b) => parseFloat(b.scalpScore) - parseFloat(a.scalpScore));
    
    console.log(`[Scalping] ✓ Found ${allOpportunities.length} total opportunities`);
    
    return {
        totalScanned: symbols.length,
        opportunitiesFound: allOpportunities.length,
        topOpportunities: allOpportunities.slice(0, limit),
        timestamp: new Date().toISOString()
    };
}

/**
 * Get scalping watchlist (most liquid options stocks)
 */
function getScalpingWatchlist() {
    return [
        // Tech (high volume, high IV)
        'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AMD', 'NFLX',
        // Finance (liquid options)
        'JPM', 'BAC', 'WFC', 'GS', 'V', 'MA',
        // High IV stocks
        'SPY', 'QQQ', 'IWM', // ETFs with massive options volume
        // Popular scalping stocks
        'COIN', 'PLTR', 'RIVN', 'LCID', 'F', 'AAL', 'CCL'
    ];
}

module.exports = {
    findScalpingOpportunities,
    scanMarketForScalps,
    getScalpingWatchlist,
    SCALPING_CRITERIA
};
