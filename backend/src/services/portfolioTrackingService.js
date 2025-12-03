const tradingService = require('./tradingService');
const tradingAccountService = require('./tradingAccountService');

/**
 * Get complete portfolio with real-time valuations
 */
const getPortfolioSummary = async (userId) => {
    try {
        const [holdings, account, trades] = await Promise.all([
            tradingService.getHoldings(userId),
            tradingAccountService.getTradingAccount(userId),
            tradingService.getTradeHistory(userId, 1000)
        ]);
        
        // Get current prices for all holdings
        const holdingsWithCurrentPrice = await Promise.all(
            holdings.map(async (holding) => {
                try {
                    const currentPrice = await tradingService.getCurrentPrice(holding.symbol);
                    const currentValue = currentPrice * holding.quantity;
                    const costBasis = holding.averagePrice * holding.quantity;
                    const unrealizedPL = currentValue - costBasis;
                    const unrealizedPLPercent = (unrealizedPL / costBasis) * 100;
                    
                    return {
                        ...holding,
                        currentPrice,
                        currentValue,
                        costBasis,
                        unrealizedPL,
                        unrealizedPLPercent
                    };
                } catch (error) {
                    console.error(`Error getting price for ${holding.symbol}:`, error.message);
                    return {
                        ...holding,
                        currentPrice: holding.averagePrice,
                        currentValue: holding.averagePrice * holding.quantity,
                        costBasis: holding.averagePrice * holding.quantity,
                        unrealizedPL: 0,
                        unrealizedPLPercent: 0,
                        priceError: true
                    };
                }
            })
        );
        
        // Calculate totals
        const totalCurrentValue = holdingsWithCurrentPrice.reduce((sum, h) => sum + h.currentValue, 0);
        const totalCostBasis = holdingsWithCurrentPrice.reduce((sum, h) => sum + h.costBasis, 0);
        const totalUnrealizedPL = totalCurrentValue - totalCostBasis;
        const totalUnrealizedPLPercent = totalCostBasis > 0 ? (totalUnrealizedPL / totalCostBasis) * 100 : 0;
        
        // Calculate realized P/L from closed trades
        const sellTrades = trades.filter(t => t.type === 'SELL');
        const totalRealizedPL = sellTrades.reduce((sum, t) => sum + (t.profitLoss || 0), 0);
        
        // Total portfolio value
        const totalPortfolioValue = account.balance + totalCurrentValue;
        
        // Total invested (deposits - withdrawals)
        const totalInvested = account.totalDeposited - account.totalWithdrawn;
        
        // Overall return
        const overallPL = totalPortfolioValue - totalInvested;
        const overallReturn = totalInvested > 0 ? (overallPL / totalInvested) * 100 : 0;
        
        return {
            account: {
                cashBalance: account.balance,
                totalDeposited: account.totalDeposited,
                totalWithdrawn: account.totalWithdrawn
            },
            holdings: holdingsWithCurrentPrice,
            summary: {
                totalHoldingsValue: totalCurrentValue,
                totalCostBasis,
                totalUnrealizedPL,
                totalUnrealizedPLPercent,
                totalRealizedPL,
                totalPortfolioValue,
                totalInvested,
                overallPL,
                overallReturn,
                numberOfPositions: holdings.length,
                cashBalance: account.balance
            }
        };
    } catch (error) {
        console.error('Error getting portfolio summary:', error);
        throw error;
    }
};

/**
 * Get performance analytics
 */
const getPerformanceAnalytics = async (userId) => {
    try {
        const trades = await tradingService.getTradeHistory(userId, 10000);
        
        if (trades.length === 0) {
            return {
                totalTrades: 0,
                winRate: 0,
                averageWin: 0,
                averageLoss: 0,
                largestWin: null,
                largestLoss: null,
                profitFactor: 0,
                bestPerformingStock: null,
                worstPerformingStock: null
            };
        }
        
        const sellTrades = trades.filter(t => t.type === 'SELL');
        
        if (sellTrades.length === 0) {
            return {
                totalTrades: trades.length,
                buyOrders: trades.filter(t => t.type === 'BUY').length,
                sellOrders: 0,
                message: 'No sell trades yet to calculate performance'
            };
        }
        
        // Win/Loss analysis
        const winningTrades = sellTrades.filter(t => t.profitLoss > 0);
        const losingTrades = sellTrades.filter(t => t.profitLoss < 0);
        
        const winRate = (winningTrades.length / sellTrades.length) * 100;
        
        const totalWins = winningTrades.reduce((sum, t) => sum + t.profitLoss, 0);
        const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + t.profitLoss, 0));
        
        const averageWin = winningTrades.length > 0 ? totalWins / winningTrades.length : 0;
        const averageLoss = losingTrades.length > 0 ? totalLosses / losingTrades.length : 0;
        
        // Find largest win/loss
        const largestWin = winningTrades.length > 0 
            ? winningTrades.reduce((max, t) => t.profitLoss > max.profitLoss ? t : max)
            : null;
            
        const largestLoss = losingTrades.length > 0
            ? losingTrades.reduce((min, t) => t.profitLoss < min.profitLoss ? t : min)
            : null;
        
        // Profit factor
        const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 0;
        
        // Performance by stock
        const stockPerformance = {};
        sellTrades.forEach(trade => {
            if (!stockPerformance[trade.symbol]) {
                stockPerformance[trade.symbol] = {
                    symbol: trade.symbol,
                    trades: 0,
                    totalPL: 0,
                    wins: 0,
                    losses: 0
                };
            }
            stockPerformance[trade.symbol].trades++;
            stockPerformance[trade.symbol].totalPL += trade.profitLoss;
            if (trade.profitLoss > 0) stockPerformance[trade.symbol].wins++;
            else if (trade.profitLoss < 0) stockPerformance[trade.symbol].losses++;
        });
        
        const stockPerfArray = Object.values(stockPerformance);
        const bestPerformingStock = stockPerfArray.length > 0
            ? stockPerfArray.reduce((max, s) => s.totalPL > max.totalPL ? s : max)
            : null;
            
        const worstPerformingStock = stockPerfArray.length > 0
            ? stockPerfArray.reduce((min, s) => s.totalPL < min.totalPL ? s : min)
            : null;
        
        // Trading frequency
        const firstTrade = trades[trades.length - 1];
        const lastTrade = trades[0];
        const daysBetween = (new Date(lastTrade.timestamp) - new Date(firstTrade.timestamp)) / (1000 * 60 * 60 * 24);
        const tradesPerDay = daysBetween > 0 ? trades.length / daysBetween : 0;
        
        return {
            totalTrades: trades.length,
            buyOrders: trades.filter(t => t.type === 'BUY').length,
            sellOrders: sellTrades.length,
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length,
            winRate: Math.round(winRate * 100) / 100,
            averageWin: Math.round(averageWin * 100) / 100,
            averageLoss: Math.round(averageLoss * 100) / 100,
            largestWin,
            largestLoss,
            profitFactor: Math.round(profitFactor * 100) / 100,
            totalWins,
            totalLosses,
            netProfit: totalWins - totalLosses,
            bestPerformingStock,
            worstPerformingStock,
            stockPerformance: stockPerfArray.sort((a, b) => b.totalPL - a.totalPL),
            tradingFrequency: {
                totalDays: Math.round(daysBetween),
                tradesPerDay: Math.round(tradesPerDay * 100) / 100
            }
        };
    } catch (error) {
        console.error('Error getting performance analytics:', error);
        throw error;
    }
};

/**
 * Get sector allocation from current holdings
 */
const getSectorAllocation = async (userId) => {
    try {
        const holdings = await tradingService.getHoldings(userId);
        
        if (holdings.length === 0) {
            return [];
        }
        
        // This would ideally fetch sector info from fundamentals
        // For now, we'll return a simple structure
        const sectorMap = {};
        
        for (const holding of holdings) {
            const currentPrice = await tradingService.getCurrentPrice(holding.symbol).catch(() => holding.averagePrice);
            const value = currentPrice * holding.quantity;
            
            // You can enhance this by fetching actual sector from fundamentalsService
            const sector = 'Unknown'; // Placeholder
            
            if (!sectorMap[sector]) {
                sectorMap[sector] = {
                    sector,
                    value: 0,
                    stocks: []
                };
            }
            
            sectorMap[sector].value += value;
            sectorMap[sector].stocks.push(holding.symbol);
        }
        
        const sectors = Object.values(sectorMap);
        const totalValue = sectors.reduce((sum, s) => sum + s.value, 0);
        
        return sectors.map(s => ({
            ...s,
            percentage: (s.value / totalValue) * 100
        })).sort((a, b) => b.value - a.value);
        
    } catch (error) {
        console.error('Error getting sector allocation:', error);
        throw error;
    }
};

/**
 * Get risk metrics
 */
const getRiskMetrics = async (userId) => {
    try {
        const holdings = await tradingService.getHoldings(userId);
        const account = await tradingAccountService.getTradingAccount(userId);
        
        if (holdings.length === 0) {
            return {
                diversificationScore: 100,
                message: 'No holdings - fully diversified (all cash)'
            };
        }
        
        // Calculate position sizes
        const totalValue = account.balance + holdings.reduce((sum, h) => 
            sum + (h.quantity * h.averagePrice), 0
        );
        
        const positionSizes = holdings.map(h => {
            const value = h.quantity * h.averagePrice;
            return {
                symbol: h.symbol,
                value,
                percentage: (value / totalValue) * 100
            };
        });
        
        // Diversification score (100 = perfect, lower = concentrated)
        const largestPosition = Math.max(...positionSizes.map(p => p.percentage));
        const diversificationScore = Math.max(0, 100 - (largestPosition * 2));
        
        // Concentration risk
        const top3Concentration = positionSizes
            .sort((a, b) => b.percentage - a.percentage)
            .slice(0, 3)
            .reduce((sum, p) => sum + p.percentage, 0);
        
        return {
            diversificationScore: Math.round(diversificationScore),
            numberOfPositions: holdings.length,
            largestPosition: {
                symbol: positionSizes.reduce((max, p) => p.percentage > max.percentage ? p : max).symbol,
                percentage: Math.round(largestPosition * 100) / 100
            },
            top3Concentration: Math.round(top3Concentration * 100) / 100,
            cashPercentage: Math.round((account.balance / totalValue) * 10000) / 100,
            positionSizes: positionSizes.sort((a, b) => b.percentage - a.percentage)
        };
    } catch (error) {
        console.error('Error getting risk metrics:', error);
        throw error;
    }
};

/**
 * Get portfolio value history for charting
 */
const getPortfolioHistory = async (userId, range = '1D') => {
    // For demo: generate fake data based on current portfolio value
    // In production, use actual historical data from trades and prices
    const summary = await getPortfolioSummary(userId);
    const now = Date.now();
    let points = [];
    let intervals = 1;
    if (range === '1D') intervals = 24;
    else if (range === '1W') intervals = 7;
    else if (range === '1M') intervals = 30;
    else if (range === '3M') intervals = 12;
    else if (range === 'YTD') intervals = 10;
    else if (range === '1Y') intervals = 12;
    for (let i = intervals - 1; i >= 0; i--) {
        points.push({
            time: new Date(now - i * 3600 * 1000).toLocaleString(),
            value: summary.summary.totalPortfolioValue * (1 + (Math.random() - 0.5) * 0.02)
        });
    }
    // Calculate change
    const changeValue = points[points.length - 1].value - points[0].value;
    const changePercent = (changeValue / points[0].value) * 100;
    return { history: points, changeValue, changePercent };
};

module.exports = {
    getPortfolioSummary,
    getPerformanceAnalytics,
    getSectorAllocation,
    getRiskMetrics,
    getPortfolioHistory
};
