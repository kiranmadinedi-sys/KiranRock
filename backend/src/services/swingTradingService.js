const stockDataService = require('./stockDataService');

/**
 * Swing Trading Service
 * Implements swing trading strategies with pattern detection
 * Target: <1 month holding period with EMA 9-day crossovers and Cup & Handle pattern
 */

/**
 * Calculate Exponential Moving Average (EMA)
 * @param {Array} prices - Array of closing prices
 * @param {number} period - EMA period (default 9)
 * @returns {Array} EMA values
 */
function calculateEMA(prices, period = 9) {
    const ema = [];
    const multiplier = 2 / (period + 1);
    
    // First EMA is SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += prices[i];
    }
    ema[period - 1] = sum / period;
    
    // Calculate subsequent EMA values
    for (let i = period; i < prices.length; i++) {
        ema[i] = (prices[i] - ema[i - 1]) * multiplier + ema[i - 1];
    }
    
    return ema;
}

/**
 * Detect EMA 9-day crossover signals
 * @param {string} symbol - Stock symbol
 * @returns {Promise<Object>} Crossover signal data
 */
async function detectEMACrossover(symbol) {
    try {
        // Get 60 days of data to have enough for EMA calculation
        const stockData = await stockDataService.getStockData(symbol, '1d', false);
        
        if (!stockData || !Array.isArray(stockData) || stockData.length < 20) {
            console.log(`[Swing Trading] Insufficient data for ${symbol}. Got ${stockData?.length || 0} candles`);
            return { 
                signal: 'NEUTRAL', 
                reason: 'Insufficient data - need at least 20 days of price history',
                currentPrice: 0,
                ema9: 0,
                distance: 'N/A'
            };
        }
        
        const closePrices = stockData.map(candle => candle.close);
        const currentPrice = closePrices[closePrices.length - 1];
        
        // Calculate EMA 9
        const ema9 = calculateEMA(closePrices, 9);
        const currentEMA9 = ema9[ema9.length - 1];
        const previousEMA9 = ema9[ema9.length - 2];
        const previousPrice = closePrices[closePrices.length - 2];
        
        // Bullish crossover: price crosses above EMA 9
        if (previousPrice < previousEMA9 && currentPrice > currentEMA9) {
            return {
                signal: 'BUY',
                reason: 'Bullish EMA 9 crossover',
                currentPrice,
                ema9: currentEMA9,
                distance: ((currentPrice - currentEMA9) / currentEMA9 * 100).toFixed(2) + '%'
            };
        }
        
        // Bearish crossover: price crosses below EMA 9
        if (previousPrice > previousEMA9 && currentPrice < currentEMA9) {
            return {
                signal: 'SELL',
                reason: 'Bearish EMA 9 crossover',
                currentPrice,
                ema9: currentEMA9,
                distance: ((currentPrice - currentEMA9) / currentEMA9 * 100).toFixed(2) + '%'
            };
        }
        
        // Price above EMA (bullish)
        if (currentPrice > currentEMA9) {
            return {
                signal: 'HOLD',
                reason: 'Price above EMA 9 (bullish trend)',
                currentPrice,
                ema9: currentEMA9,
                distance: ((currentPrice - currentEMA9) / currentEMA9 * 100).toFixed(2) + '%'
            };
        }
        
        // Price below EMA (bearish)
        return {
            signal: 'NEUTRAL',
            reason: 'Price below EMA 9 (bearish trend)',
            currentPrice,
            ema9: currentEMA9,
            distance: ((currentPrice - currentEMA9) / currentEMA9 * 100).toFixed(2) + '%'
        };
    } catch (error) {
        console.error(`[Swing Trading] EMA crossover error for ${symbol}:`, error.message);
        throw error;
    }
}

/**
 * Detect Cup and Handle pattern
 * @param {string} symbol - Stock symbol
 * @returns {Promise<Object>} Cup & Handle pattern data
 */
async function detectCupAndHandle(symbol) {
    try {
        // Get 90 days of data to detect pattern formation
        const stockData = await stockDataService.getStockData(symbol, '1d', false);
        
        if (!stockData || !Array.isArray(stockData) || stockData.length < 40) {
            return { 
                detected: false, 
                reason: 'Insufficient data for pattern detection - need at least 40 days',
                confidence: 0
            };
        }
        
        const candles = stockData;
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);
        
        // Pattern detection parameters
        const lookback = Math.min(60, closes.length);
        const recentData = closes.slice(-lookback);
        const recentHighs = highs.slice(-lookback);
        const recentLows = lows.slice(-lookback);
        const recentVolumes = volumes.slice(-lookback);
        
        // Step 1: Find the left rim (peak)
        const leftRimIndex = recentHighs.indexOf(Math.max(...recentHighs.slice(0, lookback * 0.3)));
        const leftRimPrice = recentHighs[leftRimIndex];
        
        // Step 2: Find the cup bottom (trough) after left rim
        const cupSearchStart = leftRimIndex + 5;
        const cupSearchEnd = Math.min(cupSearchStart + Math.floor(lookback * 0.5), lookback - 15);
        
        if (cupSearchEnd <= cupSearchStart) {
            return { detected: false, reason: 'Not enough data after left rim', confidence: 0 };
        }
        
        const cupBottomIndex = cupSearchStart + recentLows.slice(cupSearchStart, cupSearchEnd)
            .indexOf(Math.min(...recentLows.slice(cupSearchStart, cupSearchEnd)));
        const cupBottomPrice = recentLows[cupBottomIndex];
        
        // Cup depth should be 12-33% from left rim
        const cupDepth = ((leftRimPrice - cupBottomPrice) / leftRimPrice) * 100;
        
        if (cupDepth < 12 || cupDepth > 50) {
            return { 
                detected: false, 
                reason: `Cup depth ${cupDepth.toFixed(1)}% outside ideal range (12-33%)`,
                confidence: 0
            };
        }
        
        // Step 3: Find the right rim (should be near left rim price)
        const rightRimSearchStart = cupBottomIndex + 10;
        const rightRimSearchEnd = Math.min(rightRimSearchStart + 20, lookback - 5);
        
        if (rightRimSearchEnd <= rightRimSearchStart) {
            return { detected: false, reason: 'Not enough data for right rim', confidence: 0 };
        }
        
        const rightRimIndex = rightRimSearchStart + recentHighs.slice(rightRimSearchStart, rightRimSearchEnd)
            .indexOf(Math.max(...recentHighs.slice(rightRimSearchStart, rightRimSearchEnd)));
        const rightRimPrice = recentHighs[rightRimIndex];
        
        // Right rim should be within 5% of left rim
        const rimSymmetry = Math.abs((rightRimPrice - leftRimPrice) / leftRimPrice) * 100;
        
        if (rimSymmetry > 5) {
            return { 
                detected: false, 
                reason: `Rims not symmetrical (${rimSymmetry.toFixed(1)}% difference)`,
                confidence: 0
            };
        }
        
        // Step 4: Detect the handle (small pullback after right rim)
        const handleSearchStart = rightRimIndex + 1;
        const handleData = recentData.slice(handleSearchStart);
        const handleLows = recentLows.slice(handleSearchStart);
        const handleVolumes = recentVolumes.slice(handleSearchStart);
        
        if (handleData.length < 5) {
            return { 
                detected: false, 
                reason: 'Handle not yet formed',
                confidence: 0
            };
        }
        
        const handleLow = Math.min(...handleLows);
        const handleDepth = ((rightRimPrice - handleLow) / rightRimPrice) * 100;
        
        // Handle should be shallow (typically 8-15% pullback)
        if (handleDepth < 5 || handleDepth > 20) {
            return { 
                detected: false, 
                reason: `Handle depth ${handleDepth.toFixed(1)}% outside ideal range (8-15%)`,
                confidence: 0
            };
        }
        
        // Step 5: Check volume characteristics
        // Volume should decrease in handle formation (consolidation)
        const cupVolume = recentVolumes.slice(cupBottomIndex, rightRimIndex);
        const avgCupVolume = cupVolume.reduce((a, b) => a + b, 0) / cupVolume.length;
        const avgHandleVolume = handleVolumes.reduce((a, b) => a + b, 0) / handleVolumes.length;
        
        const volumeDecrease = ((avgCupVolume - avgHandleVolume) / avgCupVolume) * 100;
        
        // Current price position
        const currentPrice = closes[closes.length - 1];
        const distanceFromBreakout = ((rightRimPrice - currentPrice) / currentPrice) * 100;
        
        // Calculate confidence score (0-100)
        let confidence = 0;
        
        // Cup depth score (ideal 15-25%)
        if (cupDepth >= 15 && cupDepth <= 25) confidence += 30;
        else if (cupDepth >= 12 && cupDepth <= 33) confidence += 20;
        else confidence += 10;
        
        // Rim symmetry score
        if (rimSymmetry < 2) confidence += 25;
        else if (rimSymmetry < 5) confidence += 15;
        
        // Handle depth score (ideal 8-15%)
        if (handleDepth >= 8 && handleDepth <= 15) confidence += 25;
        else if (handleDepth >= 5 && handleDepth <= 20) confidence += 15;
        
        // Volume score
        if (volumeDecrease > 20) confidence += 20;
        else if (volumeDecrease > 0) confidence += 10;
        
        // Pattern is valid if confidence >= 50%
        const detected = confidence >= 50;
        
        return {
            detected,
            confidence,
            patternDetails: {
                leftRimPrice,
                cupBottomPrice,
                cupDepth: cupDepth.toFixed(2) + '%',
                rightRimPrice,
                rimSymmetry: rimSymmetry.toFixed(2) + '%',
                handleLow,
                handleDepth: handleDepth.toFixed(2) + '%',
                volumeDecrease: volumeDecrease.toFixed(2) + '%',
                breakoutPrice: rightRimPrice,
                currentPrice,
                distanceFromBreakout: distanceFromBreakout.toFixed(2) + '%',
                avgCupVolume: Math.round(avgCupVolume),
                avgHandleVolume: Math.round(avgHandleVolume)
            },
            signal: detected && distanceFromBreakout < 2 ? 'BUY' : 'WATCH',
            reason: detected 
                ? `Cup & Handle pattern detected (${confidence}% confidence)${distanceFromBreakout < 2 ? ' - Near breakout!' : ''}`
                : `Pattern incomplete or low confidence (${confidence}%)`
        };
    } catch (error) {
        console.error(`[Swing Trading] Cup & Handle detection error for ${symbol}:`, error.message);
        throw error;
    }
}

/**
 * Get comprehensive swing trading analysis
 * @param {string} symbol - Stock symbol
 * @returns {Promise<Object>} Combined swing trading signals
 */
async function getSwingTradingAnalysis(symbol) {
    try {
        const [emaCrossover, cupAndHandle] = await Promise.all([
            detectEMACrossover(symbol),
            detectCupAndHandle(symbol)
        ]);
        
        // Combine signals for overall recommendation
        let overallSignal = 'NEUTRAL';
        const reasons = [];
        
        if (emaCrossover.signal === 'BUY' && cupAndHandle.signal === 'BUY') {
            overallSignal = 'STRONG BUY';
            reasons.push('EMA crossover + Cup & Handle breakout');
        } else if (emaCrossover.signal === 'BUY' || cupAndHandle.signal === 'BUY') {
            overallSignal = 'BUY';
            if (emaCrossover.signal === 'BUY') reasons.push(emaCrossover.reason);
            if (cupAndHandle.signal === 'BUY') reasons.push(cupAndHandle.reason);
        } else if (cupAndHandle.signal === 'WATCH') {
            overallSignal = 'WATCH';
            reasons.push('Cup & Handle forming - monitor for breakout');
        } else if (emaCrossover.signal === 'SELL') {
            overallSignal = 'SELL';
            reasons.push(emaCrossover.reason);
        }
        
        return {
            symbol,
            timestamp: new Date().toISOString(),
            overallSignal,
            reasons,
            emaAnalysis: emaCrossover,
            cupAndHandleAnalysis: cupAndHandle,
            recommendedHoldingPeriod: '2-4 weeks',
            strategy: 'Swing Trading'
        };
    } catch (error) {
        console.error(`[Swing Trading] Analysis error for ${symbol}:`, error.message);
        throw error;
    }
}

/**
 * Scan multiple symbols for swing trading opportunities
 * @param {Array<string>} symbols - Array of stock symbols
 * @returns {Promise<Array>} Sorted opportunities
 */
async function scanForSwingOpportunities(symbols) {
    try {
        const analyses = await Promise.all(
            symbols.map(symbol => getSwingTradingAnalysis(symbol).catch(err => {
                console.error(`Error analyzing ${symbol}:`, err.message);
                return null;
            }))
        );
        
        // Filter out errors and sort by signal strength
        const validAnalyses = analyses.filter(a => a !== null);
        
        const signalPriority = {
            'STRONG BUY': 5,
            'BUY': 4,
            'WATCH': 3,
            'HOLD': 2,
            'SELL': 1,
            'NEUTRAL': 0
        };
        
        return validAnalyses.sort((a, b) => {
            return signalPriority[b.overallSignal] - signalPriority[a.overallSignal];
        });
    } catch (error) {
        console.error('[Swing Trading] Scan error:', error.message);
        throw error;
    }
}

module.exports = {
    calculateEMA,
    detectEMACrossover,
    detectCupAndHandle,
    getSwingTradingAnalysis,
    scanForSwingOpportunities
};
