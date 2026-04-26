/**
 * AI Trading Backtest Service
 * Analyze historical AI bot performance using actual PostgreSQL trade data
 */

const { query } = require('../config/database');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

/**
 * Get all trades for a user from PostgreSQL
 */
async function getUserTrades(userId) {
    try {
        const result = await query(
            `SELECT id, symbol, action, quantity, price, total, commission,
                    executed_by, ai_score, sector, trade_date AS timestamp
             FROM trades
             WHERE user_id = $1
             ORDER BY trade_date ASC`,
            [userId]
        );
        // Normalize field names to match old JSON schema expected by calculatePerformanceMetrics
        return result.rows.map(r => ({
            ...r,
            type: r.action,      // calculatePerformanceMetrics uses t.type
            quantity: parseInt(r.quantity),
            price: parseFloat(r.price)
        }));
    } catch (error) {
        console.error('[Backtest] Error reading trades from DB:', error);
        return [];
    }
}

/**
 * Get current portfolio holdings from PostgreSQL
 */
async function getPortfolioHoldings(userId) {
    try {
        const result = await query(
            `SELECT symbol, quantity, average_price, current_price, market_value,
                    gain_loss, gain_loss_percent, sector
             FROM holdings
             WHERE user_id = $1 AND quantity > 0
             ORDER BY symbol`,
            [userId]
        );
        return result.rows;
    } catch (error) {
        console.error('[Backtest] Error reading holdings from DB:', error);
        return [];
    }
}

/**
 * Fetch SPY returns over a date range for benchmark comparison
 */
async function getSPYBenchmarkReturn(startDate, endDate) {
    try {
        const chart = await yahooFinance.chart('SPY', {
            period1: new Date(startDate).toISOString().split('T')[0],
            period2: new Date(endDate).toISOString().split('T')[0],
            interval: '1d'
        });
        const closes = chart.quotes.map(q => q.close).filter(Boolean);
        if (closes.length < 2) return null;
        const totalReturn = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
        return parseFloat(totalReturn.toFixed(2));
    } catch {
        return null;
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
            symbol: t.symbol, profitLoss: t.profitLoss, return: t.returnPercent,
            buyPrice: t.buyPrice, sellPrice: t.sellPrice, quantity: t.quantity, date: t.sellDate
        }));
        const worstTrades = sortedTrades.slice(-5).reverse().map(t => ({
            symbol: t.symbol, profitLoss: t.profitLoss, return: t.returnPercent,
            buyPrice: t.buyPrice, sellPrice: t.sellPrice, quantity: t.quantity, date: t.sellDate
        }));

        // --- Calmar Ratio ---
        // Calmar = Annualized Return / Max Drawdown
        // Estimate annualized return from equity curve
        const firstDate = metrics.completedTrades[0]?.buyDate;
        const lastDate = metrics.completedTrades[metrics.completedTrades.length - 1]?.sellDate;
        const holdingDays = firstDate && lastDate
            ? Math.max(1, Math.ceil((new Date(lastDate) - new Date(firstDate)) / (1000 * 60 * 60 * 24)))
            : 365;
        const totalReturn = parseFloat(metrics.totalProfitLoss);
        const annualizedReturn = totalReturn * (365 / holdingDays);
        const maxDrawdownVal = parseFloat(metrics.maxDrawdown);
        const calmarRatio = maxDrawdownVal > 0
            ? parseFloat((annualizedReturn / maxDrawdownVal).toFixed(3))
            : null;

        // --- SPY Benchmark Comparison ---
        const spyReturn = firstDate && lastDate
            ? await getSPYBenchmarkReturn(firstDate, lastDate)
            : null;

        const enhancedMetrics = {
            ...metrics,
            calmarRatio,
            annualizedReturn: parseFloat(annualizedReturn.toFixed(2)),
            holdingPeriodDays: holdingDays,
            spyBenchmarkReturn: spyReturn,
            alphVsSPY: spyReturn !== null
                ? parseFloat(((totalReturn / holdingDays * 365) - spyReturn).toFixed(2))
                : null
        };

        return {
            hasData: true,
            metrics: enhancedMetrics,
            symbolPerformance: symbolAnalysis,
            equityCurve,
            bestTrades,
            worstTrades,
            totalTrades: trades.length,
            completedTrades: metrics.totalTrades,
            openPositions: portfolio.length,
            firstTrade: firstDate,
            lastTrade: lastDate
        };
    } catch (error) {
        console.error('[Backtest] Error generating report:', error);
        throw error;
    }
}

/**
 * Get Options Bot backtest report
 * Analyzes performance from options_trades table
 */
async function getOptionsBacktestReport(userId, filters = {}) {
    try {
        const { query } = require('../config/database');
        const { dateRange = 'all', strategy = 'all' } = filters;
        
        // Build WHERE clause based on filters
        let whereClause = 'WHERE user_id = $1 AND status = $2';
        const params = [userId, 'CLOSED'];
        
        // Add date range filter
        if (dateRange !== 'all') {
            const daysAgo = {
                '1m': 30,
                '3m': 90,
                '6m': 180,
                '1y': 365
            }[dateRange];
            whereClause += ` AND exit_date >= NOW() - INTERVAL '${daysAgo} days'`;
        }
        
        // Add strategy filter
        if (strategy !== 'all') {
            params.push(strategy);
            whereClause += ` AND strategy = $${params.length}`;
        }
        
        // Get completed options trades
        const tradesResult = await query(
            `SELECT * FROM options_trades ${whereClause} ORDER BY exit_date DESC`,
            params
        );
        
        const trades = tradesResult.rows;
        
        if (trades.length === 0) {
            return {
                hasData: false,
                message: 'No completed options trades found. Enable Options Bot and wait for trades to complete.'
            };
        }
        
        // Calculate metrics
        const wins = trades.filter(t => t.profit_loss > 0).length;
        const losses = trades.filter(t => t.profit_loss < 0).length;
        const totalPnL = trades.reduce((sum, t) => sum + parseFloat(t.profit_loss || 0), 0);
        const totalWinAmount = trades.filter(t => t.profit_loss > 0).reduce((sum, t) => sum + parseFloat(t.profit_loss), 0);
        const totalLossAmount = Math.abs(trades.filter(t => t.profit_loss < 0).reduce((sum, t) => sum + parseFloat(t.profit_loss), 0));
        
        const winRate = wins / trades.length * 100;
        const avgWin = wins > 0 ? totalWinAmount / wins : 0;
        const avgLoss = losses > 0 ? totalLossAmount / losses : 0;
        const profitFactor = totalLossAmount > 0 ? totalWinAmount / totalLossAmount : 0;
        
        // Calculate hold times
        const holdTimes = trades.map(t => {
            const entry = new Date(t.entry_date);
            const exit = new Date(t.exit_date);
            return (exit - entry) / (1000 * 60 * 60 * 24);
        });
        const avgHoldDays = holdTimes.reduce((sum, d) => sum + d, 0) / holdTimes.length;
        
        // Calculate consecutive losses
        let maxConsecutiveLosses = 0;
        let currentStreak = 0;
        trades.forEach(t => {
            if (t.profit_loss < 0) {
                currentStreak++;
                maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentStreak);
            } else {
                currentStreak = 0;
            }
        });
        
        // Calculate Sharpe ratio (simplified)
        const returns = trades.map(t => parseFloat(t.profit_loss || 0));
        const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
        const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
        const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;
        
        // Calculate max drawdown
        let peak = 0;
        let maxDrawdown = 0;
        let runningPnL = 0;
        trades.forEach(t => {
            runningPnL += parseFloat(t.profit_loss || 0);
            peak = Math.max(peak, runningPnL);
            const drawdown = ((peak - runningPnL) / peak) * 100;
            maxDrawdown = Math.max(maxDrawdown, drawdown);
        });
        
        // Equity curve
        const equityCurve = [];
        let equity = 10000; // Starting capital
        trades.reverse().forEach(t => {
            equity += parseFloat(t.profit_loss || 0);
            equityCurve.push({
                date: t.exit_date,
                equity: equity
            });
        });
        
        // Symbol performance
        const symbolMap = {};
        trades.forEach(t => {
            if (!symbolMap[t.symbol]) {
                symbolMap[t.symbol] = { trades: 0, wins: 0, losses: 0, totalPnL: 0 };
            }
            symbolMap[t.symbol].trades++;
            if (t.profit_loss > 0) symbolMap[t.symbol].wins++;
            else symbolMap[t.symbol].losses++;
            symbolMap[t.symbol].totalPnL += parseFloat(t.profit_loss || 0);
        });
        
        const symbolPerformance = Object.keys(symbolMap).map(symbol => ({
            symbol,
            trades: symbolMap[symbol].trades,
            wins: symbolMap[symbol].wins,
            losses: symbolMap[symbol].losses,
            winRate: ((symbolMap[symbol].wins / symbolMap[symbol].trades) * 100).toFixed(1),
            totalReturn: 0,
            totalProfitLoss: symbolMap[symbol].totalPnL,
            avgReturn: (symbolMap[symbol].totalPnL / symbolMap[symbol].trades).toFixed(2)
        }));
        
        return {
            hasData: true,
            metrics: {
                totalDecisions: trades.length,
                totalTrades: trades.length,
                wins,
                losses,
                winRate: winRate.toFixed(1),
                avgWin: avgWin.toFixed(2),
                avgLoss: avgLoss.toFixed(2),
                totalProfitLoss: totalPnL.toFixed(2),
                profitFactor: profitFactor.toFixed(2),
                sharpeRatio: sharpeRatio.toFixed(2),
                maxDrawdown: maxDrawdown.toFixed(2),
                avgHoldDays: avgHoldDays.toFixed(1),
                maxConsecutiveLosses,
                calmarRatio: maxDrawdown > 0 ? (totalPnL / maxDrawdown).toFixed(2) : '0.00',
                sortinoRatio: sharpeRatio.toFixed(2), // Simplified
                exposurePercent: '45' // Default - could calculate from position sizes
            },
            symbolPerformance,
            equityCurve,
            bestTrades: trades
                .filter(t => t.profit_loss > 0)
                .sort((a, b) => b.profit_loss - a.profit_loss)
                .slice(0, 5)
                .map(t => ({
                    symbol: t.symbol,
                    buyPrice: t.entry_price,
                    sellPrice: t.exit_price,
                    quantity: t.contracts,
                    profitLoss: parseFloat(t.profit_loss),
                    return: ((t.exit_price - t.entry_price) / t.entry_price * 100),
                    date: t.exit_date
                })),
            worstTrades: trades
                .filter(t => t.profit_loss < 0)
                .sort((a, b) => a.profit_loss - b.profit_loss)
                .slice(0, 5)
                .map(t => ({
                    symbol: t.symbol,
                    buyPrice: t.entry_price,
                    sellPrice: t.exit_price,
                    quantity: t.contracts,
                    profitLoss: parseFloat(t.profit_loss),
                    return: ((t.exit_price - t.entry_price) / t.entry_price * 100),
                    date: t.exit_date
                }))
        };
    } catch (error) {
        console.error('[Options Backtest] Error generating report:', error);
        throw error;
    }
}

module.exports = {
    getBacktestReport,
    getOptionsBacktestReport,
    getUserTrades,
    calculatePerformanceMetrics
};
