const fs = require('fs').promises;
const path = require('path');
const aiTradingBotService = require('./aiTradingBotService');
const tradingService = require('./tradingService');
const userProfileService = require('./userProfileService');

const USERS_FILE = path.join(__dirname, '../../users.json');
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

let schedulerInterval = null;

/**
 * Check and execute automatic trading for all users with AI enabled
 */
async function runAutomatedTrading() {
    console.log(`[AI Scheduler] Running automated trading check at ${new Date().toISOString()}`);
    
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        
        for (const user of users) {
            if (!user.aiTradingEnabled) {
                continue; // Skip users with AI trading disabled
            }
            
            console.log(`[AI Scheduler] Checking AI trading for user: ${user.username}`);
            
            try {
                // Auto-initialize if enabled but no holdings
                if (!user.holdings || user.holdings.length === 0) {
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
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);
        
        if (!user || !user.holdings) {
            return;
        }
        
        const TRAILING_STOP_PERCENT = 0.10; // Trail by 10% from peak
        const TAKE_PROFIT = 0.30; // +30%
        let userModified = false;
        
        for (const holding of user.holdings) {
            try {
                // Get current price
                const currentPrice = await tradingService.getCurrentPrice(holding.symbol);
                if (!currentPrice) continue;
                
                const purchasePrice = holding.averagePrice;
                
                // Initialize or update peak price (highest price since purchase)
                if (!holding.peakPrice || currentPrice > holding.peakPrice) {
                    holding.peakPrice = currentPrice;
                    userModified = true;
                    console.log(`[AI Scheduler] Updated peak price for ${holding.symbol}: $${currentPrice.toFixed(2)}`);
                }
                
                // Calculate trailing stop price (10% below peak)
                const trailingStopPrice = holding.peakPrice * (1 - TRAILING_STOP_PERCENT);
                
                // Calculate change from purchase price
                const changePercent = (currentPrice - purchasePrice) / purchasePrice;
                
                let shouldSell = false;
                let reason = '';
                
                // Check trailing stop-loss (price dropped below trailing stop)
                if (currentPrice <= trailingStopPrice) {
                    shouldSell = true;
                    const dropFromPeak = ((currentPrice - holding.peakPrice) / holding.peakPrice * 100).toFixed(2);
                    reason = `Trailing stop-loss triggered: dropped ${dropFromPeak}% from peak $${holding.peakPrice.toFixed(2)} to $${currentPrice.toFixed(2)}`;
                }
                
                // Check take-profit
                if (changePercent >= TAKE_PROFIT) {
                    shouldSell = true;
                    reason = `Take-profit triggered at ${(changePercent * 100).toFixed(2)}%`;
                }
                
                if (shouldSell) {
                    console.log(`[AI Scheduler] ${reason} for ${holding.symbol} - Selling ${holding.quantity} shares`);
                    
                    const result = await tradingService.executeSellOrder(userId, holding.symbol, holding.quantity);
                    
                    await userProfileService.logAIDecision(userId, {
                        action: 'AUTO_SELL',
                        symbol: holding.symbol,
                        quantity: holding.quantity,
                        price: result.price,
                        reason: reason,
                        purchasePrice: purchasePrice,
                        currentPrice: currentPrice,
                        peakPrice: holding.peakPrice,
                        profitLoss: result.profitLoss,
                        profitLossPercent: changePercent * 100
                    });
                    
                    userModified = false; // Holding will be removed by sell order
                }
            } catch (error) {
                console.error(`[AI Scheduler] Error checking ${holding.symbol}:`, error.message);
            }
        }
        
        // Save updated peak prices
        if (userModified) {
            const userIndex = users.findIndex(u => u.id === userId);
            if (userIndex !== -1) {
                users[userIndex] = user;
                await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
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
