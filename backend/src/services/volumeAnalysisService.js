const stockDataService = require('./stockDataService');

/**
 * Analyzes volume trends and price-volume relationships.
 * @param {string} symbol - Stock symbol
 * @param {string} interval - Timeframe interval
 * @returns {Promise<Object>} Volume analysis data
 */
const analyzeVolume = async (symbol, interval = '1d') => {
    const data = await stockDataService.getStockData(symbol, interval);
    
    if (data.length < 20) {
        return { error: 'Insufficient data for volume analysis' };
    }

    // Calculate average volume
    const volumes = data.map(d => d.volume);
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    
    // Get recent volume (last 5 days average)
    const recentVolumes = volumes.slice(-5);
    const recentAvgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    
    // Volume trend
    const volumeChange = ((recentAvgVolume - avgVolume) / avgVolume) * 100;
    const volumeTrend = volumeChange > 10 ? 'Increasing' : volumeChange < -10 ? 'Decreasing' : 'Stable';
    
    // Price-Volume correlation
    const priceVolumeSignals = [];
    for (let i = 1; i < data.length; i++) {
        const priceChange = ((data[i].close - data[i - 1].close) / data[i - 1].close) * 100;
        const volumeRatio = data[i].volume / avgVolume;
        
        // Bullish: Price up + High volume
        if (priceChange > 1 && volumeRatio > 1.5) {
            priceVolumeSignals.push({
                time: data[i].time,
                type: 'Bullish Breakout',
                strength: 'Strong',
                price: data[i].close,
                volume: data[i].volume
            });
        }
        // Bearish: Price down + High volume
        else if (priceChange < -1 && volumeRatio > 1.5) {
            priceVolumeSignals.push({
                time: data[i].time,
                type: 'Bearish Breakdown',
                strength: 'Strong',
                price: data[i].close,
                volume: data[i].volume
            });
        }
        // Weak rally: Price up + Low volume
        else if (priceChange > 2 && volumeRatio < 0.7) {
            priceVolumeSignals.push({
                time: data[i].time,
                type: 'Weak Rally',
                strength: 'Weak',
                price: data[i].close,
                volume: data[i].volume
            });
        }
    }

    // Current volume status
    const latestVolume = data[data.length - 1].volume;
    const volumeStatus = latestVolume > avgVolume * 1.5 ? 'High' : 
                        latestVolume < avgVolume * 0.5 ? 'Low' : 'Normal';

    return {
        currentVolume: latestVolume,
        averageVolume: Math.round(avgVolume),
        recentAverageVolume: Math.round(recentAvgVolume),
        volumeChange: volumeChange.toFixed(2),
        volumeTrend,
        volumeStatus,
        signals: priceVolumeSignals.slice(-10), // Last 10 signals
        interpretation: interpretVolumeAnalysis(volumeTrend, volumeStatus, priceVolumeSignals)
    };
};

/**
 * Interprets volume analysis results.
 */
const interpretVolumeAnalysis = (trend, status, signals) => {
    const recentBullish = signals.filter(s => s.type === 'Bullish Breakout').length;
    const recentBearish = signals.filter(s => s.type === 'Bearish Breakdown').length;
    
    if (status === 'High' && trend === 'Increasing' && recentBullish > recentBearish) {
        return {
            sentiment: 'Bullish',
            confidence: 'High',
            description: 'Strong buying pressure with increasing volume confirms uptrend.'
        };
    } else if (status === 'High' && trend === 'Increasing' && recentBearish > recentBullish) {
        return {
            sentiment: 'Bearish',
            confidence: 'High',
            description: 'Heavy selling pressure with high volume suggests downtrend continuation.'
        };
    } else if (status === 'Low' && trend === 'Decreasing') {
        return {
            sentiment: 'Neutral',
            confidence: 'Low',
            description: 'Low volume indicates lack of conviction. Wait for volume confirmation.'
        };
    } else {
        return {
            sentiment: 'Neutral',
            confidence: 'Medium',
            description: 'Mixed volume signals. Monitor for clearer trend confirmation.'
        };
    }
};

module.exports = {
    analyzeVolume
};
