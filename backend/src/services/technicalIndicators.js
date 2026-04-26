/**
 * Technical Indicators Library
 * Provides comprehensive technical analysis calculations
 */

/**
 * Calculate RSI (Relative Strength Index)
 */
const calculateRSI = (data, period = 14) => {
    if (data.length < period + 1) return [];
    
    const rsi = [];
    let gains = 0;
    let losses = 0;
    
    // Initial average gain/loss
    for (let i = 1; i <= period; i++) {
        const change = data[i].close - data[i - 1].close;
        if (change > 0) gains += change;
        else losses -= change;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    
    rsi.push({
        time: data[period].time,
        value: 100 - (100 / (1 + avgGain / avgLoss))
    });
    
    // Calculate RSI for remaining data
    for (let i = period + 1; i < data.length; i++) {
        const change = data[i].close - data[i - 1].close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        
        rsi.push({
            time: data[i].time,
            value: avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss))
        });
    }
    
    return rsi;
};

/**
 * Simple RSI calculation from array of prices (returns single value)
 * @param {array} prices - Array of closing prices
 * @param {number} period - RSI period (default 14)
 * @returns {number} Current RSI value
 */
const calculateSimpleRSI = (prices, period = 14) => {
    if (prices.length < period + 1) return 50; // Neutral if not enough data
    
    let gains = 0;
    let losses = 0;
    
    // Initial average gain/loss
    for (let i = 1; i <= period; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    
    // Calculate for remaining data
    for (let i = period + 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    
    return avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
};

/**
 * Simple MACD calculation from array of prices (returns single object)
 * @param {array} prices - Array of closing prices  
 * @param {number} fastPeriod - Fast EMA period (default 12)
 * @param {number} slowPeriod - Slow EMA period (default 26)
 * @param {number} signalPeriod - Signal line period (default 9)
 * @returns {object} MACD values {macdLine, signalLine, histogram}
 */
const calculateSimpleMACD = (prices, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) => {
    if (prices.length < slowPeriod) {
        return { macdLine: 0, signalLine: 0, histogram: 0 };
    }
    
    // Calculate EMAs
    const fastEMA = calculateEMA(prices, fastPeriod);
    const slowEMA = calculateEMA(prices, slowPeriod);
    const macdLine = fastEMA - slowEMA;
    
    // Calculate signal line (EMA of MACD line)
    // For simplicity, use last signalPeriod MACD values
    const macdHistory = [];
    for (let i = slowPeriod; i < prices.length; i++) {
        const tempPrices = prices.slice(0, i + 1);
        const tempFast = calculateEMA(tempPrices, fastPeriod);
        const tempSlow = calculateEMA(tempPrices, slowPeriod);
        macdHistory.push(tempFast - tempSlow);
    }
    
    const signalLine = calculateEMA(macdHistory, signalPeriod);
    const histogram = macdLine - signalLine;
    
    return { macdLine, signalLine, histogram };
};

/**
 * Simple ATR calculation from arrays of highs, lows, closes
 * @param {array} highs - Array of high prices
 * @param {array} lows - Array of low prices
 * @param {array} closes - Array of closing prices
 * @param {number} period - ATR period (default 14)
 * @returns {number} Current ATR value
 */
const calculateSimpleATR = (highs, lows, closes, period = 14) => {
    if (closes.length < period + 1) return 0;
    
    const trueRanges = [];
    for (let i = 1; i < closes.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const prevClose = closes[i - 1];
        
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trueRanges.push(tr);
    }
    
    // Calculate ATR as simple moving average of true ranges
    const recentTR = trueRanges.slice(-period);
    return recentTR.reduce((sum, tr) => sum + tr, 0) / period;
};

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
const calculateMACD = (data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) => {
    const calculateEMA = (data, period) => {
        const multiplier = 2 / (period + 1);
        let ema = data[0].close;
        const result = [{ time: data[0].time, value: ema }];
        
        for (let i = 1; i < data.length; i++) {
            ema = (data[i].close - ema) * multiplier + ema;
            result.push({ time: data[i].time, value: ema });
        }
        return result;
    };
    
    const fastEMA = calculateEMA(data, fastPeriod);
    const slowEMA = calculateEMA(data, slowPeriod);
    
    const macdLine = fastEMA.map((fast, i) => ({
        time: fast.time,
        value: fast.value - slowEMA[i].value
    }));
    
    // Calculate signal line (EMA of MACD)
    const signalData = macdLine.map(m => ({ close: m.value, time: m.time }));
    const signalLine = calculateEMA(signalData, signalPeriod);
    
    // Calculate histogram
    const histogram = macdLine.map((macd, i) => ({
        time: macd.time,
        macd: macd.value,
        signal: signalLine[i].value,
        histogram: macd.value - signalLine[i].value
    }));
    
    return histogram;
};

/**
 * Detect Support and Resistance Levels
 */
const detectSupportResistance = (data, lookback = 50, touchThreshold = 0.01) => {
    if (data.length < lookback) return { support: [], resistance: [] };
    
    const recentData = data.slice(-lookback);
    const levels = [];
    
    // Find local highs and lows
    for (let i = 2; i < recentData.length - 2; i++) {
        const current = recentData[i];
        
        // Local high (resistance)
        if (current.high > recentData[i-1].high && 
            current.high > recentData[i-2].high &&
            current.high > recentData[i+1].high && 
            current.high > recentData[i+2].high) {
            levels.push({ price: current.high, type: 'resistance', touches: 1 });
        }
        
        // Local low (support)
        if (current.low < recentData[i-1].low && 
            current.low < recentData[i-2].low &&
            current.low < recentData[i+1].low && 
            current.low < recentData[i+2].low) {
            levels.push({ price: current.low, type: 'support', touches: 1 });
        }
    }
    
    // Cluster similar levels
    const clusteredLevels = [];
    levels.forEach(level => {
        const existing = clusteredLevels.find(l => 
            Math.abs(l.price - level.price) / level.price < touchThreshold &&
            l.type === level.type
        );
        
        if (existing) {
            existing.touches++;
            existing.price = (existing.price + level.price) / 2; // Average price
        } else {
            clusteredLevels.push({ ...level });
        }
    });
    
    // Sort by touches (most significant levels)
    const support = clusteredLevels.filter(l => l.type === 'support').sort((a, b) => b.touches - a.touches).slice(0, 3);
    const resistance = clusteredLevels.filter(l => l.type === 'resistance').sort((a, b) => b.touches - a.touches).slice(0, 3);
    
    return { support, resistance };
};

/**
 * Detect RSI Divergence
 */
const detectRSIDivergence = (data, rsi, lookback = 14) => {
    if (rsi.length < lookback) return [];
    
    const divergences = [];
    
    for (let i = lookback; i < rsi.length - 1; i++) {
        const priceSlice = data.slice(i - lookback, i);
        const rsiSlice = rsi.slice(i - lookback, i);
        
        // Find price highs and lows
        const priceHigh = Math.max(...priceSlice.map(d => d.high));
        const priceLow = Math.min(...priceSlice.map(d => d.low));
        const priceHighIdx = priceSlice.findIndex(d => d.high === priceHigh);
        const priceLowIdx = priceSlice.findIndex(d => d.low === priceLow);
        
        // Find RSI highs and lows
        const rsiHigh = Math.max(...rsiSlice.map(r => r.value));
        const rsiLow = Math.min(...rsiSlice.map(r => r.value));
        const rsiHighIdx = rsiSlice.findIndex(r => r.value === rsiHigh);
        const rsiLowIdx = rsiSlice.findIndex(r => r.value === rsiLow);
        
        // Bullish divergence: price makes lower low, RSI makes higher low
        if (priceLowIdx < lookback / 2 && data[i].low < priceLow && rsi[i].value > rsiLow) {
            divergences.push({
                time: data[i].time,
                type: 'bullish',
                strength: ((rsi[i].value - rsiLow) / rsiLow) * 100
            });
        }
        
        // Bearish divergence: price makes higher high, RSI makes lower high
        if (priceHighIdx < lookback / 2 && data[i].high > priceHigh && rsi[i].value < rsiHigh) {
            divergences.push({
                time: data[i].time,
                type: 'bearish',
                strength: ((rsiHigh - rsi[i].value) / rsiHigh) * 100
            });
        }
    }
    
    return divergences;
};

/**
 * Calculate Average Volume
 */
const calculateAverageVolume = (data, period = 20) => {
    if (data.length < period) return 0;
    
    const recentData = data.slice(-period);
    const totalVolume = recentData.reduce((sum, d) => sum + (d.volume || 0), 0);
    return totalVolume / period;
};

/**
 * Detect Volume Spikes
 */
const detectVolumeSpikes = (data, threshold = 1.5, period = 20) => {
    if (data.length < period) return [];
    
    const avgVolume = calculateAverageVolume(data, period);
    const spikes = [];
    
    for (let i = period; i < data.length; i++) {
        if (data[i].volume > avgVolume * threshold) {
            spikes.push({
                time: data[i].time,
                volume: data[i].volume,
                multiple: (data[i].volume / avgVolume).toFixed(2),
                avgVolume: avgVolume
            });
        }
    }
    
    return spikes;
};

/**
 * Detect Chart Patterns
 */
const detectPatterns = (data, lookback = 30) => {
    if (data.length < lookback) return [];
    
    const patterns = [];
    const recentData = data.slice(-lookback);
    
    // Double Top Detection
    const highs = recentData.map((d, i) => ({ price: d.high, index: i }))
        .filter((h, i, arr) => i > 0 && i < arr.length - 1 && 
                h.price > arr[i-1].price && h.price > arr[i+1].price)
        .sort((a, b) => b.price - a.price);
    
    if (highs.length >= 2) {
        const [high1, high2] = highs;
        if (Math.abs(high1.price - high2.price) / high1.price < 0.02 && 
            Math.abs(high1.index - high2.index) > 5) {
            patterns.push({
                type: 'Double Top',
                time: data[data.length - lookback + Math.max(high1.index, high2.index)].time,
                confidence: 75,
                bearish: true
            });
        }
    }
    
    // Double Bottom Detection
    const lows = recentData.map((d, i) => ({ price: d.low, index: i }))
        .filter((l, i, arr) => i > 0 && i < arr.length - 1 && 
                l.price < arr[i-1].price && l.price < arr[i+1].price)
        .sort((a, b) => a.price - b.price);
    
    if (lows.length >= 2) {
        const [low1, low2] = lows;
        if (Math.abs(low1.price - low2.price) / low1.price < 0.02 && 
            Math.abs(low1.index - low2.index) > 5) {
            patterns.push({
                type: 'Double Bottom',
                time: data[data.length - lookback + Math.max(low1.index, low2.index)].time,
                confidence: 75,
                bullish: true
            });
        }
    }
    
    // Head and Shoulders (simplified)
    if (highs.length >= 3) {
        const sorted = [...highs].sort((a, b) => a.index - b.index);
        if (sorted[1].price > sorted[0].price && sorted[1].price > sorted[2].price &&
            Math.abs(sorted[0].price - sorted[2].price) / sorted[0].price < 0.03) {
            patterns.push({
                type: 'Head and Shoulders',
                time: data[data.length - lookback + sorted[1].index].time,
                confidence: 80,
                bearish: true
            });
        }
    }
    
    return patterns;
};

/**
 * Calculate Stop Loss and Take Profit levels
 */
const calculateRiskReward = (entry, type, atr, rrRatio = 2) => {
    const stopDistance = atr * 2; // 2x ATR for stop loss
    const targetDistance = stopDistance * rrRatio;
    
    if (type === 'buy') {
        return {
            entry: entry,
            stopLoss: entry - stopDistance,
            takeProfit: entry + targetDistance,
            riskAmount: stopDistance,
            rewardAmount: targetDistance,
            ratio: rrRatio
        };
    } else {
        return {
            entry: entry,
            stopLoss: entry + stopDistance,
            takeProfit: entry - targetDistance,
            riskAmount: stopDistance,
            rewardAmount: targetDistance,
            ratio: rrRatio
        };
    }
};

/**
 * Calculate ATR (Average True Range)
 */
const calculateATR = (data, period = 14) => {
    if (data.length < period + 1) return [];
    
    const trueRanges = [];
    for (let i = 1; i < data.length; i++) {
        const high = data[i].high;
        const low = data[i].low;
        const prevClose = data[i - 1].close;
        
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trueRanges.push(tr);
    }
    
    const atr = [];
    let sum = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
    let avg = sum / period;
    atr.push({ time: data[period].time, value: avg });
    
    for (let i = period; i < trueRanges.length; i++) {
        avg = (avg * (period - 1) + trueRanges[i]) / period;
        atr.push({ time: data[i + 1].time, value: avg });
    }
    
    return atr;
};

/**
 * Interpret RSI signal for trading decisions
 * @param {number} rsi - RSI value (0-100)
 * @returns {object} Signal interpretation with score adjustment
 */
const interpretRSI = (rsi) => {
    if (rsi >= 70) {
        return {
            signal: 'OVERBOUGHT',
            description: 'RSI indicates overbought conditions - potential sell',
            scoreAdjustment: -15, // Negative for AI score
            recommendation: 'SELL'
        };
    } else if (rsi <= 30) {
        return {
            signal: 'OVERSOLD',
            description: 'RSI indicates oversold conditions - potential buy',
            scoreAdjustment: 15, // Positive for AI score
            recommendation: 'BUY'
        };
    } else if (rsi >= 60) {
        return {
            signal: 'BULLISH',
            description: 'RSI trending higher but not overbought',
            scoreAdjustment: 8,
            recommendation: 'BUY'
        };
    } else if (rsi <= 40) {
        return {
            signal: 'BEARISH',
            description: 'RSI trending lower but not oversold',
            scoreAdjustment: -8,
            recommendation: 'SELL'
        };
    } else {
        return {
            signal: 'NEUTRAL',
            description: 'RSI in neutral range',
            scoreAdjustment: 0,
            recommendation: 'HOLD'
        };
    }
};

/**
 * Interpret MACD signal for trading decisions
 * @param {object} macd - MACD object with macdLine, signalLine, histogram
 * @returns {object} Signal interpretation with score adjustment
 */
const interpretMACD = (macd) => {
    const { macdLine, signalLine, histogram } = macd;
    
    // Bullish crossover (MACD crosses above signal line)
    if (macdLine > signalLine && histogram > 0) {
        if (histogram > 0.5) {
            return {
                signal: 'STRONG_BULLISH',
                description: 'Strong bullish MACD crossover',
                scoreAdjustment: 10,
                recommendation: 'BUY'
            };
        }
        return {
            signal: 'BULLISH',
            description: 'Bullish MACD crossover',
            scoreAdjustment: 6,
            recommendation: 'BUY'
        };
    }
    
    // Bearish crossover (MACD crosses below signal line)
    if (macdLine < signalLine && histogram < 0) {
        if (histogram < -0.5) {
            return {
                signal: 'STRONG_BEARISH',
                description: 'Strong bearish MACD crossover',
                scoreAdjustment: -10,
                recommendation: 'SELL'
            };
        }
        return {
            signal: 'BEARISH',
            description: 'Bearish MACD crossover',
            scoreAdjustment: -6,
            recommendation: 'SELL'
        };
    }
    
    // Neutral
    return {
        signal: 'NEUTRAL',
        description: 'MACD showing no clear trend',
        scoreAdjustment: 0,
        recommendation: 'HOLD'
    };
};

/**
 * Calculate EMA (Exponential Moving Average)
 * @param {array} data - Array of price data
 * @param {number} period - EMA period
 * @returns {number} Current EMA value
 */
const calculateEMA = (data, period) => {
    if (data.length < period) return data[data.length - 1];
    
    const multiplier = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((sum, val) => sum + val, 0) / period;
    
    for (let i = period; i < data.length; i++) {
        ema = (data[i] - ema) * multiplier + ema;
    }
    
    return ema;
};

/**
 * Calculate Bollinger Bands from array of prices
 * @param {array} prices - Array of closing prices
 * @param {number} period - SMA period (default 20)
 * @param {number} multiplier - Std dev multiplier (default 2)
 * @returns {object} { upper, middle, lower, width, percentB }
 */
const calculateBollingerBands = (prices, period = 20, multiplier = 2) => {
    if (prices.length < period) {
        const last = prices[prices.length - 1] || 0;
        return { upper: last, middle: last, lower: last, width: 0, percentB: 0.5 };
    }

    const recentPrices = prices.slice(-period);
    const sma = recentPrices.reduce((a, b) => a + b, 0) / period;
    const variance = recentPrices.reduce((sum, p) => sum + Math.pow(p - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    const upper = sma + multiplier * stdDev;
    const lower = sma - multiplier * stdDev;
    const currentPrice = prices[prices.length - 1];
    const bandWidth = upper - lower;
    const percentB = bandWidth > 0 ? (currentPrice - lower) / bandWidth : 0.5;
    const width = sma > 0 ? bandWidth / sma : 0; // Normalized band width

    return { upper, middle: sma, lower, width, percentB, stdDev };
};

/**
 * Interpret Bollinger Bands for trading signal scoring
 * @param {object} bb - Bollinger bands object from calculateBollingerBands
 * @returns {object} { signal, scoreAdjustment, description }
 */
const interpretBollingerBands = (bb) => {
    const { percentB, width } = bb;

    // Squeeze (low width) = volatility contraction, breakout coming
    if (width < 0.05) {
        return { signal: 'SQUEEZE', scoreAdjustment: 3, description: 'Bollinger squeeze - breakout imminent' };
    }
    // Price near or below lower band = oversold / potential bounce
    if (percentB < 0.05) {
        return { signal: 'OVERSOLD', scoreAdjustment: 12, description: `Price at/below lower BB (percentB: ${percentB.toFixed(2)})` };
    }
    if (percentB < 0.20) {
        return { signal: 'NEAR_LOWER', scoreAdjustment: 7, description: `Price near lower BB (percentB: ${percentB.toFixed(2)})` };
    }
    // Price near or above upper band = overbought
    if (percentB > 0.95) {
        return { signal: 'OVERBOUGHT', scoreAdjustment: -10, description: `Price at/above upper BB (percentB: ${percentB.toFixed(2)})` };
    }
    if (percentB > 0.80) {
        return { signal: 'NEAR_UPPER', scoreAdjustment: -4, description: `Price near upper BB (percentB: ${percentB.toFixed(2)})` };
    }
    // Price in middle zone (40-60%) = neutral
    if (percentB >= 0.40 && percentB <= 0.60) {
        return { signal: 'NEUTRAL', scoreAdjustment: 0, description: 'Price in middle of Bollinger Bands' };
    }
    // Lower half but not extreme
    if (percentB < 0.40) {
        return { signal: 'MILD_OVERSOLD', scoreAdjustment: 3, description: `Price in lower half BB (percentB: ${percentB.toFixed(2)})` };
    }
    return { signal: 'MILD_OVERBOUGHT', scoreAdjustment: -2, description: `Price in upper half BB (percentB: ${percentB.toFixed(2)})` };
};

module.exports = {
    // Original functions (for chart data with time/close objects)
    calculateRSI,
    calculateMACD,
    calculateATR,

    // Simple functions (for price arrays)
    calculateSimpleRSI,
    calculateSimpleMACD,
    calculateSimpleATR,

    // Bollinger Bands
    calculateBollingerBands,
    interpretBollingerBands,

    // Interpretation and utility functions
    calculateEMA,
    interpretRSI,
    interpretMACD,

    // Pattern detection
    detectSupportResistance,
    detectRSIDivergence,
    calculateAverageVolume,
    detectVolumeSpikes,
    detectPatterns,
    calculateRiskReward
};
