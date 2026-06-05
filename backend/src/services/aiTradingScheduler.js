const { query } = require('../config/database');
const aiTradingBotService = require('./aiTradingBotService');
const brokerService = require('./brokerService');
const tradingServiceDB = require('./tradingServiceDB');
const userProfileService = require('./userProfileService');

const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

let schedulerInterval = null;

/**
 * Check and execute automatic trading for all users with AI enabled
 */
async function runAutomatedTrading() {
    console.log(`[AI Scheduler] Running automated trading check at ${new Date().toISOString()}`);
    
    try {
        // Get all users with AI trading enabled
        const result = await query(
            'SELECT id, username FROM users WHERE ai_trading_enabled = true',
            []
        );
        
        const users = result.rows;
        
        for (const user of users) {
            console.log(`[AI Scheduler] Checking AI trading for user: ${user.username}`);
            
            try {
                // Check if user has holdings
                const holdingsResult = await query(
                    'SELECT COUNT(*) as count FROM holdings WHERE user_id = $1',
                    [user.id]
                );
                
                const holdingCount = parseInt(holdingsResult.rows[0].count);
                
                // Auto-initialize if enabled but no holdings
                if (holdingCount === 0) {
                    console.log(`[AI Scheduler] Auto-initializing portfolio for ${user.username}`);
                    await autoInitializePortfolio(user.id);
                }
                
                // Check for stop-loss and take-profit triggers
                await checkStopLossAndTakeProfit(user.id);
                
                // Check for rebalancing needs
                await checkRebalancing(user.id);
                
            } catch (error) {
                console.error(`[AI Scheduler] Error processing user ${user.username}:`, error.message);
            }
        }
        
        console.log(`[AI Scheduler] Completed automated trading check`);
    } catch (error) {
        console.error('[AI Scheduler] Error in automated trading:', error);
    }
}

/**
 * Auto-initialize portfolio if user has AI enabled but no positions
 */
async function autoInitializePortfolio(userId) {
    try {
        const result = await aiTradingBotService.initializeAIPortfolio(userId);
        
        await userProfileService.logAIDecision(userId, {
            action: 'AUTO_INITIALIZE',
            reason: 'AI trading enabled with no positions',
            executedTrades: result.executedTrades.length,
            sectors: result.diversification?.sectors || 0,
            totalInvested: result.executedTrades.reduce((sum, t) => sum + t.total, 0)
        });
        
        console.log(`[AI Scheduler] Auto-initialized portfolio for user ${userId}: ${result.executedTrades.length} stocks purchased`);
    } catch (error) {
        console.error(`[AI Scheduler] Error auto-initializing portfolio:`, error.message);
    }
}

/**
 * Check all holdings for trailing stop-loss and take-profit triggers
 */
async function checkStopLossAndTakeProfit(userId) {
    try {
        // Get all holdings for user
        const holdingsResult = await query(
            'SELECT id, symbol, quantity, average_price, peak_price FROM holdings WHERE user_id = $1',
            [userId]
        );
        
        if (holdingsResult.rows.length === 0) {
            return;
        }
        
        const TRAILING_STOP_PERCENT = 0.10; // Trail by 10% from peak
        const TAKE_PROFIT = 0.30; // +30%
        
        for (const holding of holdingsResult.rows) {
            try {
                // Get current price
                const currentPrice = await tradingServiceDB.getCurrentPrice(holding.symbol);
                if (!currentPrice) continue;
                
                const purchasePrice = parseFloat(holding.average_price);
                let peakPrice = holding.peak_price ? parseFloat(holding.peak_price) : purchasePrice;
                
                // Update peak price if current price is higher
                if (currentPrice > peakPrice) {
                    peakPrice = currentPrice;
                    await query(
                        'UPDATE holdings SET peak_price = $1, updated_at = NOW() WHERE id = $2',
                        [peakPrice, holding.id]
                    );
                    console.log(`[AI Scheduler] Updated peak price for ${holding.symbol}: $${currentPrice.toFixed(2)}`);
                }
                
                // Calculate trailing stop price (10% below peak)
                const trailingStopPrice = peakPrice * (1 - TRAILING_STOP_PERCENT);
                
                // Calculate change from purchase price
                const changePercent = (currentPrice - purchasePrice) / purchasePrice;
                
                let shouldSell = false;
                let reason = '';
                
                // Check trailing stop-loss (price dropped below trailing stop)
                if (currentPrice <= trailingStopPrice) {
                    shouldSell = true;
                    const dropFromPeak = ((currentPrice - peakPrice) / peakPrice * 100).toFixed(2);
                    reason = `Trailing stop-loss triggered: dropped ${dropFromPeak}% from peak $${peakPrice.toFixed(2)} to $${currentPrice.toFixed(2)}`;
                }
                
                // Check take-profit
                if (changePercent >= TAKE_PROFIT) {
                    shouldSell = true;
                    reason = `Take-profit triggered at ${(changePercent * 100).toFixed(2)}%`;
                }
                
                if (shouldSell) {
                    console.log(`[AI Scheduler] ${reason} for ${holding.symbol} - Selling ${holding.quantity} shares`);
                    
                    const quantity = parseInt(holding.quantity, 10);
                    const result = await brokerService.sellMarket(userId, holding.symbol, quantity, {
                        executedBy: 'AI_SCHEDULER',
                        reason
                    });
                    
                    await userProfileService.logAIDecision(userId, {
                        action: 'AUTO_SELL',
                        symbol: holding.symbol,
                        quantity,
                        price: result.filledAvgPrice,
                        reason: reason,
                        purchasePrice: purchasePrice,
                        currentPrice: currentPrice,
                        peakPrice: peakPrice,
                        profitLoss: (result.filledAvgPrice - purchasePrice) * quantity,
                        profitLossPercent: changePercent * 100
                    });
                }
            } catch (error) {
                console.error(`[AI Scheduler] Error checking ${holding.symbol}:`, error.message);
            }
        }
    } catch (error) {
        console.error('[AI Scheduler] Error in stop-loss/take-profit check:', error);
    }
}

/**
 * Check if portfolio needs rebalancing
 */
async function checkRebalancing(userId) {
    try {
        const result = await aiTradingBotService.rebalancePortfolio(userId);
        
        if (result.actions && result.actions.length > 0) {
            const executedActions = result.actions.filter(a => a.executed);
            
            if (executedActions.length > 0) {
                console.log(`[AI Scheduler] Rebalanced portfolio for user ${userId}: ${executedActions.length} actions executed`);
                
                await userProfileService.logAIDecision(userId, {
                    action: 'AUTO_REBALANCE',
                    reason: 'Portfolio drift or signal changes detected',
                    actionsExecuted: executedActions.length,
                    actions: executedActions.map(a => ({
                        type: a.action,
                        symbol: a.symbol,
                        quantity: a.quantity,
                        reason: a.reason
                    }))
                });
            }
        }
    } catch (error) {
        console.error('[AI Scheduler] Error in rebalancing check:', error.message);
    }
}

/**
 * Start the automated trading scheduler
 */
function startScheduler() {
    if (schedulerInterval) {
        console.log('[AI Scheduler] Scheduler already running');
        return;
    }
    
    console.log(`[AI Scheduler] Starting automated trading scheduler (interval: ${CHECK_INTERVAL / 1000}s)`);
    
    // Run immediately on start
    runAutomatedTrading();
    
    // Then run on interval
    schedulerInterval = setInterval(runAutomatedTrading, CHECK_INTERVAL);
}

/**
 * Stop the automated trading scheduler
 */
function stopScheduler() {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
        console.log('[AI Scheduler] Stopped automated trading scheduler');
    }
}

module.exports = {
    startScheduler,
    stopScheduler,
    runAutomatedTrading
};
