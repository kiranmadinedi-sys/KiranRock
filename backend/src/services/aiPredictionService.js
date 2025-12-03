const axios = require('axios');
const stockDataService = require('./stockDataService');

/**
 * AI-based stock prediction service using free APIs with fallback.
 * Priority: 1. Hugging Face Inference API (Free)
 *           2. Local rule-based model (Fallback)
 */

// Configuration
const HUGGINGFACE_API_URL = 'https://api-inference.huggingface.co/models/';
const HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY || ''; // Optional: Set in environment variables

/**
 * Gets AI-based stock prediction with sentiment and technical analysis.
 * @param {string} symbol - Stock symbol
 * @param {object} newsData - Recent news for sentiment analysis
 * @returns {Promise<Object>} AI prediction with confidence and reasoning
 */
const getAIPrediction = async (symbol, newsData = null) => {
    try {
        console.log(`[AI Prediction] Generating prediction for ${symbol}...`);
        
        // Get historical data
        const stockData = await stockDataService.getStockData(symbol, '1d');
        if (stockData.length < 20) {
            return getFallbackPrediction(symbol, stockData);
        }

        // Try AI-based prediction first
        let aiPrediction = null;
        
        // Method 1: Try Hugging Face Inference API (Free, no key needed for some models)
        try {
            aiPrediction = await getHuggingFacePrediction(symbol, stockData, newsData);
            if (aiPrediction) {
                console.log('[AI Prediction] ✅ Using Hugging Face AI model');
                return aiPrediction;
            }
        } catch (error) {
            console.log('[AI Prediction] ⚠️ Hugging Face unavailable:', error.message);
        }

        // Fallback: Use enhanced rule-based model
        console.log('[AI Prediction] 📊 Using enhanced rule-based model (fallback)');
        return getFallbackPrediction(symbol, stockData, newsData);

    } catch (error) {
        console.error(`[AI Prediction] Error for ${symbol}:`, error.message);
        return getFallbackPrediction(symbol, [], newsData);
    }
};

/**
 * Uses Hugging Face Inference API for financial text analysis.
 * Model: ProsusAI/finbert (Financial Sentiment Analysis)
 */
const getHuggingFacePrediction = async (symbol, stockData, newsData) => {
    try {
        // Prepare input text from recent price action and news
        const recentData = stockData.slice(-10);
        const priceChange = ((recentData[recentData.length - 1].close - recentData[0].close) / recentData[0].close) * 100;
        
        let inputText = `Stock ${symbol} analysis: `;
        inputText += `Recent price change: ${priceChange.toFixed(2)}%. `;
        
        // Add volume trend
        const avgVolume = recentData.slice(0, 5).reduce((sum, d) => sum + d.volume, 0) / 5;
        const recentVolume = recentData.slice(-5).reduce((sum, d) => sum + d.volume, 0) / 5;
        const volumeChange = ((recentVolume - avgVolume) / avgVolume) * 100;
        inputText += `Volume trend: ${volumeChange > 0 ? 'increasing' : 'decreasing'} by ${Math.abs(volumeChange).toFixed(1)}%. `;
        
        // Add news sentiment if available
        if (newsData && newsData.sentiment) {
            inputText += `News sentiment: ${newsData.sentiment.label.toLowerCase()}. `;
        }
        
        // Add technical indicators
        const momentum = calculateMomentum(recentData);
        inputText += `Price momentum: ${momentum.trend}. `;

        // Call Hugging Face API
        const headers = HUGGINGFACE_API_KEY 
            ? { 'Authorization': `Bearer ${HUGGINGFACE_API_KEY}` }
            : {};

        const response = await axios.post(
            `${HUGGINGFACE_API_URL}ProsusAI/finbert`,
            { inputs: inputText },
            { headers, timeout: 5000 }
        );

        if (response.data && response.data[0]) {
            const sentiments = response.data[0];
            
            // Find highest confidence sentiment
            const topSentiment = sentiments.reduce((max, curr) => 
                curr.score > max.score ? curr : max
            );

            // Map sentiment to trading signal
            let signal = 'Hold';
            let confidence = (topSentiment.score * 100).toFixed(1);
            let reasoning = '';

            if (topSentiment.label === 'positive' && topSentiment.score > 0.7) {
                signal = 'Buy';
                reasoning = `AI model detected strong positive sentiment (${confidence}%) based on price momentum, volume trends, and market conditions. `;
            } else if (topSentiment.label === 'negative' && topSentiment.score > 0.7) {
                signal = 'Sell';
                reasoning = `AI model detected strong negative sentiment (${confidence}%) indicating potential downside risk. `;
            } else {
                signal = 'Hold';
                reasoning = `AI model suggests neutral stance (${confidence}%) - waiting for clearer signals. `;
            }

            // Add technical context
            if (priceChange > 5) reasoning += 'Strong upward price momentum supports bullish outlook.';
            else if (priceChange < -5) reasoning += 'Negative price action suggests caution.';

            return {
                signal,
                confidence,
                reasoning,
                modelUsed: 'FinBERT (Hugging Face)',
                priceChange: priceChange.toFixed(2),
                volumeTrend: volumeChange > 0 ? 'Increasing' : 'Decreasing',
                momentum: momentum.trend,
                timestamp: new Date().toISOString()
            };
        }

        return null;

    } catch (error) {
        console.log('[Hugging Face] Request failed:', error.message);
        return null;
    }
};

/**
 * Calculates price momentum and trend.
 */
const calculateMomentum = (data) => {
    if (data.length < 5) return { trend: 'Neutral', strength: 0 };

    const recentPrices = data.slice(-5).map(d => d.close);
    const increases = recentPrices.filter((price, i) => i > 0 && price > recentPrices[i - 1]).length;
    const strength = (increases / 4) * 100; // Percentage of positive days

    let trend = 'Neutral';
    if (strength >= 75) trend = 'Strong Uptrend';
    else if (strength >= 50) trend = 'Uptrend';
    else if (strength <= 25) trend = 'Downtrend';

    return { trend, strength: strength.toFixed(0) };
};

/**
 * Enhanced fallback prediction using technical analysis.
 */
const getFallbackPrediction = (symbol, stockData, newsData) => {
    if (stockData.length < 10) {
        return {
            signal: 'Hold',
            confidence: '30.0',
            reasoning: 'Insufficient data for reliable prediction. Waiting for more market activity.',
            modelUsed: 'Rule-Based Model (Fallback)',
            priceChange: 'N/A',
            volumeTrend: 'N/A',
            momentum: 'Unknown',
            timestamp: new Date().toISOString()
        };
    }

    // Calculate technical indicators
    const recentData = stockData.slice(-20);
    const priceChange = ((recentData[recentData.length - 1].close - recentData[0].close) / recentData[0].close) * 100;
    
    // Moving averages
    const sma5 = recentData.slice(-5).reduce((sum, d) => sum + d.close, 0) / 5;
    const sma10 = recentData.slice(-10).reduce((sum, d) => sum + d.close, 0) / 10;
    const sma20 = recentData.reduce((sum, d) => sum + d.close, 0) / 20;
    const currentPrice = recentData[recentData.length - 1].close;

    // Volume analysis
    const avgVolume = recentData.slice(0, 10).reduce((sum, d) => sum + d.volume, 0) / 10;
    const recentVolume = recentData.slice(-5).reduce((sum, d) => sum + d.volume, 0) / 5;
    const volumeChange = ((recentVolume - avgVolume) / avgVolume) * 100;

    // Momentum
    const momentum = calculateMomentum(recentData);

    // Decision logic
    let signal = 'Hold';
    let confidence = 50;
    let reasoning = '';

    // Bullish conditions
    const bullishSignals = [];
    if (sma5 > sma10 && sma10 > sma20) bullishSignals.push('moving averages aligned bullishly');
    if (currentPrice > sma5) bullishSignals.push('price above short-term MA');
    if (volumeChange > 20) bullishSignals.push('strong volume increase');
    if (priceChange > 3) bullishSignals.push('positive price momentum');
    if (momentum.strength >= 60) bullishSignals.push('strong upward momentum');

    // Bearish conditions
    const bearishSignals = [];
    if (sma5 < sma10 && sma10 < sma20) bearishSignals.push('moving averages aligned bearishly');
    if (currentPrice < sma5) bearishSignals.push('price below short-term MA');
    if (priceChange < -3) bearishSignals.push('negative price momentum');
    if (momentum.strength <= 40) bearishSignals.push('weak momentum');

    // Incorporate news sentiment
    if (newsData && newsData.sentiment) {
        const sentimentScore = parseFloat(newsData.sentiment.score);
        if (sentimentScore > 20) bullishSignals.push('positive news sentiment');
        else if (sentimentScore < -20) bearishSignals.push('negative news sentiment');
    }

    // Generate signal
    if (bullishSignals.length >= 3) {
        signal = 'Buy';
        confidence = Math.min(95, 50 + bullishSignals.length * 10);
        reasoning = `Strong buy indicators detected: ${bullishSignals.join(', ')}. `;
    } else if (bearishSignals.length >= 3) {
        signal = 'Sell';
        confidence = Math.min(95, 50 + bearishSignals.length * 10);
        reasoning = `Strong sell indicators detected: ${bearishSignals.join(', ')}. `;
    } else if (bullishSignals.length > bearishSignals.length) {
        signal = 'Buy';
        confidence = Math.min(75, 50 + (bullishSignals.length - bearishSignals.length) * 8);
        reasoning = `Moderate bullish signals: ${bullishSignals.join(', ')}. `;
    } else if (bearishSignals.length > bullishSignals.length) {
        signal = 'Sell';
        confidence = Math.min(75, 50 + (bearishSignals.length - bullishSignals.length) * 8);
        reasoning = `Moderate bearish signals: ${bearishSignals.join(', ')}. `;
    } else {
        reasoning = 'Mixed signals detected. Market conditions are neutral - recommend holding position. ';
    }

    return {
        signal,
        confidence: confidence.toFixed(1),
        reasoning,
        modelUsed: 'Enhanced Technical Analysis Model',
        priceChange: priceChange.toFixed(2),
        volumeTrend: volumeChange > 0 ? 'Increasing' : 'Decreasing',
        momentum: momentum.trend,
        technicalIndicators: {
            sma5: sma5.toFixed(2),
            sma10: sma10.toFixed(2),
            sma20: sma20.toFixed(2),
            bullishSignals: bullishSignals.length,
            bearishSignals: bearishSignals.length
        },
        timestamp: new Date().toISOString()
    };
};

module.exports = {
    getAIPrediction
};
