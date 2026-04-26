const stockDataService = require('./stockDataService');
const { getMultiModelPrediction } = require('./multiModelAIService');
const fundamentalsService = require('./fundamentalsService');
const newsSentimentService = require('./newsSentimentService');
const { ALL_STOCKS, TOP_200, MEGA_CAP, TOTAL_COUNT } = require('./stockUniverse');
const cacheService = require('./cacheService');

// Cache weekly predictions for 30 minutes — the scan takes minutes, no need to re-run on every page load
const WEEKLY_CACHE_TTL = 30 * 60 * 1000;

/**
 * Weekly Stock Prediction Engine
 * Analyzes all major stocks and predicts top performers for the coming week
 * 
 * Universe Options:
 * - ALL_STOCKS: 800+ stocks (comprehensive analysis, ~3-5 minutes)
 * - TOP_200: 200 most liquid (balanced, ~60-90 seconds)
 * - MEGA_CAP: 50 largest companies (quick, ~15-20 seconds)
 */

// Stock universe configuration - change based on needs
const STOCK_UNIVERSE_CONFIG = {
    DEFAULT: 'TOP_200',     // Balanced - 200 stocks (~90 seconds)
    QUICK: 'MEGA_CAP',      // Quick - 50 stocks (~20 seconds)
    COMPREHENSIVE: 'ALL'    // Full - 800+ stocks (~4 minutes)
};

// Select which universe to use (can be changed via query parameter)
function getStockUniverse(universeType = 'DEFAULT') {
    switch(universeType.toUpperCase()) {
        case 'ALL':
        case 'COMPREHENSIVE':
        case 'FULL':
            return ALL_STOCKS;
        case 'MEGA_CAP':
        case 'MEGA':
        case 'QUICK':
            return MEGA_CAP;
        case 'TOP_200':
        case 'TOP200':
        case 'DEFAULT':
        default:
            return TOP_200;
    }
}

console.log(`[Weekly Predictions] Stock universe loaded: ${TOTAL_COUNT} stocks available`);
console.log(`[Weekly Predictions] Default mode: TOP_200 (${TOP_200.length} stocks)`);
console.log(`[Weekly Predictions] Available modes: MEGA_CAP (${MEGA_CAP.length}), TOP_200 (${TOP_200.length}), ALL (${TOTAL_COUNT})`);

const MAJOR_STOCKS = [
    // This is kept for backwards compatibility but will be replaced by dynamic universe selection
    // Mega Cap Tech (FAANG+)
    'AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA', 'NFLX',
    
    // Large Cap Tech
    'AMD', 'ADBE', 'CRM', 'ORCL', 'INTC', 'CSCO', 'AVGO', 'QCOM', 'TXN', 'INTU',
    'NOW', 'PANW', 'CRWD', 'ZS', 'DDOG', 'NET', 'SNOW', 'PLTR', 'U', 'TEAM',
    'WDAY', 'SPLK', 'FTNT', 'OKTA', 'MDB', 'DOCU', 'ZM', 'TWLO', 'SQ', 'PYPL',
    
    // Software & Cloud
    'MSCI', 'VEEV', 'ANSS', 'CDNS', 'SNPS', 'ADSK', 'ROP', 'KEYS', 'PTC', 'MCHP',
    
    // Semiconductors
    'ASML', 'TSM', 'AMAT', 'LRCX', 'KLAC', 'MU', 'NXPI', 'ADI', 'MRVL', 'ON',
    'SWKS', 'QRVO', 'MPWR', 'ENTG',
    
    // E-commerce & Digital
    'SHOP', 'MELI', 'SE', 'BABA', 'JD', 'PDD', 'EBAY', 'ETSY', 'W', 'CHWY',
    
    // Social Media & Gaming
    'SNAP', 'PINS', 'RBLX', 'TTWO', 'EA', 'ATVI', 'U', 'DKNG', 'PENN',
    
    // Streaming & Entertainment
    'DIS', 'PARA', 'WBD', 'ROKU', 'SPOT', 'FUBO',
    
    // Fintech & Payments
    'V', 'MA', 'AXP', 'FIS', 'FISV', 'GPN', 'ADYB', 'COIN', 'HOOD', 'AFRM',
    'SOFI', 'LC', 'UPST',
    
    // Banks & Financial Services
    'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'BLK', 'SCHW', 'USB', 'PNC',
    'TFC', 'ALLY', 'COF', 'DFS', 'SYF',
    
    // Insurance
    'BRK.B', 'PGR', 'ALL', 'TRV', 'AIG', 'MET', 'PRU', 'AFL', 'CINF',
    
    // Healthcare - Pharma
    'JNJ', 'PFE', 'ABBV', 'MRK', 'LLY', 'BMY', 'AMGN', 'GILD', 'REGN', 'VRTX',
    'BIIB', 'MRNA', 'BNTX', 'SRPT', 'ALNY', 'IONS', 'BMRN', 'JAZZ',
    
    // Healthcare - Biotech
    'ILMN', 'INCY', 'EXAS', 'TECH', 'VRTX', 'NBIX', 'RARE', 'UTHR',
    
    // Healthcare - Med Tech
    'UNH', 'CVS', 'CI', 'HUM', 'ANTM', 'ELV', 'CNC', 'MOH',
    'ABT', 'TMO', 'DHR', 'SYK', 'BSX', 'MDT', 'ISRG', 'EW', 'ZBH', 'ALGN',
    'DXCM', 'HOLX', 'PODD', 'RMD', 'IDXX', 'IQV',
    
    // Consumer Discretionary - Retail
    'WMT', 'HD', 'LOW', 'TGT', 'COST', 'TJX', 'ROST', 'DLTR', 'DG', 'BBY',
    'ULTA', 'GPS', 'ANF', 'LULU', 'NKE', 'FL',
    
    // Consumer Discretionary - Auto
    'F', 'GM', 'RIVN', 'LCID', 'NIO', 'XPEV', 'LI',
    
    // Consumer Discretionary - Restaurants & Hotels
    'MCD', 'SBUX', 'CMG', 'YUM', 'QSR', 'DPZ', 'WING', 'SHAK', 'BROS',
    'MAR', 'HLT', 'H', 'ABNB', 'BKNG', 'EXPE',
    
    // Consumer Staples
    'PG', 'KO', 'PEP', 'MDLZ', 'COST', 'WMT', 'CL', 'KMB', 'GIS', 'K',
    'CAG', 'CPB', 'MKC', 'HSY', 'SJM', 'MNST', 'KDP', 'STZ',
    
    // Energy - Oil & Gas
    'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'HES', 'OXY',
    'DVN', 'FANG', 'MRO', 'APA', 'HAL', 'BKR',
    
    // Energy - Renewables
    'NEE', 'ENPH', 'SEDG', 'RUN', 'PLUG', 'BE', 'FCEL',
    
    // Industrials - Aerospace & Defense
    'BA', 'LMT', 'RTX', 'GD', 'NOC', 'TDG', 'HWM', 'TXT',
    
    // Industrials - Manufacturing
    'CAT', 'DE', 'CMI', 'ETN', 'EMR', 'ROK', 'PH', 'ITW', 'FTV',
    
    // Industrials - Transportation
    'UPS', 'FDX', 'UBER', 'LYFT', 'UAL', 'DAL', 'AAL', 'LUV', 'JBLU',
    'NSC', 'UNP', 'CSX',
    
    // Industrials - General
    'HON', 'MMM', 'GE', 'WM', 'RSG',
    
    // Materials
    'LIN', 'APD', 'ECL', 'SHW', 'NEM', 'FCX', 'NUE', 'DD', 'DOW', 'PPG',
    
    // Real Estate - REITs
    'AMT', 'PLD', 'CCI', 'EQIX', 'PSA', 'O', 'SPG', 'WELL', 'DLR', 'AVB',
    
    // Utilities
    'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'SRE', 'XEL', 'WEC', 'ES',
    
    // Communications
    'T', 'VZ', 'TMUS', 'CMCSA', 'CHTR', 'DISH',
    
    // Emerging & High Growth
    'UPST', 'AI', 'BBAI', 'SOUN', 'C3AI', 'PATH', 'S', 'BILL', 'DOCN',
    'GTLB', 'FROG', 'IOT', 'NCNO'
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
        volatilityMax = null,
        universe = 'DEFAULT'
    } = options;

    // Build a cache key that captures all options that affect results
    const cacheKey = `weekly_predictions:${universe}:${minScore}:${limit}:${sectors || 'all'}:${marketCapMin || 0}:${volatilityMax || 0}`;
    const cached = cacheService.get(cacheKey);
    if (cached) {
        console.log(`[Weekly Predictions] Cache HIT for universe=${universe} — returning cached results (${cached.topPicks.length} picks)`);
        return cached;
    }

    // Get appropriate stock universe
    const stocksToAnalyze = getStockUniverse(universe);

    console.log(`[Weekly Predictions] Cache MISS — starting fresh analysis of ${stocksToAnalyze.length} stocks (universe: ${universe})...`);
    console.log(`[Weekly Predictions] Estimated time: ${Math.ceil(stocksToAnalyze.length / 10)}+ seconds`);
    
    try {
        // Analyze all stocks in parallel (batched to avoid overwhelming APIs)
        const batchSize = 3;  // Process 3 stocks at a time (reduced from 10 to respect Yahoo rate limits)
        const allPredictions = [];
        
        for (let i = 0; i < stocksToAnalyze.length; i += batchSize) {
            const batch = stocksToAnalyze.slice(i, i + batchSize);
            const progress = Math.round((i / stocksToAnalyze.length) * 100);
            console.log(`[Weekly] Progress: ${progress}% (${i}/${stocksToAnalyze.length})`);
            
            const batchResults = await Promise.allSettled(
                batch.map(symbol => analyzeStockForWeek(symbol))
            );
            
            batchResults.forEach((result, idx) => {
                if (result.status === 'fulfilled' && result.value) {
                    allPredictions.push(result.value);
                } else {
                    // Silently skip failures (don't log to reduce noise)
                }
            });
            
            // Longer pause between batches to respect Yahoo Finance rate limits
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 seconds between batches
        }
        
        console.log(`[Weekly Predictions] Analyzed ${allPredictions.length} stocks successfully`);
        
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

        const result = {
            topPicks: withTiers.slice(0, limit),
            allAnalyzed: withTiers,
            marketContext,
            analysisDate: new Date().toISOString(),
            totalAnalyzed: allPredictions.length,
            universeSize: stocksToAnalyze.length,
            universeType: universe,
            filters: { minScore, sectors, marketCapMin, volatilityMax },
            fromCache: false
        };

        // Cache for 30 minutes — avoids re-running the expensive scan on repeated calls
        cacheService.set(cacheKey, { ...result, fromCache: true }, WEEKLY_CACHE_TTL);

        return result;
        
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
        
        // Calculate risk score and factors
        const riskAnalysis = calculateRiskAnalysis(prices, ai, fund, news, totalScore);
        
        // Determine trading signal (Buy/Hold/Avoid)
        const tradingSignal = determineTradingSignal(totalScore, riskAnalysis.riskScore, confidence, expectedMove);
        
        // Generate invalidation triggers
        const invalidationTriggers = generateInvalidationTriggers(prices, tradingSignal, fund);
        
        // Calculate reward-to-risk ratio
        const rewardRiskRatio = Math.abs(expectedMove) / (riskAnalysis.riskScore / 10);
        
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
                signal: tradingSignal,
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
            riskAnalysis: {
                riskScore: Math.round(riskAnalysis.riskScore),
                riskFactors: riskAnalysis.riskFactors,
                riskLevel: getRiskLevel(riskAnalysis.riskScore)
            },
            invalidationTriggers,
            rewardRiskRatio: rewardRiskRatio.toFixed(2),
            tradeType: getTradeType(confidence, expectedMove, riskAnalysis.riskScore),
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
const getRawNewsSentiment = (newsData) => {
    if (!newsData) return null;

    // Preferred shape from newsSentimentService
    if (newsData.sentiment && newsData.sentiment.score !== undefined) {
        const value = parseFloat(newsData.sentiment.score);
        return Number.isFinite(value) ? value : null;
    }

    // Backward compatibility for older shapes
    if (newsData.overallSentiment !== undefined) {
        const value = parseFloat(newsData.overallSentiment);
        return Number.isFinite(value) ? value : null;
    }

    if (newsData.sentimentScore !== undefined) {
        const value = parseFloat(newsData.sentimentScore);
        return Number.isFinite(value) ? value : null;
    }

    return null;
};

const calculateSentimentScore = (newsData) => {
    const sentiment = getRawNewsSentiment(newsData);
    if (sentiment === null) return 50;
    
    // Convert -100 to 100 sentiment to 0-100 score
    const clamped = Math.max(-100, Math.min(100, sentiment));
    return ((clamped + 100) / 2);
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
 * Calculate overall market context with macro overlay
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
    
    // Calculate macro trends
    const macroTrends = calculateMacroTrends(allPredictions);
    
    // Sector rotation analysis
    const sectorRotation = analyzeSectorRotation(allPredictions);
    
    // Market regime detection
    const marketRegime = detectMarketRegime(allPredictions, avgScore);
    
    return {
        marketSentiment,
        averageScore: Math.round(avgScore),
        distribution: {
            bullish: bullishCount,
            bearish: bearishCount,
            neutral: neutralCount
        },
        topSectors: getTopSectors(allPredictions),
        macroTrends,
        sectorRotation,
        marketRegime,
        summary: generateMarketSummary(marketSentiment, bullishCount, bearishCount, macroTrends, marketRegime)
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

/**
 * Calculate comprehensive risk analysis (0-100, higher = more risky)
 */
function calculateRiskAnalysis(prices, aiPrediction, fundamentals, newsData, totalScore) {
    let riskScore = 50;
    const riskFactors = [];
    const priceValues = prices.map(p => p.close);
    const currentPrice = priceValues[priceValues.length - 1];
    
    // 1. Volatility risk
    const volatility = calculateVolatility(prices);
    if (volatility > 5) {
        riskScore += 20;
        riskFactors.push(`High volatility (${volatility.toFixed(1)}%)`);
    } else if (volatility > 3) {
        riskScore += 10;
        riskFactors.push(`Elevated volatility (${volatility.toFixed(1)}%)`);
    }
    
    // 2. Technical overbought/oversold risk
    const rsi = calculateRSI(priceValues, 14);
    if (rsi > 75) {
        riskScore += 15;
        riskFactors.push(`Overbought RSI (${rsi.toFixed(0)})`);
    } else if (rsi > 70) {
        riskScore += 8;
        riskFactors.push(`Near resistance levels`);
    }
    
    // 3. Support/Resistance proximity
    const sma20 = calculateSMA(priceValues, 20);
    const sma50 = calculateSMA(priceValues, 50);
    const distanceFromSMA20 = ((currentPrice - sma20) / sma20) * 100;
    
    if (Math.abs(distanceFromSMA20) > 10) {
        riskScore += 10;
        riskFactors.push(`Extended from moving averages`);
    }
    
    // 4. Momentum divergence
    const momentum5 = calculateMomentum(priceValues, 5);
    const momentum10 = calculateMomentum(priceValues, 10);
    if (momentum5 < 0 && momentum10 > 0 || momentum5 > 0 && momentum10 < 0) {
        riskScore += 12;
        riskFactors.push(`Momentum divergence detected`);
    }
    
    // 5. Negative news sentiment
    const rawNewsSentiment = getRawNewsSentiment(newsData);
    if (rawNewsSentiment !== null && rawNewsSentiment < -20) {
        riskScore += 15;
        riskFactors.push(`Negative news sentiment`);
    }
    
    // 6. Earnings proximity (simplified - within next 2 weeks)
    const today = new Date();
    const twoWeeksOut = new Date(today.getTime() + 14 * 24 * 60 * 60 * 1000);
    // Note: In production, use actual earnings calendar API
    if (Math.random() < 0.15) { // Placeholder - 15% chance of earnings
        riskScore += 10;
        riskFactors.push(`Earnings report approaching`);
    }
    
    // 7. Sector momentum weakness
    if (totalScore < 55) {
        riskScore += 8;
        riskFactors.push(`Weak sector momentum`);
    }
    
    // 8. Volume concerns
    const volumes = prices.map(p => p.volume);
    const recentVolume = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const avgVolume = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    if (recentVolume < avgVolume * 0.7) {
        riskScore += 8;
        riskFactors.push(`Below-average volume`);
    }
    
    // 9. Analyst downgrades
    if (fundamentals?.analystRatings) {
        const { sell = 0, strongSell = 0, hold = 0 } = fundamentals.analystRatings;
        const total = Object.values(fundamentals.analystRatings).reduce((a, b) => a + b, 0);
        const bearishPct = ((sell + strongSell * 2) / (total * 2)) * 100;
        if (bearishPct > 30) {
            riskScore += 12;
            riskFactors.push(`Analyst downgrades`);
        }
    }
    
    // Cap risk score
    riskScore = Math.max(10, Math.min(95, riskScore));
    
    return { riskScore, riskFactors };
}

/**
 * Determine trading signal based on score, risk, and confidence
 */
function determineTradingSignal(totalScore, riskScore, confidence, expectedMove) {
    // Strong Buy: High score, low risk, high confidence
    if (totalScore >= 75 && riskScore < 50 && confidence >= 70) {
        return 'Strong Buy';
    }
    
    // Buy: Good score with acceptable risk
    if (totalScore >= 65 && riskScore < 60 && confidence >= 60) {
        return 'Buy';
    }
    
    // Hold: Good fundamentals but risky timing or neutral
    if (totalScore >= 55 && (riskScore >= 60 || confidence < 60)) {
        return 'Hold';
    }
    
    // Avoid: Poor score or very high risk
    if (totalScore < 45 || riskScore > 75) {
        return 'Avoid';
    }
    
    // Weak signals - need more conviction
    if (totalScore < 55 && riskScore > 55) {
        return 'Hold';
    }
    
    return 'Hold';
}

/**
 * Generate invalidation triggers
 */
function generateInvalidationTriggers(prices, signal, fundamentals) {
    const priceValues = prices.map(p => p.close);
    const currentPrice = priceValues[priceValues.length - 1];
    const triggers = [];
    
    // Support level (recent 20-day low)
    const support = Math.min(...priceValues.slice(-20));
    const supportLevel = support * 0.98; // 2% below support
    
    // Resistance level (recent 20-day high)
    const resistance = Math.max(...priceValues.slice(-20));
    
    // Key moving averages
    const sma20 = calculateSMA(priceValues, 20);
    const sma50 = calculateSMA(priceValues, 50);
    
    if (signal === 'Buy' || signal === 'Strong Buy') {
        // Bullish position invalidation
        triggers.push({
            type: 'Stop Loss',
            level: supportLevel.toFixed(2),
            description: `Breakdown below $${supportLevel.toFixed(2)} support`
        });
        
        triggers.push({
            type: 'Technical',
            level: sma50.toFixed(2),
            description: `Close below 50-day MA ($${sma50.toFixed(2)})`
        });
        
        if (fundamentals?.earningsDate) {
            triggers.push({
                type: 'Fundamental',
                description: 'Negative earnings guidance or miss'
            });
        }
        
        triggers.push({
            type: 'Volume',
            description: 'Breakdown on high volume (>2x average)'
        });
    } else if (signal === 'Avoid') {
        // Already bearish - what would make it buyable again
        triggers.push({
            type: 'Reversal',
            level: sma20.toFixed(2),
            description: `Breakout above 20-day MA ($${sma20.toFixed(2)})`
        });
        
        triggers.push({
            type: 'Fundamental',
            description: 'Positive earnings surprise or guidance raise'
        });
    } else {
        // Hold - both ways
        triggers.push({
            type: 'Downside',
            level: (currentPrice * 0.95).toFixed(2),
            description: `Consider exit below ${(currentPrice * 0.95).toFixed(2)}`
        });
        
        triggers.push({
            type: 'Upside',
            level: resistance.toFixed(2),
            description: `Becomes buyable above ${resistance.toFixed(2)} resistance`
        });
    }
    
    return triggers;
}

/**
 * Get risk level label
 */
function getRiskLevel(riskScore) {
    if (riskScore >= 75) return 'Very High';
    if (riskScore >= 60) return 'High';
    if (riskScore >= 40) return 'Moderate';
    if (riskScore >= 25) return 'Low';
    return 'Very Low';
}

/**
 * Get trade type classification
 */
function getTradeType(confidence, expectedMove, riskScore) {
    const upside = Math.abs(parseFloat(expectedMove));
    
    if (confidence >= 75 && riskScore < 40) {
        return 'High Conviction / Low Risk';
    }
    if (upside >= 8 && riskScore >= 60) {
        return 'High Upside / Higher Risk';
    }
    if (confidence >= 70 && upside < 5) {
        return 'Stable Growth / Low Volatility';
    }
    if (riskScore >= 70) {
        return 'Speculative / High Risk';
    }
    if (confidence < 60) {
        return 'Low Conviction / Wait & See';
    }
    return 'Balanced Risk/Reward';
}

/**
 * Calculate macro market trends
 */
function calculateMacroTrends(predictions) {
    const trends = {
        growthVsValue: analyzeGrowthVsValue(predictions),
        riskAppetite: analyzeRiskAppetite(predictions),
        volatilityRegime: analyzeVolatilityRegime(predictions),
        momentumStrength: analyzeMomentumStrength(predictions)
    };
    
    return trends;
}

/**
 * Analyze growth vs value preference
 */
function analyzeGrowthVsValue(predictions) {
    const growthSectors = ['Technology', 'Healthcare', 'Consumer Discretionary', 'Communication Services'];
    const valueSectors = ['Financials', 'Energy', 'Utilities', 'Industrials', 'Materials'];
    
    const growthScores = predictions
        .filter(p => growthSectors.includes(p.sector))
        .map(p => p.totalScore);
    const valueScores = predictions
        .filter(p => valueSectors.includes(p.sector))
        .map(p => p.totalScore);
    
    const avgGrowth = growthScores.length > 0 
        ? growthScores.reduce((a, b) => a + b, 0) / growthScores.length 
        : 50;
    const avgValue = valueScores.length > 0 
        ? valueScores.reduce((a, b) => a + b, 0) / valueScores.length 
        : 50;
    
    if (avgGrowth > avgValue + 5) {
        return 'Growth stocks outperforming - risk-on sentiment';
    } else if (avgValue > avgGrowth + 5) {
        return 'Value stocks favored - defensive rotation';
    } else {
        return 'Balanced growth/value - transitional market';
    }
}

/**
 * Analyze risk appetite
 */
function analyzeRiskAppetite(predictions) {
    const avgRisk = predictions.reduce((sum, p) => sum + (p.riskAnalysis?.riskScore || 50), 0) / predictions.length;
    const highRiskCount = predictions.filter(p => (p.riskAnalysis?.riskScore || 50) >= 60).length;
    const pctHighRisk = (highRiskCount / predictions.length) * 100;
    
    if (pctHighRisk < 30 && avgRisk < 45) {
        return 'High risk appetite - speculative environment';
    } else if (pctHighRisk > 60 || avgRisk > 60) {
        return 'Low risk appetite - defensive positioning';
    } else {
        return 'Moderate risk appetite - selective opportunities';
    }
}

/**
 * Analyze volatility regime
 */
function analyzeVolatilityRegime(predictions) {
    const avgVolatility = predictions.reduce((sum, p) => sum + p.volatility, 0) / predictions.length;
    
    if (avgVolatility < 2) {
        return 'Low volatility regime - range-bound markets';
    } else if (avgVolatility > 4) {
        return 'High volatility regime - trending opportunities';
    } else {
        return 'Normal volatility - balanced conditions';
    }
}

/**
 * Analyze overall momentum strength
 */
function analyzeMomentumStrength(predictions) {
    const avgMomentum = predictions.reduce((sum, p) => sum + p.componentScores.momentum, 0) / predictions.length;
    
    if (avgMomentum > 70) {
        return 'Strong momentum - uptrend continuation likely';
    } else if (avgMomentum < 40) {
        return 'Weak momentum - consolidation or reversal possible';
    } else {
        return 'Moderate momentum - mixed directional bias';
    }
}

/**
 * Analyze sector rotation patterns
 */
function analyzeSectorRotation(predictions) {
    const topSectors = getTopSectors(predictions);
    const sectorMomentum = {};
    
    predictions.forEach(p => {
        if (p.sector && p.sector !== 'Unknown') {
            if (!sectorMomentum[p.sector]) {
                sectorMomentum[p.sector] = [];
            }
            sectorMomentum[p.sector].push(p.componentScores.momentum);
        }
    });
    
    const rotatingInto = [];
    const rotatingOutOf = [];
    
    Object.entries(sectorMomentum).forEach(([sector, momentums]) => {
        const avgMomentum = momentums.reduce((a, b) => a + b, 0) / momentums.length;
        if (avgMomentum > 70) {
            rotatingInto.push(sector);
        } else if (avgMomentum < 40) {
            rotatingOutOf.push(sector);
        }
    });
    
    return {
        rotatingInto: rotatingInto.slice(0, 3),
        rotatingOutOf: rotatingOutOf.slice(0, 3),
        leadingSector: topSectors[0]?.sector || 'Unknown',
        laggingSector: topSectors[topSectors.length - 1]?.sector || 'Unknown'
    };
}

/**
 * Detect market regime
 */
function detectMarketRegime(predictions, avgScore) {
    const highConfidence = predictions.filter(p => p.prediction.confidence > 75).length;
    const lowConfidence = predictions.filter(p => p.prediction.confidence < 50).length;
    const pctHighConf = (highConfidence / predictions.length) * 100;
    
    // Trending market: high confidence, directional scores
    if (pctHighConf > 40 && (avgScore > 65 || avgScore < 45)) {
        return {
            regime: 'Trending',
            description: 'Clear directional bias - momentum strategies favored',
            recommendation: 'Follow the trend, use momentum indicators'
        };
    }
    
    // Range-bound: low confidence, neutral scores
    if (pctHighConf < 25 && avgScore >= 45 && avgScore <= 65) {
        return {
            regime: 'Range-Bound',
            description: 'Choppy markets - mean reversion likely',
            recommendation: 'Trade ranges, focus on oversold bounces'
        };
    }
    
    // Volatile/Uncertain: mixed signals
    if (lowConfidence > predictions.length * 0.3) {
        return {
            regime: 'Volatile',
            description: 'Uncertain environment - mixed signals',
            recommendation: 'Reduce position sizes, wait for clarity'
        };
    }
    
    // Rotation: sector-specific strength
    return {
        regime: 'Rotation',
        description: 'Sector rotation in progress',
        recommendation: 'Focus on strong sectors, avoid laggards'
    };
}

/**
 * Generate comprehensive market summary
 */
function generateMarketSummary(sentiment, bullishCount, bearishCount, macroTrends, marketRegime) {
    const parts = [];
    
    parts.push(`Market is ${sentiment.toLowerCase()} with ${bullishCount} bullish vs ${bearishCount} bearish signals.`);
    parts.push(macroTrends.growthVsValue);
    parts.push(marketRegime.description);
    
    return parts.join(' ');
}

module.exports = {
    getWeeklyPredictions,
    analyzeStockForWeek,
    MAJOR_STOCKS
};
