const stockDataService = require('./stockDataService');
const cacheService = require('./cacheService');

/**
 * Calculates the Exponential Moving Average (EMA) for a given period.
 * @param {Array<Object>} data The stock data points (must have a 'close' property).
 * @param {number} period The number of data points to include in the EMA.
 * @returns {Array<Object>} An array of objects with 'time' and 'value' properties.
 */
const calculateEMA = (data, period) => {
    const ema = [];
    if (data.length < period) {
        return ema;
    }
    const multiplier = 2 / (period + 1);

    // Calculate the initial SMA for the first EMA value
    const initialWindow = data.slice(0, period);
    const initialSum = initialWindow.reduce((acc, val) => acc + val.close, 0);
    let prevEma = initialSum / period;
    ema.push({ time: data[period - 1].time, value: prevEma });

    // Calculate subsequent EMA values
    for (let i = period; i < data.length; i++) {
        const currentClose = data[i].close;
        const currentEma = (currentClose - prevEma) * multiplier + prevEma;
        ema.push({ time: data[i].time, value: currentEma });
        prevEma = currentEma;
    }
    return ema;
};


/**
 * Generates historical trading signals based on EMA crossover.
 * @param {string} symbol The stock symbol.
 * @param {number} shortPeriod The short-term EMA period (default: 5).
 * @param {number} longPeriod The long-term EMA period (default: 15).
 * @param {string} interval The timeframe interval: '1d', '1wk', or '1mo' (default: '1d').
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of signal objects.
 */
const getHistoricalSignals = async (symbol, shortPeriod = 5, longPeriod = 15, interval = '1d') => {
    // Check cache first
    const cacheKey = `signals:${symbol}:${shortPeriod}:${longPeriod}:${interval}`;
    const cached = cacheService.get(cacheKey);
    
    if (cached) {
        console.log(`[Signal Service] Using cached signals for ${symbol}`);
        return cached;
    }

    const data = await stockDataService.getStockData(symbol, interval);
    if (data.length < longPeriod) {
        console.log(`[Signal Service] Not enough data for ${symbol}: ${data.length} points (need ${longPeriod})`);
        return [];
    }

    // Fetch VIX data
    const vixQuote = await stockDataService.getCurrentPrice('^VIX');
    const vix = typeof vixQuote === 'number' ? vixQuote : null;

    const emaShort = calculateEMA(data, shortPeriod);
    const emaLong = calculateEMA(data, longPeriod);

    const signals = [];
    // Start comparing from the point where both EMAs are available.
    // The emaLong array is shorter, so we align with it.
    const emaShortOffset = emaShort.length - emaLong.length;

    // Generate signals based on crossovers
    for (let i = 1; i < emaLong.length; i++) {
        const prevEmaShort = emaShort[i + emaShortOffset - 1].value;
        const prevEmaLong = emaLong[i - 1].value;
        const currentEmaShort = emaShort[i + emaShortOffset].value;
        const currentEmaLong = emaLong[i].value;

        const dataIndex = data.length - emaLong.length + i;

        // Buy signal: short-term EMA crosses above long-term EMA
        if (prevEmaShort <= prevEmaLong && currentEmaShort > currentEmaLong) {
            // Calculate signal strength based on crossover magnitude
            const crossoverStrength = ((currentEmaShort - currentEmaLong) / currentEmaLong) * 100;
            let confidence = Math.min(100, Math.max(0, crossoverStrength * 10 + 50));
            // VIX impact: if VIX is high (>20), reduce buy confidence
            if (vix !== null && vix > 20) confidence -= 20;
            signals.push({
                time: data[dataIndex].time,
                position: 'belowBar',
                color: '#00c805', // Robinhood green
                shape: 'arrowUp',
                text: 'Buy @ ' + data[dataIndex].close.toFixed(2) + (vix !== null ? ` (VIX ${vix})` : ''),
                strength: crossoverStrength,
                confidence: confidence.toFixed(1),
                vix
            });
        }
        // Sell signal: short-term EMA crosses below long-term EMA
        else if (prevEmaShort >= prevEmaLong && currentEmaShort < currentEmaLong) {
            // Calculate signal strength based on crossover magnitude
            const crossoverStrength = ((currentEmaLong - currentEmaShort) / currentEmaShort) * 100;
            let confidence = Math.min(100, Math.max(0, crossoverStrength * 10 + 50));
            // VIX impact: if VIX is high (>25), increase sell confidence
            if (vix !== null && vix > 25) confidence += 20;
            signals.push({
                time: data[dataIndex].time,
                position: 'aboveBar',
                color: '#ff5000', // Robinhood red
                shape: 'arrowDown',
                text: 'Sell @ ' + data[dataIndex].close.toFixed(2) + (vix !== null ? ` (VIX ${vix})` : ''),
                strength: crossoverStrength,
                confidence: confidence.toFixed(1),
                vix
            });
        }
    }
    
    console.log(`[Signal Service] Generated ${signals.length} signals for ${symbol} using EMA ${shortPeriod}/${longPeriod} on ${interval} timeframe`);
    if (signals.length > 0) {
        console.log(`[Signal Service] Most recent signal: ${signals[signals.length - 1].text} at ${new Date(signals[signals.length - 1].time * 1000).toISOString()}`);
    }
    
    // Cache the signals for 5 minutes
    cacheService.set(cacheKey, signals, 5 * 60 * 1000);
    
    return signals;
};

/**
 * Gets the most recent trading signal.
 * @param {string} symbol The stock symbol.
 * @returns {Promise<string>} A promise that resolves to 'Buy', 'Sell', or 'Hold'.
 */
const getSignal = async (symbol) => {
    const signals = await getHistoricalSignals(symbol);
    if (signals.length > 0) {
        const lastSignal = signals[signals.length - 1];
        // VIX impact: if VIX is high (>25), prefer Sell/Hold
        if (lastSignal.vix !== undefined && lastSignal.vix > 25) {
            return lastSignal.shape === 'arrowDown' ? 'Sell' : 'Hold';
        }
        // Determine signal type based on the shape or text
        if (lastSignal.shape === 'arrowUp' || lastSignal.text.startsWith('Buy')) {
            return 'Buy';
        } else if (lastSignal.shape === 'arrowDown' || lastSignal.text.startsWith('Sell')) {
            return 'Sell';
        }
    }

    // Fallback logic if no crossover signals are found
    const data = await stockDataService.getStockData(symbol);
    const vix = await stockDataService.getCurrentPrice('^VIX');
    if (data.length < 2) {
        return 'Hold';
    }
    const latest = data[data.length - 1];
    const previous = data[data.length - 2];
    const priceChangePercent = ((latest.close - previous.close) / previous.close) * 100;

    if (vix !== null && vix > 25) return 'Sell';
    if (priceChangePercent > 1) return 'Buy';
    if (priceChangePercent < -1) return 'Sell';
    return 'Hold';
};

module.exports = { getSignal, getHistoricalSignals };
