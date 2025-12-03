const stockDataService = require('./stockDataService');
const { getMultiModelPrediction } = require('./multiModelAIService');
const fundamentalsService = require('./fundamentalsService');
const newsSentimentService = require('./newsSentimentService');

/**
 * Weekly Stock Prediction Engine
 * Analyzes all major stocks and predicts top performers for the coming week
 */

// Major stocks to analyze (S&P 100 most liquid)
const MAJOR_STOCKS = [
    // Tech
    'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'TSLA', 'AMD', 'NFLX', 'ADBE',
    'CRM', 'ORCL', 'INTC', 'CSCO', 'AVGO', 'QCOM', 'TXN', 'PYPL', 'SQ', 'SHOP',
    // Finance
    'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BLK', 'SCHW', 'AXP', 'V', 'MA',
    // Healthcare
    'JNJ', 'UNH', 'PFE', 'ABBV', 'TMO', 'MRK', 'ABT', 'DHR', 'LLY', 'BMY',
    // Consumer
    'WMT', 'HD', 'DIS', 'MCD', 'NKE', 'SBUX', 'TGT', 'COST', 'LOW', 'CVS',
    // Energy
    'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO',
    // Industrial
    'BA', 'CAT', 'GE', 'HON', 'UPS', 'RTX', 'LMT', 'MMM', 'DE',
    // Other
    'UBER', 'ABNB', 'COIN', 'RBLX', 'PLTR', 'SNOW'
];

// Remove duplicates from stock list
const UNIQUE_STOCKS = [...new Set(MAJOR_STOCKS)];

// Scoring weights for different factors
const SCORING_WEIGHTS = {
    aiSignal: 0.25,           // AI ensemble prediction
    technicalScore: 0.20,     // Technical indicators
    fundamentalScore: 0.15,   // Fundamentals & analyst ratings
    momentumScore: 0.15,      // Price momentum
    sentimentScore: 0.10,     // News sentiment
    volumeScore: 0.10,        // Volume trends
    volatilityScore: 0.05     // Volatility (lower is better for weekly)
};

/**
 * Get weekly predictions for all major stocks
 */
const getWeeklyPredictions = async (options = {}) => {
    const {
        limit = 20,
        minScore = 60,
        sectors = null,
        marketCapMin = null,
        volatilityMax = null
    } = options;

    console.log('[Weekly Predictions] Starting analysis of major stocks...');
    
    try {
        // Analyze all stocks in parallel (batched to avoid overwhelming APIs)
        const batchSize = 10;
        const allPredictions = [];
        
        for (let i = 0; i < UNIQUE_STOCKS.length; i += batchSize) {
            const batch = UNIQUE_STOCKS.slice(i, i + batchSize);
            const batchResults = await Promise.allSettled(
                batch.map(symbol => analyzeStockForWeek(symbol))
            );
            
            batchResults.forEach((result, idx) => {
                if (result.status === 'fulfilled' && result.value) {
                    allPredictions.push(result.value);
                } else {
                    console.log(`[Weekly] Skipped ${batch[idx]}: ${result.reason}`);
                }
            });
            
            // Brief pause between batches to respect rate limits
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        // Remove any duplicate symbols (keep highest score)
        const uniqueSymbols = new Map();
        allPredictions.forEach(p => {
            if (!uniqueSymbols.has(p.symbol) || uniqueSymbols.get(p.symbol).totalScore < p.totalScore) {
                uniqueSymbols.set(p.symbol, p);
            }
        });
        const dedupedPredictions = Array.from(uniqueSymbols.values());
        
        // Filter and sort predictions
        let filtered = dedupedPredictions.filter(p => p.totalScore >= minScore);
        
        // Apply additional filters if specified
        if (sectors) {
            filtered = filtered.filter(p => sectors.includes(p.sector));
        }
        
        if (marketCapMin) {
            filtered = filtered.filter(p => p.marketCap >= marketCapMin);
        }
        
        if (volatilityMax) {
            filtered = filtered.filter(p => p.volatility <= volatilityMax);
        }
        
        // Sort by total score (highest first)
        filtered.sort((a, b) => b.totalScore - a.totalScore);
        
        // Assign tier ratings
        const withTiers = assignTierRatings(filtered);
        
        // Calculate market context
        const marketContext = await calculateMarketContext(allPredictions);
        
        console.log(`[Weekly Predictions] Analysis complete. Top ${limit} picks identified.`);
        
        return {
            topPicks: withTiers.slice(0, limit),
            allAnalyzed: withTiers,
            marketContext,
            analysisDate: new Date().toISOString(),
            totalAnalyzed: allPredictions.length,
            filters: { minScore, sectors, marketCapMin, volatilityMax }
        };
        
    } catch (error) {
        console.error('[Weekly Predictions] Error:', error);
        throw error;
    }
};

/**
 * Analyze a single stock for weekly performance prediction
 */
const analyzeStockForWeek = async (symbol) => {
    try {
        // Get all required data in parallel
        const [stockData, aiPrediction, fundamentals, newsData] = await Promise.allSettled([
            stockDataService.getStockData(symbol, '1d'),
            getMultiModelPrediction(symbol).catch(() => null),
            fundamentalsService.getFundamentals(symbol).catch(() => null),
            newsSentimentService.getNewsSentiment(symbol).catch(() => null)
        ]);
        
        const prices = stockData.status === 'fulfilled' ? stockData.value : [];
        const ai = aiPrediction.status === 'fulfilled' ? aiPrediction.value : null;
        const fund = fundamentals.status === 'fulfilled' ? fundamentals.value : null;
        const news = newsData.status === 'fulfilled' ? newsData.value : null;
        
        if (prices.length < 20) {
            throw new Error('Insufficient data');
        }
        
        // Calculate component scores
        const aiScore = calculateAIScore(ai);
        const technicalScore = calculateTechnicalScore(prices);
        const fundamentalScore = calculateFundamentalScore(fund);
        const momentumScore = calculateMomentumScore(prices);
        const sentimentScore = calculateSentimentScore(news);
        const volumeScore = calculateVolumeScore(prices);
        const volatilityScore = calculateVolatilityScore(prices);
        
        // Calculate weighted total score (0-100)
        const totalScore = 
            aiScore * SCORING_WEIGHTS.aiSignal +
            technicalScore * SCORING_WEIGHTS.technicalScore +
            fundamentalScore * SCORING_WEIGHTS.fundamentalScore +
            momentumScore * SCORING_WEIGHTS.momentumScore +
            sentimentScore * SCORING_WEIGHTS.sentimentScore +
            volumeScore * SCORING_WEIGHTS.volumeScore +
            volatilityScore * SCORING_WEIGHTS.volatilityScore;
        
        // Determine expected move and confidence
        const expectedMove = calculateExpectedMove(prices, totalScore);
        const confidence = calculateConfidence(aiScore, technicalScore, fundamentalScore);
        
        // Generate rationale
        const rationale = generateRationale(symbol, {
            ai, fund, news, 
            technicalScore, momentumScore, sentimentScore
        });
        
        // Detect upcoming events
        const upcomingEvents = detectUpcomingEvents(fund, news);
        
        // Get current price info
        const currentPrice = prices[prices.length - 1].close;
        const priceChange1w = ((currentPrice - prices[Math.max(0, prices.length - 5)].close) / 
                              prices[Math.max(0, prices.length - 5)].close) * 100;
        
        return {
            symbol,
            totalScore: Math.round(totalScore),
            tier: null, // Assigned later
            componentScores: {
                ai: Math.round(aiScore),
                technical: Math.round(technicalScore),
                fundamental: Math.round(fundamentalScore),
                momentum: Math.round(momentumScore),
                sentiment: Math.round(sentimentScore),
                volume: Math.round(volumeScore),
                volatility: Math.round(volatilityScore)
            },
            prediction: {
                signal: ai?.signal || 'Hold',
                expectedMove: expectedMove.toFixed(2),
                confidence: Math.round(confidence),
                targetPrice: (currentPrice * (1 + expectedMove / 100)).toFixed(2)
            },
            currentPrice: currentPrice.toFixed(2),
            priceChange1w: priceChange1w.toFixed(2),
            rationale,
            upcomingEvents,
            technicalSignals: getTechnicalSignals(prices),
            analystRatings: fund?.analystRatings || null,
            marketCap: fund?.marketCap || null,
            sector: fund?.sector || 'Unknown',
            volatility: calculateVolatility(prices),
            lastUpdated: new Date().toISOString()
        };
        
    } catch (error) {
        console.error(`[Weekly] Error analyzing ${symbol}:`, error.message);
        return null;
    }
};

/**
 * Calculate AI model score (0-100)
 */
const calculateAIScore = (aiPrediction) => {
    if (!aiPrediction) return 50;
    
    const { signal, confidence } = aiPrediction;
    
    if (signal === 'Buy') {
        return confidence;
    } else if (signal === 'Sell') {
        return 100 - confidence;
    } else {
        return 50;
    }
};

/**
 * Calculate technical indicator score (0-100)
 */
const calculateTechnicalScore = (prices) => {
    const priceValues = prices.map(p => p.close);
    let score = 50;
    
    // SMA alignment
    const sma5 = calculateSMA(priceValues, 5);
    const sma10 = calculateSMA(priceValues, 10);
    const sma20 = calculateSMA(priceValues, 20);
    const sma50 = calculateSMA(priceValues, 50);
    const current = priceValues[priceValues.length - 1];
    
    if (current > sma5 && sma5 > sma10 && sma10 > sma20) score += 20;
    else if (current < sma5 && sma5 < sma10 && sma10 < sma20) score -= 20;
    
    if (current > sma50) score += 10;
    else score -= 10;
    
    // RSI
    const rsi = calculateRSI(priceValues, 14);
    if (rsi >= 40 && rsi <= 60) score += 10; // Neutral RSI is good for weekly
    else if (rsi > 70) score -= 15; // Overbought
    else if (rsi < 30) score += 15; // Oversold - potential bounce
    
    // MACD
    const macd = calculateMACD(priceValues);
    if (macd.histogram > 0) score += 10;
    else score -= 10;
    
    return Math.max(0, Math.min(100, score));
};

/**
 * Calculate fundamental score (0-100)
 */
const calculateFundamentalScore = (fundamentals) => {
    if (!fundamentals) return 50;
    
    let score = 50;
    
    // Analyst ratings
    if (fundamentals.analystRatings) {
        const { strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0 } = fundamentals.analystRatings;
        const total = strongBuy + buy + hold + sell + strongSell;
        if (total > 0) {
            const bullishPct = ((strongBuy * 2 + buy) / (total * 2)) * 100;
            score = bullishPct;
        }
    }
    
    // Price target upside
    if (fundamentals.priceTargets?.average && fundamentals.currentPrice) {
        const upside = ((fundamentals.priceTargets.average - fundamentals.currentPrice) / 
                       fundamentals.currentPrice) * 100;
        if (upside > 10) score += 20;
        else if (upside > 5) score += 10;
        else if (upside < -5) score -= 10;
    }
    
    // Earnings growth
    if (fundamentals.earningsGrowth > 0.15) score += 10;
    else if (fundamentals.earningsGrowth < 0) score -= 10;
    
    return Math.max(0, Math.min(100, score));
};

/**
 * Calculate momentum score (0-100)
 */
const calculateMomentumScore = (prices) => {
    const priceValues = prices.map(p => p.close);
    let score = 50;
    
    // 5-day momentum
    const momentum5 = calculateMomentum(priceValues, 5);
    if (momentum5 > 3) score += 25;
    else if (momentum5 > 1) score += 15;
    else if (momentum5 < -3) score -= 25;
    else if (momentum5 < -1) score -= 15;
    
    // 10-day momentum
    const momentum10 = calculateMomentum(priceValues, 10);
    if (momentum10 > 5) score += 25;
    else if (momentum10 > 2) score += 15;
    else if (momentum10 < -5) score -= 25;
    else if (momentum10 < -2) score -= 15;
    
    return Math.max(0, Math.min(100, score));
};

/**
 * Calculate sentiment score from news (0-100)
 */
const calculateSentimentScore = (newsData) => {
    if (!newsData || !newsData.overallSentiment) return 50;
    
    const sentiment = newsData.overallSentiment;
    
    // Convert -100 to 100 sentiment to 0-100 score
    return ((sentiment + 100) / 2);
};

/**
 * Calculate volume score (0-100)
 */
const calculateVolumeScore = (prices) => {
    const volumes = prices.map(p => p.volume);
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    
    const volumeIncrease = ((recentVolume - avgVolume) / avgVolume) * 100;
    
    let score = 50;
    if (volumeIncrease > 50) score = 90;
    else if (volumeIncrease > 25) score = 75;
    else if (volumeIncrease > 10) score = 65;
    else if (volumeIncrease < -25) score = 30;
    else if (volumeIncrease < -10) score = 40;
    
    return score;
};

/**
 * Calculate volatility score (0-100, lower volatility = higher score for weekly)
 */
const calculateVolatilityScore = (prices) => {
    const volatility = calculateVolatility(prices);
    
    // Lower volatility is better for weekly predictions
    if (volatility < 1) return 90;
    if (volatility < 2) return 75;
    if (volatility < 3) return 60;
    if (volatility < 5) return 45;
    return 30;
};

/**
 * Calculate expected price move percentage
 */
const calculateExpectedMove = (prices, totalScore) => {
    const priceValues = prices.map(p => p.close);
    const avgVolatility = calculateVolatility(prices);
    const momentum = calculateMomentum(priceValues, 10);
    
    // Base expected move on score, volatility, and momentum
    let expectedMove = ((totalScore - 50) / 10) * avgVolatility;
    expectedMove += momentum * 0.3;
    
    return Math.max(-15, Math.min(15, expectedMove));
};

/**
 * Calculate prediction confidence (0-100)
 */
const calculateConfidence = (aiScore, technicalScore, fundamentalScore) => {
    // Higher confidence when scores agree
    const avgScore = (aiScore + technicalScore + fundamentalScore) / 3;
    const deviation = Math.abs(aiScore - avgScore) + 
                     Math.abs(technicalScore - avgScore) + 
                     Math.abs(fundamentalScore - avgScore);
    
    const agreement = Math.max(0, 100 - deviation / 3);
    
    return Math.min(95, agreement);
};

/**
 * Generate human-readable rationale
 */
const generateRationale = (symbol, data) => {
    const { ai, fund, news, technicalScore, momentumScore, sentimentScore } = data;
    
    const reasons = [];
    
    // AI signal
    if (ai?.signal === 'Buy' && ai.confidence > 75) {
        reasons.push('Strong AI buy signal');
    }
    
    // Fundamentals
    if (fund?.analystRatings) {
        const { strongBuy = 0, buy = 0 } = fund.analystRatings;
        if (strongBuy + buy > 5) {
            reasons.push('Positive analyst upgrades');
        }
    }
    
    // Technical
    if (technicalScore > 70) {
        reasons.push('Bullish technical setup');
    } else if (technicalScore < 30) {
        reasons.push('Bearish technical pattern');
    }
    
    // Momentum
    if (momentumScore > 70) {
        reasons.push('Strong momentum');
    }
    
    // Sentiment
    if (sentimentScore > 70) {
        reasons.push('Positive news sentiment');
    } else if (sentimentScore < 30) {
        reasons.push('Negative news flow');
    }
    
    // Earnings
    if (fund?.earningsGrowth > 0.2) {
        reasons.push('Earnings beat expectations');
    }
    
    if (reasons.length === 0) {
        return 'Mixed signals, moderate confidence';
    }
    
    return reasons.join(', ') + '.';
};

/**
 * Detect upcoming events
 */
const detectUpcomingEvents = (fundamentals, newsData) => {
    const events = [];
    
    // Check for earnings date (simplified - would use actual earnings calendar API)
    const now = new Date();
    const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    
    // Placeholder for actual event detection
    // In production, integrate with earnings calendar API
    
    return events;
};

/**
 * Get technical signal flags
 */
const getTechnicalSignals = (prices) => {
    const priceValues = prices.map(p => p.close);
    const signals = [];
    
    // MA Crossovers
    const sma5 = calculateSMA(priceValues, 5);
    const sma10 = calculateSMA(priceValues, 10);
    const sma20 = calculateSMA(priceValues, 20);
    
    if (sma5 > sma10 && sma10 > sma20) {
        signals.push({ type: 'Golden Alignment', direction: 'bullish' });
    } else if (sma5 < sma10 && sma10 < sma20) {
        signals.push({ type: 'Death Alignment', direction: 'bearish' });
    }
    
    // RSI
    const rsi = calculateRSI(priceValues, 14);
    if (rsi > 70) {
        signals.push({ type: 'Overbought RSI', direction: 'neutral' });
    } else if (rsi < 30) {
        signals.push({ type: 'Oversold RSI', direction: 'bullish' });
    }
    
    // Breakout detection
    const high20 = Math.max(...priceValues.slice(-20));
    const current = priceValues[priceValues.length - 1];
    if (current >= high20 * 0.99) {
        signals.push({ type: 'Breakout', direction: 'bullish' });
    }
    
    return signals;
};

/**
 * Assign tier ratings (A, B, C, D, F)
 */
const assignTierRatings = (predictions) => {
    return predictions.map(pred => {
        let tier;
        if (pred.totalScore >= 80) tier = 'A';
        else if (pred.totalScore >= 70) tier = 'B';
        else if (pred.totalScore >= 60) tier = 'C';
        else if (pred.totalScore >= 50) tier = 'D';
        else tier = 'F';
        
        return { ...pred, tier };
    });
};

/**
 * Calculate overall market context
 */
const calculateMarketContext = async (allPredictions) => {
    const bullishCount = allPredictions.filter(p => p.totalScore > 65).length;
    const bearishCount = allPredictions.filter(p => p.totalScore < 45).length;
    const neutralCount = allPredictions.length - bullishCount - bearishCount;
    
    const avgScore = allPredictions.reduce((sum, p) => sum + p.totalScore, 0) / allPredictions.length;
    
    let marketSentiment;
    if (avgScore > 65) marketSentiment = 'Bullish';
    else if (avgScore < 45) marketSentiment = 'Bearish';
    else marketSentiment = 'Neutral';
    
    return {
        marketSentiment,
        averageScore: Math.round(avgScore),
        distribution: {
            bullish: bullishCount,
            bearish: bearishCount,
            neutral: neutralCount
        },
        topSectors: getTopSectors(allPredictions),
        summary: `Market is ${marketSentiment.toLowerCase()} with ${bullishCount} bullish vs ${bearishCount} bearish stocks.`
    };
};

/**
 * Get top performing sectors
 */
const getTopSectors = (predictions) => {
    const sectorScores = {};
    const sectorCounts = {};
    
    predictions.forEach(pred => {
        if (pred.sector && pred.sector !== 'Unknown') {
            if (!sectorScores[pred.sector]) {
                sectorScores[pred.sector] = 0;
                sectorCounts[pred.sector] = 0;
            }
            sectorScores[pred.sector] += pred.totalScore;
            sectorCounts[pred.sector]++;
        }
    });
    
    const sectors = Object.keys(sectorScores).map(sector => ({
        sector,
        avgScore: Math.round(sectorScores[sector] / sectorCounts[sector]),
        count: sectorCounts[sector]
    }));
    
    sectors.sort((a, b) => b.avgScore - a.avgScore);
    
    return sectors.slice(0, 5);
};

// Helper calculation functions
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
    const signal = macd * 0.9;
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

function calculateVolatility(prices) {
    const returns = [];
    for (let i = 1; i < prices.length; i++) {
        returns.push((prices[i].close - prices[i - 1].close) / prices[i - 1].close);
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - mean, 2), 0) / returns.length;
    return Math.sqrt(variance) * 100;
}

module.exports = {
    getWeeklyPredictions,
    analyzeStockForWeek,
    MAJOR_STOCKS
};
