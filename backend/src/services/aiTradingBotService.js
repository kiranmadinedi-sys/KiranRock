const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const tradingService = require('./tradingService');
const tradingAccountService = require('./tradingAccountService');
const portfolioTrackingService = require('./portfolioTrackingService');

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
    minCashReserve: 0.10, // Keep 10% in cash
    maxPositionSize: 0.20, // Max 20% in single stock
    rebalanceThreshold: 0.05, // Rebalance if position drifts 5%
    stopLoss: -0.15, // Sell if position loses 15%
    takeProfit: 0.30, // Consider taking profit at 30% gain
    volatilityThreshold: 0.25 // Reduce position if volatility > 25%
};

const fs = require('fs').promises;
const path = require('path');
const USERS_FILE = path.join(__dirname, '../../users.json');

// Helper to get user-specific AI trading settings
async function getUserStrategyConfig(userId) {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);
        if (user && user.aiTradingSettings) {
            return {
                ...DEFAULT_STRATEGY_CONFIG,
                ...user.aiTradingSettings
            };
        }
        return DEFAULT_STRATEGY_CONFIG;
    } catch (err) {
        return DEFAULT_STRATEGY_CONFIG;
    }
}

/**
 * Analyze stock and generate AI recommendation
 */
async function analyzeStock(symbol, vixData = null) {
    try {
        // Use quoteSummary instead of quote
        const result = await yahooFinance.quoteSummary(symbol, {
            modules: ['price', 'summaryDetail']
        });
        
        if (!result || !result.price || !result.price.regularMarketPrice) {
            return null;
        }

        const currentPrice = result.price.regularMarketPrice;
        const change = result.price.regularMarketChangePercent || 0;
        const volume = result.price.regularMarketVolume || 0;
        const avgVolume = result.summaryDetail?.averageDailyVolume10Day || volume;

        // Enhanced momentum score with better weighting
        const momentumScore = change > 2 ? 1 : change > 0.5 ? 0.7 : change > 0 ? 0.4 : change > -2 ? -0.3 : -1;

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

        // Overall AI score (0-100) with better signal weighting
        const rawScore = (momentumScore * 0.5) + (volumeScore * 0.3) + vixImpact;
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

        return {
            symbol,
            price: currentPrice,
            change,
            volume,
            volumeRatio: volumeRatio.toFixed(2),
            aiScore,
            vixImpact: vixImpact.toFixed(2),
            vix: vixData ? vixData.price : null,
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
 * Generate AI-powered portfolio allocation
 */
async function generatePortfolioAllocation(userId, availableBalance) {
    const allocations = [];
    const strategyConfig = await getUserStrategyConfig(userId);
    const investmentAmount = availableBalance * (1 - strategyConfig.minCashReserve);

    for (const stock of AI_RECOMMENDED_STOCKS) {
        const analysis = await analyzeStock(stock.symbol);

        // Only buy stocks with strong signals (BUY or STRONG BUY)
        if (analysis && (analysis.recommendation === 'BUY' || analysis.recommendation === 'STRONG BUY') && analysis.aiScore >= 60) {
            const targetAmount = investmentAmount * stock.weight;
            const shares = Math.floor(targetAmount / analysis.price);

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
                    sector: stock.sector,
                    weight: stock.weight
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
                const result = await tradingService.executeBuyOrder(
                    userId,
                    allocation.symbol,
                    allocation.targetShares
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
 * Rebalance portfolio based on AI recommendations
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

        const rebalanceActions = [];

        // Check each holding for rebalancing needs
        for (const holding of currentHoldings) {
            const analysis = await analyzeStock(holding.symbol);

            if (!analysis) continue;

            // Calculate current position percentage
            const currentWeight = (holding.marketValue || 0) / totalValue;
            const targetStock = AI_RECOMMENDED_STOCKS.find(s => s.symbol === holding.symbol);
            const targetWeight = targetStock ? targetStock.weight : 0;

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
                    reason: `AI Strong Sell Signal (${analysis.aiScore}/100)`,
                    aiScore: analysis.aiScore
                });
            }
        }
        
        // Execute rebalancing actions
        const executedActions = [];
        for (const action of rebalanceActions) {
            try {
                let result;
                if (action.action === 'BUY') {
                    result = await tradingService.executeBuyOrder(userId, action.symbol, action.quantity);
                } else {
                    result = await tradingService.executeSellOrder(userId, action.symbol, action.quantity);
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
 * Get AI trading recommendations
 */
async function getAIRecommendations(userId) {
    try {
        const recommendations = [];
        
        const strategyConfig = await getUserStrategyConfig(userId);
        for (const stock of AI_RECOMMENDED_STOCKS) {
            const analysis = await analyzeStock(stock.symbol);
            if (analysis) {
                recommendations.push({
                    ...analysis,
                    targetWeight: stock.weight,
                    sector: stock.sector
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

module.exports = {
    initializeAIPortfolio,
    rebalancePortfolio,
    getAIRecommendations,
    getAIPortfolioStatus,
    analyzeStock
};
