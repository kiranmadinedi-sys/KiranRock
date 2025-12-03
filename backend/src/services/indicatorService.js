const { getStockData } = require('./stockDataService');

const getUnixTimestamp = (date) => {
    if (!date) return null; // Return null if date is invalid
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return null; // Return null if date is invalid
    return Math.floor(d.getTime() / 1000);
};

/**
 * Calculates the Exponential Moving Average (EMA) for a given dataset.
 * @param {Array} data - Array of historical quote data.
 * @param {number} period - The EMA period.
 * @returns {Array} - An array of { time, value } objects for the EMA line.
 */
const calculateHistoricalEMA = (data, period) => {
    if (!data || data.length < period) {
        return [];
    }

    const emaValues = [];
    const multiplier = 2 / (period + 1);
    
    // Calculate initial SMA
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += data[i].close;
    }
    let prevEma = sum / period;

    // The first EMA value corresponds to the 'period'-th data point
    emaValues.push({ time: data[period - 1].time, value: prevEma });

    // Calculate subsequent EMAs
    for (let i = period; i < data.length; i++) {
        const currentEma = (data[i].close - prevEma) * multiplier + prevEma;
        emaValues.push({ time: data[i].time, value: currentEma });
        prevEma = currentEma;
    }

    return emaValues;
};

/**
 * Calculates historical Bollinger Bands.
 * @param {Array} data - Array of historical quote data.
 * @param {number} period - The period for the moving average (default 20).
 * @param {number} stdDev - The number of standard deviations (default 2).
 * @returns {Object} - An object containing arrays for upper, middle, and lower bands.
 */
const calculateHistoricalBollingerBands = (data, period = 20, stdDev = 2) => {
    if (!data || data.length < period) {
        return { upper: [], middle: [], lower: [] };
    }

    const upper = [];
    const middle = [];
    const lower = [];

    for (let i = period - 1; i < data.length; i++) {
        const slice = data.slice(i - period + 1, i + 1);
        const prices = slice.map(d => d.close);
        
        const mean = prices.reduce((acc, val) => acc + val, 0) / period;
        
        const standardDeviation = Math.sqrt(
            prices.map(p => Math.pow(p - mean, 2)).reduce((acc, val) => acc + val, 0) / period
        );

        const upperBand = mean + (stdDev * standardDeviation);
        const lowerBand = mean - (stdDev * standardDeviation);

        const timestamp = data[i].time;
        middle.push({ time: timestamp, value: mean });
        upper.push({ time: timestamp, value: upperBand });
        lower.push({ time: timestamp, value: lowerBand });
    }

    return { upper, middle, lower };
};

/**
 * Calculates the Relative Strength Index (RSI).
 * @param {Array} data - Array of historical quote data.
 * @param {number} period - The RSI period (default 14).
 * @returns {Array} - An array of { time, value } objects for the RSI line.
 */
const calculateRSI = (data, period = 14) => {
    if (!data || data.length < period + 1) {
        return [];
    }

    const rsiValues = [];
    let gains = 0;
    let losses = 0;

    // Calculate initial average gain and loss
    for (let i = 1; i <= period; i++) {
        const change = data[i].close - data[i - 1].close;
        if (change > 0) {
            gains += change;
        } else {
            losses += Math.abs(change);
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;
    let rs = avgGain / avgLoss;
    let rsi = 100 - (100 / (1 + rs));

    rsiValues.push({ time: data[period].time, value: rsi });

    // Calculate subsequent RSI values using smoothed moving average
    for (let i = period + 1; i < data.length; i++) {
        const change = data[i].close - data[i - 1].close;
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        rs = avgGain / avgLoss;
        rsi = 100 - (100 / (1 + rs));

        rsiValues.push({ time: data[i].time, value: rsi });
    }

    return rsiValues;
};

/**
 * Calculates the Moving Average Convergence Divergence (MACD).
 * @param {Array} data - Array of historical quote data.
 * @param {number} fastPeriod - Fast EMA period (default 12).
 * @param {number} slowPeriod - Slow EMA period (default 26).
 * @param {number} signalPeriod - Signal line period (default 9).
 * @returns {Object} - An object containing macd, signal, and histogram arrays.
 */
const calculateMACD = (data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) => {
    if (!data || data.length < slowPeriod + signalPeriod) {
        return { macd: [], signal: [], histogram: [] };
    }

    // Calculate fast and slow EMAs
    const fastEMA = calculateEMA(data, fastPeriod);
    const slowEMA = calculateEMA(data, slowPeriod);

    // Calculate MACD line (fast - slow)
    const macdLine = [];
    const startIndex = slowPeriod - fastPeriod;
    
    for (let i = 0; i < slowEMA.length; i++) {
        const macdValue = fastEMA[i + startIndex].value - slowEMA[i].value;
        macdLine.push({
            time: slowEMA[i].time,
            value: macdValue
        });
    }

    // Calculate signal line (EMA of MACD)
    const signalLine = calculateEMAFromValues(macdLine, signalPeriod);

    // Calculate histogram (MACD - Signal)
    const histogram = [];
    for (let i = 0; i < signalLine.length; i++) {
        const histValue = macdLine[i + (macdLine.length - signalLine.length)].value - signalLine[i].value;
        histogram.push({
            time: signalLine[i].time,
            value: histValue,
            color: histValue >= 0 ? '#00c805' : '#ff5000'
        });
    }

    return {
        macd: macdLine,
        signal: signalLine,
        histogram: histogram
    };
};

/**
 * Helper function to calculate EMA from data array.
 */
const calculateEMA = (data, period) => {
    if (!data || data.length < period) {
        return [];
    }

    const emaValues = [];
    const multiplier = 2 / (period + 1);
    
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += data[i].close;
    }
    let prevEma = sum / period;
    emaValues.push({ time: data[period - 1].time, value: prevEma });

    for (let i = period; i < data.length; i++) {
        const currentEma = (data[i].close - prevEma) * multiplier + prevEma;
        emaValues.push({ time: data[i].time, value: currentEma });
        prevEma = currentEma;
    }

    return emaValues;
};

/**
 * Helper function to calculate EMA from pre-calculated values.
 */
const calculateEMAFromValues = (values, period) => {
    if (!values || values.length < period) {
        return [];
    }

    const emaValues = [];
    const multiplier = 2 / (period + 1);
    
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += values[i].value;
    }
    let prevEma = sum / period;
    emaValues.push({ time: values[period - 1].time, value: prevEma });

    for (let i = period; i < values.length; i++) {
        const currentEma = (values[i].value - prevEma) * multiplier + prevEma;
        emaValues.push({ time: values[i].time, value: currentEma });
        prevEma = currentEma;
    }

    return emaValues;
};


module.exports = {
    calculateHistoricalEMA,
    calculateHistoricalBollingerBands,
    calculateRSI,
    calculateMACD,
};
