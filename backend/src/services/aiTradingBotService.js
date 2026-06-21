const dataProvider = require('./dataProvider');
const brokerService = require('./brokerService');
const tradingServiceDB = require('./tradingServiceDB');
const tradingAccountService = require('./tradingAccountService');
const portfolioTrackingService = require('./portfolioTrackingService');
const userProfileService = require('./userProfileService');
const { query } = require('../config/database');
const { getNewsSentiment } = require('./newsSentimentService');
const precomputedUniverseService = require('./precomputedUniverseService');

/**
 * AI Trading Bot Service
 * Automatically manages portfolio based on AI analysis and market signals
 */

// Top stock picks with growth potential
const AI_RECOMMENDED_STOCKS = [
    { symbol: 'AAPL', weight: 0.15, sector: 'Technology' },
    { symbol: 'MSFT', weight: 0.15, sector: 'Technology' },
    { symbol: 'GOOGL', weight: 0.12, sector: 'Technology' },
    { symbol: 'NVDA', weight: 0.10, sector: 'Technology' },
    { symbol: 'AMZN', weight: 0.10, sector: 'E-commerce' },
    { symbol: 'TSLA', weight: 0.08, sector: 'Automotive' },
    { symbol: 'META', weight: 0.08, sector: 'Social Media' },
    { symbol: 'AMD', weight: 0.07, sector: 'Technology' },
    { symbol: 'NFLX', weight: 0.08, sector: 'Entertainment' },
    { symbol: 'JPM', weight: 0.07, sector: 'Financial' }
];

// Trading strategy parameters
// Default trading strategy parameters
const DEFAULT_STRATEGY_CONFIG = {
    minCashReserve: 0.20, // Keep 20% cash reserve (was 10% — tighter safety buffer)
    maxPositionSize: 0.10, // Max 10% per stock (was 20% — prevents single-stock overexposure)
    rebalanceThreshold: 0.05,
    stopLoss: -0.07,      // Sell at -7% loss (was -15% — now matches Alpaca stop level)
    takeProfit: 0.20,     // Take profit at 20% gain (was 30% — lock in wins sooner)
    volatilityThreshold: 0.25,
    maxOpenPositions: 4,  // Never hold more than 4 positions simultaneously
    maxOrderNotional: 500 // Hard cap: max $500 per single trade
};

// Helper to get user-specific AI trading settings
async function getUserStrategyConfig(userId) {
    try {
        const settings = await userProfileService.getAITradingSettings(userId);
        return {
            ...DEFAULT_STRATEGY_CONFIG,
            ...settings
        };
    } catch (err) {
        console.error('Error getting user strategy config:', err);
        return DEFAULT_STRATEGY_CONFIG;
    }
}

/**
 * Convert a news sentiment score (-100..+100) into a rawScore impact (-0.4..+0.4).
 * Boosted when X posts confirm the direction with high confidence,
 * and when analyst consensus aligns.
 */
function calcNewsSentimentImpact(sentimentData) {
    if (!sentimentData || !sentimentData.sentiment) return 0;

    const score = parseFloat(sentimentData.sentiment.score) || 0;
    // Base impact: map -100..+100 → -0.4..+0.4
    let impact = (score / 100) * 0.4;

    // Boost when analyst consensus matches direction
    const consensus = sentimentData.analystRatings?.consensus;
    if (consensus === 'Strong Buy' && impact > 0) impact *= 1.25;
    else if (consensus === 'Buy' && impact > 0) impact *= 1.1;
    else if (consensus === 'Sell' && impact < 0) impact *= 1.25;

    // Extra boost when X/social posts confirm with high confidence
    const xCount = sentimentData.meta?.xPostCount || 0;
    const confidence = sentimentData.sentiment.confidence;
    if (xCount >= 3 && confidence === 'High') impact *= 1.15;
    else if (xCount >= 1 && confidence === 'Medium') impact *= 1.05;

    return Math.max(-0.4, Math.min(0.4, impact));
}

/**
 * Analyze stock and generate AI recommendation.
 * Combines price momentum, volume, VIX, and news/X sentiment.
 */
async function analyzeStock(symbol, vixData = null, preloadedSentiment = null) {
    try {
        const q = await dataProvider.getQuote(symbol);

        if (!q || !q.price) {
            return null;
        }

        const currentPrice = q.price;
        const change = q.changePercent || 0; // already in percent (e.g. 2.34 = +2.34%)
        const volume = q.volume || 0;
        const avgVolume = q.avgVolume || volume;

        // Momentum score — penalise stocks already up >3% (overextended, chase risk)
        // Reward early movers (+0.5 to +2%), neutral on flat, negative on down
        const momentumScore = change > 4  ? -0.3 // overextended — gap-chase risk
                            : change > 2  ? 0.6
                            : change > 0.5 ? 1.0  // sweet spot: early momentum
                            : change > 0   ? 0.3
                            : change > -2  ? -0.4
                            : -1.0;

        // Volume score (higher volume = more interest and liquidity)
        const volumeRatio = volume / avgVolume;
        const volumeScore = volumeRatio > 1.5 ? 1 : volumeRatio > 1.2 ? 0.8 : volumeRatio > 0.8 ? 0.5 : 0.3;

        // VIX impact: if VIX is high, reduce buy confidence more aggressively
        let vixImpact = 0;
        if (vixData) {
            if (vixData.price > 30) {
                vixImpact = -0.4; // Very high volatility, strong sell signal
            } else if (vixData.price > 25) {
                vixImpact = -0.3; // High volatility, moderate sell signal
            } else if (vixData.price > 20) {
                vixImpact = -0.15; // Elevated volatility, slight caution
            } else if (vixData.price < 15) {
                vixImpact = 0.1; // Low volatility, slight buy boost
            }
        }

        // --- News + X sentiment impact ---
        let sentimentData = preloadedSentiment || null;
        let newsSentimentImpact = 0;
        try {
            if (!sentimentData) {
                sentimentData = await getNewsSentiment(symbol);
            }
            newsSentimentImpact = calcNewsSentimentImpact(sentimentData);
        } catch (e) {
            console.warn(`[AI Bot] News sentiment unavailable for ${symbol}: ${e.message}`);
        }

        // Overall AI score: momentum 40% + volume 20% + news 25% + VIX up to ±0.4
        // Formula keeps rawScore in roughly -1.5..+1.5; clamp to 0-100 aiScore
        const rawScore = (momentumScore * 0.40) + (volumeScore * 0.20) + newsSentimentImpact + vixImpact;
        const aiScore = Math.round(Math.max(0, Math.min(100, (rawScore + 1) * 50)));

        // Enhanced chart signal with better thresholds
        let chartSignal = 'HOLD';
        if (aiScore > 70 && (!vixData || vixData.price <= 20)) {
            chartSignal = 'STRONG BUY';
        } else if (aiScore > 60 && (!vixData || vixData.price <= 25)) {
            chartSignal = 'BUY';
        } else if (aiScore < 30 || (vixData && vixData.price > 30)) {
            chartSignal = 'STRONG SELL';
        } else if (aiScore < 40 || (vixData && vixData.price > 25)) {
            chartSignal = 'SELL';
        }

        // Better recommendation logic
        let recommendation = 'HOLD';
        if (aiScore > 70) {
            recommendation = 'STRONG BUY';
        } else if (aiScore > 60) {
            recommendation = 'BUY';
        } else if (aiScore < 30) {
            recommendation = 'STRONG SELL';
        } else if (aiScore < 40) {
            recommendation = 'SELL';
        }

        // Build sentiment summary for response
        const newsSentiment = sentimentData ? {
            score: sentimentData.sentiment?.score ?? 0,
            label: sentimentData.sentiment?.label ?? 'Neutral',
            confidence: sentimentData.sentiment?.confidence ?? 'Low',
            xPostCount: sentimentData.meta?.xPostCount || 0,
            articleCount: sentimentData.meta?.articleCount || 0,
            sources: sentimentData.meta?.sourceBreakdown || {}
        } : null;

        return {
            symbol,
            price: currentPrice,
            change,
            volume,
            volumeRatio: volumeRatio.toFixed(2),
            aiScore,
            vixImpact: vixImpact.toFixed(2),
            vix: vixData ? vixData.price : null,
            newsSentimentImpact: newsSentimentImpact.toFixed(3),
            newsSentiment,
            recommendation,
            chartSignal,
            confidence: Math.abs(aiScore - 50) / 50 * 100,
            buyStrength: aiScore > 50 ? ((aiScore - 50) / 50 * 100).toFixed(1) : 0,
            sellStrength: aiScore < 50 ? ((50 - aiScore) / 50 * 100).toFixed(1) : 0,
            timestamp: new Date()
        };
    } catch (error) {
        console.error(`Error analyzing ${symbol}:`, error.message);
        return null;
    }
}

/**
 * Generate AI-powered portfolio allocation.
 * Uses nightly scan results instead of hardcoded stock list.
 * Pre-fetches news sentiment for all candidate stocks in parallel.
 */
async function generatePortfolioAllocation(userId, availableBalance) {
    const allocations = [];
    const strategyConfig = await getUserStrategyConfig(userId);
    const investmentAmount = availableBalance * (1 - strategyConfig.minCashReserve);

    // Check if nightly scan results are available
    const hasPrecomputedData = await precomputedUniverseService.isAvailable(5);

    let candidateStocks;
    if (hasPrecomputedData) {
        // Use nightly scan results (STRONG BUY/BUY stocks with score >= 75)
        candidateStocks = await precomputedUniverseService.loadCandidates({
            minScore: 75,
            limit: 20
        });
        console.log(`[AI Bot] Using ${candidateStocks.length} stocks from nightly scan`);
    } else {
        // Fallback to hardcoded list if nightly scan not available
        candidateStocks = AI_RECOMMENDED_STOCKS.map(s => ({
            symbol: s.symbol,
            sector: s.sector,
            weight: s.weight,
            _precomputedScore: 75
        }));
        console.log(`[AI Bot] Nightly scan unavailable, using ${candidateStocks.length} fallback stocks`);
    }

    // Pre-fetch sentiment for all candidate symbols in parallel
    const symbols = candidateStocks.map(s => s.symbol);
    const sentimentMap = {};
    const sentimentResults = await Promise.allSettled(symbols.map(sym => getNewsSentiment(sym)));
    sentimentResults.forEach((res, i) => {
        sentimentMap[symbols[i]] = res.status === 'fulfilled' ? res.value : null;
    });

    // Calculate dynamic weights based on AI scores from nightly scan
    const totalScore = candidateStocks.reduce((sum, stock) => sum + (stock._precomputedScore || 75), 0);

    for (const stock of candidateStocks) {
        const analysis = await analyzeStock(stock.symbol, null, sentimentMap[stock.symbol]);

        // Only buy on high-conviction signals (score ≥ 70, not just 60)
        if (analysis && analysis.recommendation === 'STRONG BUY' && analysis.aiScore >= 70) {
            // Cap order notional: smaller of formula amount or hard $500 cap
            const scoreWeight = (stock._precomputedScore || 75) / totalScore;
            const dynamicWeight = Math.min(scoreWeight, strategyConfig.maxPositionSize);
            const formulaAmount = investmentAmount * dynamicWeight;
            const cappedAmount = Math.min(formulaAmount, strategyConfig.maxOrderNotional || 500);
            const shares = Math.floor(cappedAmount / analysis.price);

            if (shares > 0) {
                allocations.push({
                    symbol: stock.symbol,
                    targetShares: shares,
                    targetValue: shares * analysis.price,
                    currentPrice: analysis.price,
                    aiScore: analysis.aiScore,
                    recommendation: analysis.recommendation,
                    chartSignal: analysis.chartSignal,
                    buyStrength: analysis.buyStrength,
                    newsSentiment: analysis.newsSentiment,
                    newsSentimentImpact: analysis.newsSentimentImpact,
                    sector: stock.sector,
                    weight: dynamicWeight,
                    precomputedScore: stock._precomputedScore
                });
            }
        }
    }

    return allocations;
}

/**
 * Execute initial portfolio setup
 */
async function initializeAIPortfolio(userId) {
    try {
        // Get current account balance
        const account = await tradingAccountService.getTradingAccount(userId);
        const availableBalance = account.balance;
        
        if (availableBalance < 100) {
            throw new Error('Insufficient balance. Minimum $100 required for AI trading.');
        }
        
        // Generate AI allocation
        const allocations = await generatePortfolioAllocation(userId, availableBalance);
        
        const executedTrades = [];
        const failedTrades = [];
        
        // Execute buy orders
        for (const allocation of allocations) {
            try {
                const result = await executeLegacyAIBuyOrder(
                    userId,
                    allocation.symbol,
                    allocation.targetShares,
                    allocation.aiScore,
                    allocation.sector
                );
                
                executedTrades.push({
                    symbol: allocation.symbol,
                    shares: allocation.targetShares,
                    price: result.price,
                    total: result.total,
                    aiScore: allocation.aiScore,
                    sector: allocation.sector
                });
            } catch (error) {
                failedTrades.push({
                    symbol: allocation.symbol,
                    error: error.message
                });
            }
        }
        
        return {
            success: true,
            message: 'AI portfolio initialized successfully',
            executedTrades,
            failedTrades,
            totalInvested: executedTrades.reduce((sum, t) => sum + t.total, 0),
            diversification: {
                stocks: executedTrades.length,
                sectors: [...new Set(executedTrades.map(t => t.sector))].length
            }
        };
    } catch (error) {
        throw new Error(`AI portfolio initialization failed: ${error.message}`);
    }
}

/**
 * Rebalance portfolio based on AI recommendations.
 * Pre-fetches sentiment for all held symbols in parallel.
 */
async function rebalancePortfolio(userId) {
    try {
        // Get current portfolio
        const portfolio = await portfolioTrackingService.getPortfolioSummary(userId);
        const account = await tradingAccountService.getTradingAccount(userId);
        
        const strategyConfig = await getUserStrategyConfig(userId);
        const currentHoldings = portfolio.holdings || [];
        const totalValue = portfolio.totalPortfolioValue || 0;

        if (totalValue === 0) {
            return await initializeAIPortfolio(userId);
        }

        // Get current target stocks from nightly scan
        const hasPrecomputedData = await precomputedUniverseService.isAvailable(5);
        let candidateStocks = [];
        let targetWeightMap = {};

        if (hasPrecomputedData) {
            candidateStocks = await precomputedUniverseService.loadCandidates({
                minScore: 70,
                limit: 30
            });
            // Calculate dynamic weights based on precomputed scores
            const totalScore = candidateStocks.reduce((sum, stock) => sum + (stock._precomputedScore || 75), 0);
            candidateStocks.forEach(stock => {
                const scoreWeight = (stock._precomputedScore || 75) / totalScore;
                targetWeightMap[stock.symbol] = Math.min(scoreWeight, strategyConfig.maxPositionSize);
            });
        } else {
            // Fallback to hardcoded weights
            AI_RECOMMENDED_STOCKS.forEach(stock => {
                targetWeightMap[stock.symbol] = stock.weight;
            });
        }

        // Pre-fetch sentiment for all held symbols in parallel
        const heldSymbols = currentHoldings.map(h => h.symbol);
        const sentimentMap = {};
        const sentimentResults = await Promise.allSettled(heldSymbols.map(sym => getNewsSentiment(sym)));
        sentimentResults.forEach((res, i) => {
            sentimentMap[heldSymbols[i]] = res.status === 'fulfilled' ? res.value : null;
        });

        const rebalanceActions = [];

        // Check each holding for rebalancing needs
        for (const holding of currentHoldings) {
            const analysis = await analyzeStock(holding.symbol, null, sentimentMap[holding.symbol]);

            if (!analysis) continue;

            // Calculate current position percentage
            const currentWeight = (holding.marketValue || 0) / totalValue;
            const targetWeight = targetWeightMap[holding.symbol] || 0;

            // Check stop loss
            const profitLossPercent = holding.unrealizedPLPercent || 0;
            if (profitLossPercent <= strategyConfig.stopLoss * 100) {
                // Sell entire position (stop loss triggered)
                rebalanceActions.push({
                    action: 'SELL',
                    symbol: holding.symbol,
                    quantity: holding.quantity,
                    reason: 'Stop Loss Triggered',
                    currentPL: profitLossPercent
                });
                continue;
            }

            // Check take profit - Sell entire position to lock in gains
            if (profitLossPercent >= strategyConfig.takeProfit * 100) {
                // Sell entire position to maximize profit taking
                rebalanceActions.push({
                    action: 'SELL',
                    symbol: holding.symbol,
                    quantity: holding.quantity,
                    reason: `Take Profit Target Reached (${profitLossPercent.toFixed(2)}% gain)`,
                    currentPL: profitLossPercent,
                    targetProfit: strategyConfig.takeProfit * 100
                });
                continue;
            }
            
            // Check partial profit taking at 15% gain (before full take profit)
            if (profitLossPercent >= 15 && profitLossPercent < strategyConfig.takeProfit * 100) {
                // Sell 40% of position to lock in some gains while keeping upside
                const sellQuantity = Math.floor(holding.quantity * 0.4);
                if (sellQuantity > 0) {
                    rebalanceActions.push({
                        action: 'SELL',
                        symbol: holding.symbol,
                        quantity: sellQuantity,
                        reason: `Partial Profit Taking (${profitLossPercent.toFixed(2)}% gain)`,
                        currentPL: profitLossPercent
                    });
                }
                continue;
            }

            // --- News/X sentiment emergency sell ---
            // If news sentiment is Very Negative with high confidence and AI score is bearish, sell half
            const sent = analysis.newsSentiment;
            const sentScore = parseFloat(sent?.score || 0);
            if (sent && sentScore <= -30 && sent.confidence === 'High' && analysis.aiScore < 40) {
                const sellQuantity = Math.floor(holding.quantity * 0.5);
                if (sellQuantity > 0) {
                    rebalanceActions.push({
                        action: 'SELL',
                        symbol: holding.symbol,
                        quantity: sellQuantity,
                        reason: `News Sentiment Alert: ${sent.label} (score ${sentScore}, ${sent.xPostCount} X posts)`,
                        aiScore: analysis.aiScore,
                        newsSentiment: sent.label
                    });
                    continue;
                }
            }

            // Check if position needs rebalancing
            const weightDrift = Math.abs(currentWeight - targetWeight);
            if (weightDrift > strategyConfig.rebalanceThreshold) {
                if (currentWeight > targetWeight) {
                    // Reduce position
                    const targetValue = totalValue * targetWeight;
                    const currentValue = holding.marketValue || 0;
                    const reduceValue = currentValue - targetValue;
                    const sellQuantity = Math.floor(reduceValue / holding.currentPrice);

                    if (sellQuantity > 0) {
                        rebalanceActions.push({
                            action: 'SELL',
                            symbol: holding.symbol,
                            quantity: sellQuantity,
                            reason: 'Rebalance - Reduce Overweight Position'
                        });
                    }
                } else {
                    // Increase position
                    const targetValue = totalValue * targetWeight;
                    const currentValue = holding.marketValue || 0;
                    const increaseValue = targetValue - currentValue;
                    const buyQuantity = Math.floor(increaseValue / holding.currentPrice);

                    if (buyQuantity > 0 && account.balance >= increaseValue) {
                        rebalanceActions.push({
                            action: 'BUY',
                            symbol: holding.symbol,
                            quantity: buyQuantity,
                            reason: 'Rebalance - Increase Underweight Position'
                        });
                    }
                }
            }

            // AI recommendation override
            if (analysis.recommendation === 'SELL' && analysis.confidence > 70) {
                rebalanceActions.push({
                    action: 'SELL',
                    symbol: holding.symbol,
                    quantity: holding.quantity,
                    reason: `AI Strong Sell Signal (score ${analysis.aiScore}/100, news: ${analysis.newsSentiment?.label || 'N/A'})`,
                    aiScore: analysis.aiScore
                });
            }
        }
        
        // Execute rebalancing actions
        const executedActions = [];
        let openPositionCount = currentHoldings.length;
        const maxPositions = strategyConfig.maxOpenPositions || 4;

        for (const action of rebalanceActions) {
            // Hard cap: never open new positions beyond maxOpenPositions
            if (action.action === 'BUY' && openPositionCount >= maxPositions) {
                executedActions.push({ ...action, executed: false, error: `Position cap reached (${openPositionCount}/${maxPositions})` });
                continue;
            }
            try {
                let result;
                if (action.action === 'BUY') {
                    result = await executeLegacyAIBuyOrder(userId, action.symbol, action.quantity, action.aiScore || null, action.sector || null);
                    openPositionCount++;
                } else {
                    result = await executeLegacyAISellOrder(userId, action.symbol, action.quantity, action.reason || null);
                    openPositionCount = Math.max(0, openPositionCount - 1);
                }
                
                executedActions.push({
                    ...action,
                    executed: true,
                    price: result.price,
                    total: result.total
                });
            } catch (error) {
                executedActions.push({
                    ...action,
                    executed: false,
                    error: error.message
                });
            }
        }
        
        return {
            success: true,
            message: 'Portfolio rebalanced by AI',
            actions: executedActions,
            timestamp: new Date()
        };
    } catch (error) {
        throw new Error(`Portfolio rebalancing failed: ${error.message}`);
    }
}

/**
 * Get AI trading recommendations using nightly scan results
 */
async function getAIRecommendations(userId) {
    try {
        const recommendations = [];
        const strategyConfig = await getUserStrategyConfig(userId);

        // Check if nightly scan results are available
        const hasPrecomputedData = await precomputedUniverseService.isAvailable(5);

        let candidateStocks;
        if (hasPrecomputedData) {
            // Use nightly scan results
            candidateStocks = await precomputedUniverseService.loadCandidates({
                minScore: 70,
                limit: 30
            });
            console.log(`[AI Recommendations] Using ${candidateStocks.length} stocks from nightly scan`);
        } else {
            // Fallback to hardcoded list
            candidateStocks = AI_RECOMMENDED_STOCKS.map(s => ({
                symbol: s.symbol,
                sector: s.sector,
                weight: s.weight,
                _precomputedScore: 75
            }));
            console.log(`[AI Recommendations] Nightly scan unavailable, using ${candidateStocks.length} fallback stocks`);
        }

        // Calculate total score for dynamic weight calculation
        const totalScore = candidateStocks.reduce((sum, stock) => sum + (stock._precomputedScore || 75), 0);

        for (const stock of candidateStocks) {
            const analysis = await analyzeStock(stock.symbol);
            if (analysis) {
                // Dynamic weight based on precomputed score
                const scoreWeight = (stock._precomputedScore || 75) / totalScore;
                const dynamicWeight = Math.min(scoreWeight, strategyConfig.maxPositionSize);

                recommendations.push({
                    ...analysis,
                    targetWeight: dynamicWeight,
                    sector: stock.sector,
                    precomputedScore: stock._precomputedScore,
                    sourceData: hasPrecomputedData ? 'nightly_scan' : 'fallback_list'
                });
            }
        }

        // Sort by AI score (highest first)
        recommendations.sort((a, b) => b.aiScore - a.aiScore);

        return {
            recommendations,
            strategy: {
                minCashReserve: strategyConfig.minCashReserve * 100 + '%',
                maxPositionSize: strategyConfig.maxPositionSize * 100 + '%',
                stopLoss: strategyConfig.stopLoss * 100 + '%',
                takeProfit: strategyConfig.takeProfit * 100 + '%'
            },
            dataSource: hasPrecomputedData ? 'nightly_scan' : 'fallback_list',
            candidatesAnalyzed: candidateStocks.length,
            timestamp: new Date()
        };
    } catch (error) {
        throw new Error(`Failed to generate AI recommendations: ${error.message}`);
    }
}

/**
 * Get AI portfolio status
 */
async function getAIPortfolioStatus(userId) {
    try {
        const portfolio = await portfolioTrackingService.getPortfolioSummary(userId);
        const account = await tradingAccountService.getTradingAccount(userId);
        const recommendations = await getAIRecommendations(userId);
        
        const totalValue = portfolio.totalPortfolioValue || 0;
        const cashReserve = account.balance;
        const investedValue = totalValue - cashReserve;
        
        return {
            totalValue,
            cashReserve,
            cashReservePercent: totalValue > 0 ? (cashReserve / totalValue * 100).toFixed(2) : 0,
            investedValue,
            investedPercent: totalValue > 0 ? (investedValue / totalValue * 100).toFixed(2) : 0,
            holdings: portfolio.holdings?.length || 0,
            totalReturn: portfolio.totalReturnPercent || 0,
            unrealizedPL: portfolio.totalUnrealizedPL || 0,
            realizedPL: portfolio.totalRealizedPL || 0,
            topRecommendations: recommendations.recommendations.slice(0, 5),
            strategy: recommendations.strategy,
            lastUpdate: new Date()
        };
    } catch (error) {
        throw new Error(`Failed to get AI portfolio status: ${error.message}`);
    }
}

async function executeLegacyAIBuyOrder(userId, symbol, quantity, aiScore = null, sector = null) {
    const result = await brokerService.buyMarket(userId, symbol.toUpperCase(), quantity, {
        executedBy: 'AI_BOT',
        aiScore,
        sector
    });

    return {
        price: result.filledAvgPrice,
        total: result.total ?? ((result.filledAvgPrice || 0) * quantity),
        broker: result.broker,
        orderId: result.orderId,
        status: result.status
    };
}

async function executeLegacyAISellOrder(userId, symbol, quantity, reason = null) {
    const result = await brokerService.sellMarket(userId, symbol.toUpperCase(), quantity, {
        executedBy: 'AI_BOT',
        reason: reason || 'Legacy AI sell order'
    });

    return {
        price: result.filledAvgPrice,
        total: result.total ?? ((result.filledAvgPrice || 0) * quantity),
        broker: result.broker,
        orderId: result.orderId,
        status: result.status
    };
}

module.exports = {
    initializeAIPortfolio,
    rebalancePortfolio,
    getAIRecommendations,
    getAIPortfolioStatus,
    analyzeStock
};
