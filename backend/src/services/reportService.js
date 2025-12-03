const YahooFinance = require('yahoo-finance2').default;
const axios = require('axios');
const cheerio = require('cheerio');
const yahooFinance = new YahooFinance();

/**
 * Calculates the Relative Strength Index (RSI).
 */
const calculateRSI = (data, period = 14) => {
    let gains = 0;
    let losses = 0;

    // Calculate initial average gains and losses
    for (let i = 1; i <= period; i++) {
        const change = data[i].close - data[i - 1].close;
        if (change > 0) {
            gains += change;
        } else {
            losses -= change;
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    const rsi = [100 - 100 / (1 + avgGain / avgLoss)];

    // Calculate subsequent RSI values
    for (let i = period + 1; i < data.length; i++) {
        const change = data[i].close - data[i - 1].close;
        let gain = change > 0 ? change : 0;
        let loss = change < 0 ? -change : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        if (avgLoss === 0) {
            rsi.push(100);
        } else {
            const rs = avgGain / avgLoss;
            rsi.push(100 - 100 / (1 + rs));
        }
    }
    return rsi[rsi.length - 1]; // Return the latest RSI value
};

/**
 * Calculates the Moving Average Convergence Divergence (MACD).
 */
const calculateMACD = (data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) => {
    const calculateEMA = (d, p) => {
        const ema = [];
        const multiplier = 2 / (p + 1);
        let prevEma = d.slice(0, p).reduce((acc, val) => acc + val.close, 0) / p;
        ema.push(prevEma);
        for (let i = p; i < d.length; i++) {
            const currentEma = (d[i].close - prevEma) * multiplier + prevEma;
            ema.push(currentEma);
            prevEma = currentEma;
        }
        return ema;
    };

    const emaFast = calculateEMA(data, fastPeriod);
    const emaSlow = calculateEMA(data, slowPeriod);
    
    const macdLine = emaFast.slice(slowPeriod - fastPeriod).map((val, i) => val - emaSlow[i]);
    const signalLine = calculateEMA(macdLine.map(v => ({close: v})), signalPeriod);
    const histogram = macdLine.slice(signalPeriod - 1).map((val, i) => val - signalLine[i]);

    return {
        macd: macdLine[macdLine.length - 1],
        signal: signalLine[signalLine.length - 1],
        histogram: histogram[histogram.length - 1],
    };
};

/**
 * Calculates Bollinger Bands.
 * @param {Array} data - Array of historical quote data.
 * @param {number} period - The period for the moving average (default 20).
 * @param {number} stdDev - The number of standard deviations (default 2).
 */
const calculateBollingerBands = (data, period = 20, stdDev = 2) => {
    if (data.length < period) return null;

    const sma = (arr) => arr.reduce((acc, val) => acc + val, 0) / arr.length;
    const standardDeviation = (arr, mean) => {
        const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / arr.length;
        return Math.sqrt(variance);
    };

    // We only need to calculate for the most recent period to get the latest bands
    const latestDataSlice = data.slice(-period);
    const prices = latestDataSlice.map(d => d.close);
    
    const middleBand = sma(prices);
    const std = standardDeviation(prices, middleBand);
    
    const upperBand = middleBand + (stdDev * std);
    const lowerBand = middleBand - (stdDev * std);

    const latestClose = prices[prices.length - 1];
    let signal = 'Neutral';
    if (latestClose > upperBand) {
        signal = 'Sell (Overbought)';
    } else if (latestClose < lowerBand) {
        signal = 'Buy (Oversold)';
    }

    return {
        upper: upperBand.toFixed(2),
        middle: middleBand.toFixed(2),
        lower: lowerBand.toFixed(2),
        signal: signal
    };
};


/**
 * Calculates the Stochastic Oscillator.
 * @param {Array} data - Array of historical quote data.
 * @param {number} period - The lookback period (default 14).
 */
const calculateStochastic = (data, period = 14) => {
    if (data.length < period) return null;

    const latestDataSlice = data.slice(-period);
    const latestClose = latestDataSlice[latestDataSlice.length - 1].close;
    
    let lowestLow = latestDataSlice[0].low;
    let highestHigh = latestDataSlice[0].high;

    for (let i = 1; i < latestDataSlice.length; i++) {
        if (latestDataSlice[i].low < lowestLow) {
            lowestLow = latestDataSlice[i].low;
        }
        if (latestDataSlice[i].high > highestHigh) {
            highestHigh = latestDataSlice[i].high;
        }
    }

    const k = 100 * ((latestClose - lowestLow) / (highestHigh - lowestLow));

    let signal = 'Neutral';
    if (k > 80) {
        signal = 'Sell (Overbought)';
    } else if (k < 20) {
        signal = 'Buy (Oversold)';
    }

    return {
        k: k.toFixed(2),
        signal: signal
    };
};


/**
 * Calculates the Volume Weighted Average Price (VWAP) for the latest day.
 * @param {Array} data - Array of historical quote data.
 */
const calculateVWAP = (data) => {
    if (data.length === 0) return null;

    const latestDay = new Date(data[data.length - 1].date).setHours(0, 0, 0, 0);
    
    const dayData = data.filter(d => new Date(d.date).setHours(0, 0, 0, 0) === latestDay);

    if (dayData.length === 0) return null;

    let cumulativeTPV = 0; // Cumulative Typical Price * Volume
    let cumulativeVolume = 0;

    dayData.forEach(d => {
        const typicalPrice = (d.high + d.low + d.close) / 3;
        cumulativeTPV += typicalPrice * d.volume;
        cumulativeVolume += d.volume;
    });

    const vwap = cumulativeTPV / cumulativeVolume;
    const latestClose = dayData[dayData.length - 1].close;

    let signal = 'Neutral';
    if (latestClose > vwap) {
        signal = 'Buy (Above VWAP)';
    } else if (latestClose < vwap) {
        signal = 'Sell (Below VWAP)';
    }

    return {
        vwap: vwap.toFixed(2),
        signal: signal
    };
};


const generateReport = async (symbol, transcriptUrl) => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 6);

    const queryOptions = { period1: startDate, period2: endDate, interval: '1d' };
    const data = await yahooFinance.chart(symbol, queryOptions);

    if (!data || !data.quotes || data.quotes.length < 30) {
        return {
            summary: "Not enough data to generate a report.",
            confidence: "N/A",
            trends: [],
            supportResistance: {},
            signals: {}
        };
    }
    const quotes = data.quotes;
    const latestPrice = quotes[quotes.length - 1].close;
    const priceChange6m = ((latestPrice - quotes[0].close) / quotes[0].close) * 100;
    const volumeTrend = quotes.slice(-30).reduce((acc, val) => acc + val.volume, 0) / 30;
    const avgVolume6m = quotes.reduce((acc, val) => acc + val.volume, 0) / quotes.length;

    let transcriptAnalysis = {
        positive: [],
        negative: []
    };

    if (transcriptUrl) {
        try {
            const { data: html } = await axios.get(transcriptUrl);
            const $ = cheerio.load(html);
            const transcriptText = $('body').text(); // Simple text extraction

            // Basic sentiment analysis
            const sentences = transcriptText.split(/[.!?]/);
            const positiveKeywords = ['strong', 'growth', 'beat', 'exceeded', 'optimistic', 'upward', 'record'];
            const negativeKeywords = ['weak', 'decline', 'missed', 'disappointing', 'cautious', 'downward', 'challenging'];

            sentences.forEach(sentence => {
                const lowerCaseSentence = sentence.toLowerCase();
                if (positiveKeywords.some(keyword => lowerCaseSentence.includes(keyword))) {
                    transcriptAnalysis.positive.push(sentence.trim());
                }
                if (negativeKeywords.some(keyword => lowerCaseSentence.includes(keyword))) {
                    transcriptAnalysis.negative.push(sentence.trim());
                }
            });

        } catch (error) {
            console.error('Failed to fetch or parse transcript:', error);
            // Decide how to handle error: maybe add a note to the report
            transcriptAnalysis.error = "Could not analyze transcript URL.";
        }
    }

    // Support and Resistance
    const prices = quotes.map(d => d.close);
    const support = Math.min(...prices);
    const resistance = Math.max(...prices.slice(-30));

    const rsi = calculateRSI(quotes);
    const macd = calculateMACD(quotes);
    const bollingerBands = calculateBollingerBands(quotes);
    const stochastic = calculateStochastic(quotes);
    const vwap = calculateVWAP(quotes);

    const getRsiSignal = (rsiValue) => {
        if (rsiValue > 70) return 'Sell';
        if (rsiValue < 30) return 'Buy';
        return 'Neutral';
    };

    const getMacdSignal = (macdValue, signalValue) => {
        if (macdValue > signalValue) return 'Buy';
        if (macdValue < signalValue) return 'Sell';
        return 'Neutral';
    };

    const summary = `Based on the last 6 months, ${symbol} has shown a price change of ${priceChange6m.toFixed(2)}%. The recent trading volume is ${volumeTrend > avgVolume6m ? 'above' : 'below'} the 6-month average.`;
    const confidence = `The analysis is based on standard technical indicators (RSI, MACD) and recent price/volume trends.`;

    return {
        summary,
        confidence,
        trends: [
            { 
                name: '6-Month Price Change', 
                value: `${priceChange6m.toFixed(2)}%`, 
                insight: priceChange6m > 0 ? 'Positive' : 'Negative' 
            },
            { 
                name: 'Recent Volume Trend', 
                value: `${((volumeTrend / avgVolume6m - 1) * 100).toFixed(2)}% vs average`, 
                insight: volumeTrend > avgVolume6m ? 'Increasing' : 'Decreasing' 
            },
        ],
        supportResistance: {
            support: support.toFixed(2),
            resistance: resistance.toFixed(2),
        },
        signals: [
            { indicator: 'RSI', value: rsi.toFixed(2), signal: getRsiSignal(rsi) },
            { indicator: 'MACD', value: macd.macd.toFixed(2), signal: getMacdSignal(macd.macd, macd.signal) },
            { indicator: 'MACD Histogram', value: macd.histogram.toFixed(2), signal: macd.histogram > 0 ? 'Buy' : 'Sell' },
            ...(bollingerBands ? [{ indicator: 'Bollinger Bands', value: `L:${bollingerBands.lower} M:${bollingerBands.middle} U:${bollingerBands.upper}`, signal: bollingerBands.signal }] : []),
            ...(stochastic ? [{ indicator: 'Stochastic', value: `${stochastic.k}%`, signal: stochastic.signal }] : []),
            ...(vwap ? [{ indicator: 'VWAP', value: vwap.vwap, signal: vwap.signal }] : [])
        ],
        transcriptAnalysis,
    };
};

module.exports = {
    generateReport,
};