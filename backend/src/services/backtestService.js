const fs = require('fs').promises;
const path = require('path');

const USERS_FILE = path.join(__dirname, '../../users.json');

/**
 * AI Trading Backtest Service
 * Analyze historical AI bot performance using actual trade data
 */

/**
 * Get all trades for a user (both manual and AI trades)
 */
async function getUserTrades(userId) {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);
        
        if (!user || !user.trades) {
            return [];
        }
        
        return user.trades;
    } catch (error) {
        console.error('[Backtest] Error reading trades:', error);
        return [];
    }
}

/**
 * Get current portfolio holdings
 */
async function getPortfolioHoldings(userId) {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);
        
        if (!user || !user.portfolio) {
            return [];
        }
        
        return user.portfolio;
    } catch (error) {
        console.error('[Backtest] Error reading portfolio:', error);
        return [];
    }
}

/**
 * Calculate performance metrics from trade pairs (BUY/SELL)
 */
function calculatePerformanceMetrics(trades) {
    // Group trades by symbol to match BUY with SELL
    const tradesBySymbol = {};
    
    trades.forEach(trade => {
        if (!tradesBySymbol[trade.symbol]) {
            tradesBySymbol[trade.symbol] = [];
        }
        tradesBySymbol[trade.symbol].push(trade);
    });
    
    const completedTrades = [];
    
    // Match BUY and SELL trades
    Object.keys(tradesBySymbol).forEach(symbol => {
        const symbolTrades = tradesBySymbol[symbol].sort((a, b) => 
            new Date(a.timestamp) - new Date(b.timestamp)
        );
        
        const buyTrades = symbolTrades.filter(t => t.type === 'BUY');
        const sellTrades = symbolTrades.filter(t => t.type === 'SELL');
        
        // Match each sell with corresponding buy
        sellTrades.forEach(sell => {
            const matchingBuy = buyTrades.find(buy => buy.quantity >= sell.quantity);
            if (matchingBuy) {
                const profitLoss = (sell.price - matchingBuy.price) * sell.quantity;
                const returnPercent = ((sell.price - matchingBuy.price) / matchingBuy.price) * 100;
                
                completedTrades.push({
                    symbol,
                    buyPrice: matchingBuy.price,
                    sellPrice: sell.price,
                    quantity: sell.quantity,
                    profitLoss,
                    returnPercent,
                    buyDate: matchingBuy.timestamp,
                    sellDate: sell.timestamp,
                    holdDays: Math.floor((new Date(sell.timestamp) - new Date(matchingBuy.timestamp)) / (1000 * 60 * 60 * 24))
                });
            }
        });
    });
    
    if (completedTrades.length === 0) {
        return {
            totalDecisions: trades.length,
            totalTrades: 0,
            wins: 0,
            losses: 0,
            winRate: '0.00',
            avgWin: '0.00',
            avgLoss: '0.00',
            totalProfitLoss: '0.00',
            profitFactor: '0.00',
            sharpeRatio: '0.00',
            maxDrawdown: '0.00',
            avgHoldDays: 0,
            completedTrades: []
        };
    }
    
    // Win/Loss analysis
    const wins = completedTrades.filter(t => t.profitLoss > 0);
    const losses = completedTrades.filter(t => t.profitLoss <= 0);
    
    const winRate = (wins.length / completedTrades.length) * 100;
    
    // Average returns
    const avgWin = wins.length > 0 
        ? wins.reduce((sum, t) => sum + t.returnPercent, 0) / wins.length 
        : 0;
    const avgLoss = losses.length > 0 
        ? losses.reduce((sum, t) => sum + t.returnPercent, 0) / losses.length 
        : 0;
    
    // Total P/L
    const totalProfitLoss = completedTrades.reduce((sum, t) => sum + t.profitLoss, 0);
    
    // Profit factor
    const totalWins = wins.reduce((sum, t) => sum + t.profitLoss, 0);
    const totalLosses = Math.abs(losses.reduce((sum, t) => sum + t.profitLoss, 0));
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 0;
    
    // Sharpe ratio
    const avgReturn = completedTrades.reduce((sum, t) => sum + t.returnPercent, 0) / completedTrades.length;
    const variance = completedTrades.reduce((sum, t) => 
        sum + Math.pow(t.returnPercent - avgReturn, 2), 0
    ) / completedTrades.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) : 0;
    
    // Max drawdown
    let peak = 0;
    let maxDrawdown = 0;
    let runningTotal = 0;
    
    completedTrades.forEach(t => {
        runningTotal += t.profitLoss;
        if (runningTotal > peak) {
            peak = runningTotal;
        }
        const drawdown = peak > 0 ? ((peak - runningTotal) / peak) * 100 : 0;
        if (drawdown > maxDrawdown) {
            maxDrawdown = drawdown;
        }
    });
    
    // Average hold time
    const avgHoldDays = completedTrades.reduce((sum, t) => sum + t.holdDays, 0) / completedTrades.length;
    
    return {
        totalDecisions: trades.length,
        totalTrades: completedTrades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: winRate.toFixed(2),
        avgWin: avgWin.toFixed(2),
        avgLoss: avgLoss.toFixed(2),
        totalProfitLoss: totalProfitLoss.toFixed(2),
        profitFactor: profitFactor.toFixed(2),
        sharpeRatio: sharpeRatio.toFixed(2),
        maxDrawdown: maxDrawdown.toFixed(2),
        avgHoldDays: avgHoldDays.toFixed(1),
        completedTrades
    };
}

/**
 * Analyze by symbol
 */
function analyzeBySymbol(completedTrades) {
    const symbolStats = {};
    
    completedTrades.forEach(trade => {
        if (!symbolStats[trade.symbol]) {
            symbolStats[trade.symbol] = {
                symbol: trade.symbol,
                trades: 0,
                wins: 0,
                losses: 0,
                totalReturn: 0,
                totalProfitLoss: 0
            };
        }
        
        symbolStats[trade.symbol].trades++;
        if (trade.profitLoss > 0) {
            symbolStats[trade.symbol].wins++;
        } else {
            symbolStats[trade.symbol].losses++;
        }
        symbolStats[trade.symbol].totalReturn += trade.returnPercent;
        symbolStats[trade.symbol].totalProfitLoss += trade.profitLoss;
    });
    
    // Convert to array and sort by profit/loss
    const symbols = Object.values(symbolStats)
        .map(s => ({
            ...s,
            winRate: s.trades > 0 ? ((s.wins / s.trades) * 100).toFixed(2) : 0,
            avgReturn: s.trades > 0 ? (s.totalReturn / s.trades).toFixed(2) : 0
        }))
        .sort((a, b) => b.totalProfitLoss - a.totalProfitLoss);
    
    return symbols;
}

/**
 * Generate equity curve
 */
function generateEquityCurve(completedTrades) {
    const curve = [];
    let equity = 0;
    
    // Sort by sell date
    const sortedTrades = [...completedTrades].sort((a, b) => 
        new Date(a.sellDate) - new Date(b.sellDate)
    );
    
    sortedTrades.forEach(trade => {
        equity += trade.profitLoss;
        curve.push({
            date: trade.sellDate,
            equity: equity,
            return: trade.returnPercent,
            symbol: trade.symbol
        });
    });
    
    return curve;
}

/**
 * Get backtest report
 */
async function getBacktestReport(userId) {
    try {
        const trades = await getUserTrades(userId);
        const portfolio = await getPortfolioHoldings(userId);
        
        if (trades.length === 0) {
            return {
                message: 'No trading history found. Execute some trades to see backtest results.',
                hasData: false
            };
        }
        
        const metrics = calculatePerformanceMetrics(trades);
        
        // If no completed trades (only buys, no sells yet)
        if (metrics.totalTrades === 0) {
            return {
                message: `You have ${trades.filter(t => t.type === 'BUY').length} open positions. Sell some positions to see completed trade performance.`,
                hasData: false,
                openPositions: portfolio.length,
                totalTrades: trades.length
            };
        }
        
        const symbolAnalysis = analyzeBySymbol(metrics.completedTrades);
        const equityCurve = generateEquityCurve(metrics.completedTrades);
        
        // Best and worst trades
        const sortedTrades = [...metrics.completedTrades].sort((a, b) => b.profitLoss - a.profitLoss);
        const bestTrades = sortedTrades.slice(0, 5).map(t => ({
            symbol: t.symbol,
            profitLoss: t.profitLoss,
            return: t.returnPercent,
            buyPrice: t.buyPrice,
            sellPrice: t.sellPrice,
            quantity: t.quantity,
            date: t.sellDate
        }));
        const worstTrades = sortedTrades.slice(-5).reverse().map(t => ({
            symbol: t.symbol,
            profitLoss: t.profitLoss,
            return: t.returnPercent,
            buyPrice: t.buyPrice,
            sellPrice: t.sellPrice,
            quantity: t.quantity,
            date: t.sellDate
        }));
        
        return {
            hasData: true,
            metrics,
            symbolPerformance: symbolAnalysis,
            equityCurve,
            bestTrades,
            worstTrades,
            totalTrades: trades.length,
            completedTrades: metrics.totalTrades,
            openPositions: portfolio.length,
            firstTrade: trades[trades.length - 1]?.timestamp,
            lastTrade: trades[0]?.timestamp
        };
    } catch (error) {
        console.error('[Backtest] Error generating report:', error);
        throw error;
    }
}

module.exports = {
    getBacktestReport,
    getUserTrades,
    calculatePerformanceMetrics
};
