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

module.exports = {
    calculateRSI,
    calculateMACD,
    detectSupportResistance,
    detectRSIDivergence,
    calculateAverageVolume,
    detectVolumeSpikes,
    detectPatterns,
    calculateRiskReward,
    calculateATR
};
