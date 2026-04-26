const axios = require('axios');
const stockDataService = require('./stockDataService');
const { logger } = require('../utils/logger');

/**
 * Multi-Model AI Prediction Service
 * Implements ensemble of AI models for robust predictions:
 * 1. FinBERT (Hugging Face) - Financial sentiment
 * 2. DistilBERT (Hugging Face) - General sentiment
 * 3. Technical Pattern Recognition - Chart patterns
 * 4. Agentic Decision System - Multi-agent consensus
 * 5. Ensemble Voting - Combined decision
 */

// Model Configuration
const MODELS = {
    FINBERT: {
        url: 'https://api-inference.huggingface.co/models/ProsusAI/finbert',
        name: 'FinBERT',
        weight: 0.35,
        type: 'sentiment'
    },
    DISTILBERT: {
        url: 'https://api-inference.huggingface.co/models/distilbert-base-uncased-finetuned-sst-2-english',
        name: 'DistilBERT',
        weight: 0.20,
        type: 'sentiment'
    },
    TECHNICAL_AGENT: {
        name: 'Technical Agent',
        weight: 0.25,
        type: 'technical'
    },
    MOMENTUM_AGENT: {
        name: 'Momentum Agent',
        weight: 0.20,
        type: 'momentum'
    }
};

// Per-model timeout (axios) + master ensemble timeout to prevent 20s waits
const API_TIMEOUT = 5000;          // 5s per external model call
const ENSEMBLE_TIMEOUT = 7000;     // 7s hard cap for the whole ensemble
const PROVIDER_429_THRESHOLD = Number(process.env.AI_PROVIDER_429_THRESHOLD || 3);
const PROVIDER_COOLDOWN_MS = Number(process.env.AI_PROVIDER_COOLDOWN_MS || 10 * 60 * 1000);
const PROVIDER_LOG_THROTTLE_MS = Number(process.env.AI_PROVIDER_LOG_THROTTLE_MS || 60 * 1000);

const providerState = {
    FINBERT: {
        consecutive429: 0,
        cooldownUntil: 0,
        lastSkipLogAt: 0,
        lastErrorLogAt: 0
    },
    DISTILBERT: {
        consecutive429: 0,
        cooldownUntil: 0,
        lastSkipLogAt: 0,
        lastErrorLogAt: 0
    }
};

function is429Error(error) {
    const status = error?.response?.status;
    if (status === 429) {
        return true;
    }

    const message = String(error?.message || '').toLowerCase();
    return message.includes('429') || message.includes('too many requests');
}

function shouldUseProvider(providerKey) {
    const state = providerState[providerKey];
    const now = Date.now();

    if (state.cooldownUntil > now) {
        if (now - state.lastSkipLogAt > PROVIDER_LOG_THROTTLE_MS) {
            const waitSec = Math.ceil((state.cooldownUntil - now) / 1000);
            logger.info(`[Multi-Model AI] ${providerKey} cooling down after 429 burst`, {
                provider: providerKey,
                waitSeconds: waitSec
            });
            state.lastSkipLogAt = now;
        }
        return false;
    }

    return true;
}

function markProviderSuccess(providerKey) {
    const state = providerState[providerKey];
    state.consecutive429 = 0;
}

function markProvider429(providerKey) {
    const state = providerState[providerKey];
    state.consecutive429 += 1;

    if (state.consecutive429 >= PROVIDER_429_THRESHOLD) {
        state.cooldownUntil = Date.now() + PROVIDER_COOLDOWN_MS;
        state.consecutive429 = 0;

        logger.warn(`[Multi-Model AI] ${providerKey} entered cooldown due to repeated 429`, {
            provider: providerKey,
            cooldownMs: PROVIDER_COOLDOWN_MS,
            threshold: PROVIDER_429_THRESHOLD
        });
    }
}

function markProviderNon429Error(providerKey, error) {
    const state = providerState[providerKey];
    const now = Date.now();

    if (now - state.lastErrorLogAt > PROVIDER_LOG_THROTTLE_MS) {
        logger.warn(`[Multi-Model AI] ${providerKey} unavailable`, { error: error.message });
        state.lastErrorLogAt = now;
    }
}

/**
 * Race a promise against a timeout, resolving to null on timeout
 */
function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise(resolve => setTimeout(() => resolve(null), ms))
    ]);
}

/**
 * Main multi-model prediction function
 * Combines multiple AI models for robust predictions.
 * A single 7-second master timeout guards the entire ensemble so that
 * slow/hanging external models can't block the caller indefinitely.
 */
const getMultiModelPrediction = async (symbol, newsData = null) => {
    try {
        logger.info('[Multi-Model AI] Starting ensemble prediction', { symbol });

        // Get historical data
        const stockData = await stockDataService.getStockData(symbol, '1d');
        if (stockData.length < 20) {
            return getAgenticFallback(symbol, stockData);
        }

        // Run all four models in parallel, each with its own timeout via axios,
        // and the whole block additionally guarded by a single master timeout.
        const ensembleWork = async () => {
            const [
                finbertResult,
                distilbertResult,
                technicalAgentResult,
                momentumAgentResult
            ] = await Promise.allSettled([
                callFinBERT(symbol, stockData, newsData),
                callDistilBERT(symbol, stockData, newsData),
                runTechnicalAgent(symbol, stockData),
                runMomentumAgent(symbol, stockData)
            ]);
            return { finbertResult, distilbertResult, technicalAgentResult, momentumAgentResult };
        };

        const results = await withTimeout(ensembleWork(), ENSEMBLE_TIMEOUT);

        // If the master timeout fired, fall back to local agents only
        if (!results) {
            logger.warn('[Multi-Model AI] Ensemble timeout — falling back to local agents', { symbol });
            return getAgenticFallback(symbol, stockData, newsData);
        }

        const { finbertResult, distilbertResult, technicalAgentResult, momentumAgentResult } = results;

        // Collect successful predictions
        const predictions = [];

        if (finbertResult.status === 'fulfilled' && finbertResult.value) {
            predictions.push({
                model: MODELS.FINBERT.name,
                signal: finbertResult.value.signal,
                confidence: finbertResult.value.confidence,
                weight: MODELS.FINBERT.weight,
                reasoning: finbertResult.value.reasoning
            });
            logger.info('[Multi-Model AI] FinBERT result', { symbol, signal: finbertResult.value.signal, confidence: finbertResult.value.confidence });
        }

        if (distilbertResult.status === 'fulfilled' && distilbertResult.value) {
            predictions.push({
                model: MODELS.DISTILBERT.name,
                signal: distilbertResult.value.signal,
                confidence: distilbertResult.value.confidence,
                weight: MODELS.DISTILBERT.weight,
                reasoning: distilbertResult.value.reasoning
            });
            logger.info('[Multi-Model AI] DistilBERT result', { symbol, signal: distilbertResult.value.signal, confidence: distilbertResult.value.confidence });
        }

        if (technicalAgentResult.status === 'fulfilled') {
            predictions.push({
                model: MODELS.TECHNICAL_AGENT.name,
                signal: technicalAgentResult.value.signal,
                confidence: technicalAgentResult.value.confidence,
                weight: MODELS.TECHNICAL_AGENT.weight,
                reasoning: technicalAgentResult.value.reasoning
            });
            logger.info('[Multi-Model AI] Technical Agent result', { symbol, signal: technicalAgentResult.value.signal });
        }

        if (momentumAgentResult.status === 'fulfilled') {
            predictions.push({
                model: MODELS.MOMENTUM_AGENT.name,
                signal: momentumAgentResult.value.signal,
                confidence: momentumAgentResult.value.confidence,
                weight: MODELS.MOMENTUM_AGENT.weight,
                reasoning: momentumAgentResult.value.reasoning
            });
            logger.info('[Multi-Model AI] Momentum Agent result', { symbol, signal: momentumAgentResult.value.signal });
        }

        // If no models succeeded, use local fallback
        if (predictions.length === 0) {
            logger.warn('[Multi-Model AI] All external models failed, using local fallback', { symbol });
            return getAgenticFallback(symbol, stockData, newsData);
        }

        // Ensemble voting with weighted consensus
        const ensembleResult = calculateEnsembleVote(predictions, stockData);
        
        return {
            signal: ensembleResult.signal,
            confidence: Math.round(ensembleResult.confidence),
            reasoning: ensembleResult.reasoning,
            model: 'multi-model-ensemble',
            modelsUsed: predictions.length,
            individualPredictions: predictions,
            technicalContext: getTechnicalContext(stockData),
            timestamp: new Date().toISOString()
        };

    } catch (error) {
        logger.error('[Multi-Model AI] Prediction error', { symbol, error: error.message });
        return getAgenticFallback(symbol, [], newsData);
    }
};

/**
 * FinBERT Model - Financial sentiment analysis
 */
const callFinBERT = async (symbol, stockData, newsData) => {
    if (!shouldUseProvider('FINBERT')) {
        return null;
    }

    try {
        const analysisText = constructFinancialAnalysis(symbol, stockData, newsData);
        
        const response = await axios.post(
            MODELS.FINBERT.url,
            { inputs: analysisText, options: { wait_for_model: true } },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': process.env.HUGGINGFACE_API_KEY ? `Bearer ${process.env.HUGGINGFACE_API_KEY}` : ''
                },
                timeout: API_TIMEOUT
            }
        );

        if (response.data && response.data[0]) {
            markProviderSuccess('FINBERT');
            const result = response.data[0];
            const sentiment = result.find(item => item.label === 'positive') || 
                            result.find(item => item.label === 'negative') || 
                            result[0];
            
            const score = sentiment.label === 'positive' ? sentiment.score : 
                         sentiment.label === 'negative' ? -sentiment.score : 0;
            
            const signal = score > 0.2 ? 'Buy' : score < -0.2 ? 'Sell' : 'Hold';
            const confidence = 50 + Math.abs(score) * 40;
            
            return {
                signal,
                confidence,
                reasoning: `FinBERT sentiment: ${sentiment.label} (${(sentiment.score * 100).toFixed(1)}%)`
            };
        }
        
        return null;
    } catch (error) {
        if (is429Error(error)) {
            markProvider429('FINBERT');
        } else {
            markProviderNon429Error('FINBERT', error);
        }
        return null;
    }
};

/**
 * DistilBERT Model - General sentiment analysis
 */
const callDistilBERT = async (symbol, stockData, newsData) => {
    if (!shouldUseProvider('DISTILBERT')) {
        return null;
    }

    try {
        const analysisText = constructGeneralAnalysis(symbol, stockData, newsData);
        
        const response = await axios.post(
            MODELS.DISTILBERT.url,
            { inputs: analysisText },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: API_TIMEOUT
            }
        );

        if (response.data && response.data[0]) {
            markProviderSuccess('DISTILBERT');
            const result = response.data[0];
            const sentiment = result.find(item => item.label === 'POSITIVE') || 
                            result.find(item => item.label === 'NEGATIVE') || 
                            result[0];
            
            const score = sentiment.label === 'POSITIVE' ? sentiment.score : 
                         sentiment.label === 'NEGATIVE' ? -sentiment.score : 0;
            
            const signal = score > 0.6 ? 'Buy' : score < 0.4 ? 'Sell' : 'Hold';
            const confidence = Math.abs(score - 0.5) * 100 + 50;
            
            return {
                signal,
                confidence,
                reasoning: `DistilBERT sentiment: ${sentiment.label} (${(sentiment.score * 100).toFixed(1)}%)`
            };
        }
        
        return null;
    } catch (error) {
        if (is429Error(error)) {
            markProvider429('DISTILBERT');
        } else {
            markProviderNon429Error('DISTILBERT', error);
        }
        return null;
    }
};

/**
 * Technical Agent - Analyzes chart patterns and indicators
 * Similar to AI Signals V3 functionality
 */
const runTechnicalAgent = async (symbol, stockData) => {
    try {
        const prices = stockData.map(d => d.close);
        const volumes = stockData.map(d => d.volume);
        
        // Calculate key technical indicators
        const sma5 = calculateSMA(prices, 5);
        const sma10 = calculateSMA(prices, 10);
        const sma20 = calculateSMA(prices, 20);
        const rsi = calculateRSI(prices, 14);
        const macdData = calculateMACD(prices);
        
        const currentPrice = prices[prices.length - 1];
        
        // Multi-factor scoring
        let score = 0;
        const factors = [];
        
        // SMA Trend Analysis
        if (currentPrice > sma5 && sma5 > sma10 && sma10 > sma20) {
            score += 3;
            factors.push('Strong uptrend (SMA alignment)');
        } else if (currentPrice < sma5 && sma5 < sma10 && sma10 < sma20) {
            score -= 3;
            factors.push('Strong downtrend (SMA alignment)');
        }
        
        // RSI Analysis
        if (rsi < 30) {
            score += 2;
            factors.push(`Oversold RSI (${rsi.toFixed(1)})`);
        } else if (rsi > 70) {
            score -= 2;
            factors.push(`Overbought RSI (${rsi.toFixed(1)})`);
        } else if (rsi >= 45 && rsi <= 55) {
            factors.push(`Neutral RSI (${rsi.toFixed(1)})`);
        }
        
        // MACD Analysis
        if (macdData.macd > macdData.signal && macdData.histogram > 0) {
            score += 2;
            factors.push('Bullish MACD crossover');
        } else if (macdData.macd < macdData.signal && macdData.histogram < 0) {
            score -= 2;
            factors.push('Bearish MACD crossover');
        }
        
        // Volume Trend
        const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
        const recentVolume = volumes[volumes.length - 1];
        if (recentVolume > avgVolume * 1.5) {
            score += currentPrice > prices[prices.length - 2] ? 1 : -1;
            factors.push(`High volume (${((recentVolume / avgVolume) * 100).toFixed(0)}% of average)`);
        }
        
        // Pattern Detection (simplified)
        const pattern = detectChartPattern(prices);
        if (pattern.bullish) {
            score += 1;
            factors.push(`Bullish pattern: ${pattern.name}`);
        } else if (pattern.bearish) {
            score -= 1;
            factors.push(`Bearish pattern: ${pattern.name}`);
        }
        
        // Determine signal
        const signal = score >= 3 ? 'Buy' : score <= -3 ? 'Sell' : 'Hold';
        const confidence = Math.min(50 + Math.abs(score) * 8, 90);
        
        return {
            signal,
            confidence,
            reasoning: `Technical Analysis: ${factors.join(', ')}. Score: ${score}/10`,
            technicalScore: score
        };
        
    } catch (error) {
        logger.error('[Multi-Model AI] Technical Agent error', { error: error.message });
        return {
            signal: 'Hold',
            confidence: 50,
            reasoning: 'Technical analysis unavailable'
        };
    }
};

/**
 * Momentum Agent - Analyzes price momentum and velocity
 * Similar to Holly AI momentum tracking
 */
const runMomentumAgent = async (symbol, stockData) => {
    try {
        const prices = stockData.map(d => d.close);
        const volumes = stockData.map(d => d.volume);
        
        // Calculate momentum indicators
        const momentum5 = calculateMomentum(prices, 5);
        const momentum10 = calculateMomentum(prices, 10);
        const rateOfChange = calculateRateOfChange(prices, 10);
        const accelerationRate = calculateAcceleration(prices);
        
        let score = 0;
        const factors = [];
        
        // Short-term momentum
        if (momentum5 > 2) {
            score += 3;
            factors.push(`Strong 5-day momentum (+${momentum5.toFixed(2)}%)`);
        } else if (momentum5 < -2) {
            score -= 3;
            factors.push(`Weak 5-day momentum (${momentum5.toFixed(2)}%)`);
        }
        
        // Medium-term momentum
        if (momentum10 > 3) {
            score += 2;
            factors.push(`Positive 10-day trend (+${momentum10.toFixed(2)}%)`);
        } else if (momentum10 < -3) {
            score -= 2;
            factors.push(`Negative 10-day trend (${momentum10.toFixed(2)}%)`);
        }
        
        // Acceleration (momentum of momentum)
        if (accelerationRate > 0.5) {
            score += 2;
            factors.push('Accelerating upward');
        } else if (accelerationRate < -0.5) {
            score -= 2;
            factors.push('Accelerating downward');
        }
        
        // Rate of change
        if (Math.abs(rateOfChange) > 5) {
            factors.push(`High volatility (${rateOfChange.toFixed(1)}% ROC)`);
            if (rateOfChange > 0) score += 1;
            else score -= 1;
        }
        
        // Determine signal
        const signal = score >= 3 ? 'Buy' : score <= -3 ? 'Sell' : 'Hold';
        const confidence = Math.min(50 + Math.abs(score) * 7, 85);
        
        return {
            signal,
            confidence,
            reasoning: `Momentum Analysis: ${factors.join(', ')}. Score: ${score}/10`,
            momentumScore: score
        };
        
    } catch (error) {
        logger.error('[Multi-Model AI] Momentum Agent error', { error: error.message });
        return {
            signal: 'Hold',
            confidence: 50,
            reasoning: 'Momentum analysis unavailable'
        };
    }
};

/**
 * Ensemble voting system - Combines all model predictions
 * Implements agentic consensus mechanism
 */
const calculateEnsembleVote = (predictions, stockData) => {
    let buyScore = 0;
    let sellScore = 0;
    let holdScore = 0;
    let totalWeight = 0;
    let weightedConfidence = 0;
    
    const reasons = [];
    
    predictions.forEach(pred => {
        const weight = pred.weight || 0.25;
        const confidenceFactor = pred.confidence / 100;
        const weightedVote = weight * confidenceFactor;
        
        if (pred.signal === 'Buy') {
            buyScore += weightedVote;
        } else if (pred.signal === 'Sell') {
            sellScore += weightedVote;
        } else {
            holdScore += weightedVote;
        }
        
        totalWeight += weight;
        weightedConfidence += pred.confidence * weight;
        reasons.push(`${pred.model}: ${pred.signal} (${pred.confidence}%)`);
    });
    
    // Normalize scores
    buyScore = (buyScore / totalWeight) * 100;
    sellScore = (sellScore / totalWeight) * 100;
    holdScore = (holdScore / totalWeight) * 100;
    
    // Determine consensus signal
    let signal = 'Hold';
    let confidence = weightedConfidence / totalWeight;
    
    if (buyScore > sellScore && buyScore > holdScore && buyScore > 40) {
        signal = 'Buy';
    } else if (sellScore > buyScore && sellScore > holdScore && sellScore > 40) {
        signal = 'Sell';
    }
    
    // Boost confidence if strong consensus
    const consensusStrength = Math.max(buyScore, sellScore, holdScore);
    if (consensusStrength > 70) {
        confidence = Math.min(confidence + 10, 95);
    }
    
    const reasoning = `🤖 Ensemble Consensus (${predictions.length} models): ${signal} signal with ${consensusStrength.toFixed(0)}% agreement. ${reasons.join(' | ')}`;
    
    return {
        signal,
        confidence,
        reasoning,
        scores: { buy: buyScore, sell: sellScore, hold: holdScore }
    };
};

/**
 * Agentic Fallback - Rule-based multi-agent system
 * Used when AI models are unavailable
 */
const getAgenticFallback = async (symbol, stockData, newsData = null) => {
    try {
        if (stockData.length < 5) {
            return {
                signal: 'Hold',
                confidence: 30,
                reasoning: 'Insufficient data for analysis',
                model: 'fallback-minimal',
                technicalContext: {}
            };
        }
        
        // Run local agents in parallel
        const [technicalResult, momentumResult] = await Promise.all([
            runTechnicalAgent(symbol, stockData),
            runMomentumAgent(symbol, stockData)
        ]);
        
        // Combine agent results
        const agents = [
            { ...technicalResult, weight: 0.5 },
            { ...momentumResult, weight: 0.5 }
        ];
        
        const consensus = calculateEnsembleVote(agents, stockData);
        
        return {
            signal: consensus.signal,
            confidence: Math.round(consensus.confidence * 0.9), // Slightly lower confidence for fallback
            reasoning: `📊 Agentic Fallback System: ${consensus.reasoning}`,
            model: 'agentic-fallback',
            modelsUsed: 2,
            individualPredictions: agents,
            technicalContext: getTechnicalContext(stockData),
            timestamp: new Date().toISOString()
        };
        
    } catch (error) {
        return {
            signal: 'Hold',
            confidence: 40,
            reasoning: 'Analysis system temporarily unavailable',
            model: 'error-fallback',
            technicalContext: {}
        };
    }
};

// Helper Functions

function constructFinancialAnalysis(symbol, stockData, newsData) {
    const prices = stockData.map(d => d.close);
    const priceChange = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
    const trend = priceChange > 0 ? 'upward' : 'downward';
    
    let text = `${symbol} stock analysis: Price has moved ${trend} by ${Math.abs(priceChange).toFixed(2)}% recently. `;
    
    if (newsData && newsData.sentiment) {
        text += `Market sentiment is ${newsData.sentiment > 0 ? 'positive' : 'negative'}. `;
    }
    
    const momentum = calculateMomentum(prices, 5);
    text += `Momentum is ${momentum > 0 ? 'bullish' : 'bearish'}.`;
    
    return text;
}

function constructGeneralAnalysis(symbol, stockData, newsData) {
    const prices = stockData.map(d => d.close);
    const priceChange = ((prices[prices.length - 1] - prices[0]) / prices[0]) * 100;
    
    return `The stock ${symbol} shows ${priceChange > 0 ? 'positive' : 'negative'} performance with ${Math.abs(priceChange).toFixed(1)}% movement.`;
}

function calculateSMA(prices, period) {
    if (prices.length < period) return prices[prices.length - 1];
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    
    let gains = 0;
    let losses = 0;
    
    for (let i = prices.length - period; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }
    
    const avgGain = gains / period;
    const avgLoss = losses / period;
    
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateMACD(prices) {
    const ema12 = calculateEMA(prices, 12);
    const ema26 = calculateEMA(prices, 26);
    const macd = ema12 - ema26;
    const signal = macd * 0.9; // Simplified signal line
    const histogram = macd - signal;
    
    return { macd, signal, histogram };
}

function calculateEMA(prices, period) {
    if (prices.length < period) return prices[prices.length - 1];
    const multiplier = 2 / (period + 1);
    let ema = prices[0];
    for (let i = 1; i < prices.length; i++) {
        ema = (prices[i] - ema) * multiplier + ema;
    }
    return ema;
}

function calculateMomentum(prices, period) {
    if (prices.length < period * 2) return 0;
    const recent = prices.slice(-period);
    const older = prices.slice(-period * 2, -period);
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
    return ((recentAvg - olderAvg) / olderAvg) * 100;
}

function calculateRateOfChange(prices, period) {
    if (prices.length < period) return 0;
    const current = prices[prices.length - 1];
    const past = prices[prices.length - period];
    return ((current - past) / past) * 100;
}

function calculateAcceleration(prices) {
    if (prices.length < 6) return 0;
    const momentum1 = calculateMomentum(prices.slice(-10), 5);
    const momentum2 = calculateMomentum(prices.slice(-15, -5), 5);
    return momentum1 - momentum2;
}

function detectChartPattern(prices) {
    if (prices.length < 20) return { name: 'None', bullish: false, bearish: false };
    
    const recent = prices.slice(-10);
    const high = Math.max(...recent);
    const low = Math.min(...recent);
    const current = recent[recent.length - 1];
    
    // Simple pattern detection
    if (current > high * 0.95) {
        return { name: 'Breakout', bullish: true, bearish: false };
    } else if (current < low * 1.05) {
        return { name: 'Breakdown', bullish: false, bearish: true };
    }
    
    return { name: 'Consolidation', bullish: false, bearish: false };
}

function getTechnicalContext(stockData) {
    if (stockData.length < 2) return {};
    
    const prices = stockData.map(d => d.close);
    const volumes = stockData.map(d => d.volume);
    const latestPrice = prices[prices.length - 1];
    const previousPrice = prices[prices.length - 2];
    const priceChange = ((latestPrice - previousPrice) / previousPrice) * 100;
    
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const currentVolume = volumes[volumes.length - 1];
    const volumeChange = ((currentVolume - avgVolume) / avgVolume) * 100;
    
    return {
        priceChange: priceChange.toFixed(2),
        volumeTrend: volumeChange > 0 ? `${volumeChange.toFixed(0)}% above average` : `${Math.abs(volumeChange).toFixed(0)}% below average`,
        momentum: calculateMomentum(prices, 5) > 2 ? 'Strong Bullish' : 
                 calculateMomentum(prices, 5) < -2 ? 'Strong Bearish' : 'Neutral',
        sma5: calculateSMA(prices, 5),
        sma10: calculateSMA(prices, 10),
        sma20: calculateSMA(prices, 20),
        rsi: calculateRSI(prices, 14)
    };
}

module.exports = {
    getMultiModelPrediction,
    runTechnicalAgent,
    runMomentumAgent
};
