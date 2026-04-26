const enhancedAITradingBot = require('./enhancedAITradingBot');
const userDb = require('./userDatabaseService');
const { query } = require('../config/database');

/**
 * Enhanced AI Trading Scheduler - PostgreSQL Version
 * Runs autonomous trading for all enabled users during market hours
 */

// Check every 5 minutes
const CHECK_INTERVAL = 5 * 60 * 1000;
let schedulerInterval = null;
let isRunning = false;

/**
 * Get all users with AI trading enabled from database
 */
async function getActiveAIUsers() {
    try {
        return await userDb.getUsersWithAITradingEnabled();
    } catch (error) {
        console.error('[Enhanced AI Scheduler] Error loading users:', error);
        return [];
    }
}

/**
 * Main scheduler function
 */
async function runScheduledTrading() {
    if (isRunning) {
        console.log('[Enhanced AI Scheduler] Previous run still in progress, skipping...');
        return;
    }
    
    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[Enhanced AI Scheduler] Starting at ${timestamp}`);
    console.log(`${'='.repeat(80)}\n`);
    
    isRunning = true;
    
    try {
        // Check if market is open
        if (!enhancedAITradingBot.isMarketOpen()) {
            console.log('[Enhanced AI Scheduler] Market is closed. Next check in 5 minutes.');
            isRunning = false;
            return;
        }
        
        console.log('[Enhanced AI Scheduler] ✓ Market is OPEN - proceeding with trading');
        
        // Get users with AI trading enabled
        const activeUsers = await getActiveAIUsers();
        
        if (activeUsers.length === 0) {
            console.log('[Enhanced AI Scheduler] No users have AI trading enabled.');
            isRunning = false;
            return;
        }
        
        console.log(`[Enhanced AI Scheduler] Found ${activeUsers.length} users with AI trading enabled\n`);
        
        // Process each user
        for (const user of activeUsers) {
            console.log(`\n${'-'.repeat(80)}`);
            console.log(`[Enhanced AI Scheduler] Processing user: ${user.username} (ID: ${user.id})`);
            console.log(`${'-'.repeat(80)}\n`);
            
            try {
                const result = await enhancedAITradingBot.executeAutonomousTrading(user.id);
                
                if (result.success) {
                    console.log(`[Enhanced AI Scheduler] ✓ User ${user.username}: ${result.message || 'Trading completed'}`);
                    
                    if (result.tradesExecuted > 0) {
                        console.log(`  - Trades executed: ${result.tradesExecuted}`);
                        console.log(`  - Capital deployed: $${result.capitalDeployed.toFixed(2)}`);
                        console.log(`  - Opportunities found: ${result.opportunitiesFound}`);
                        
                        // Log trade details
                        result.trades.forEach((trade, index) => {
                            console.log(`  ${index + 1}. ${trade.action} ${trade.shares} ${trade.symbol} @ $${trade.price.toFixed(2)} (Score: ${trade.aiScore}, Sector: ${trade.sector})`);
                        });
                    }
                } else {
                    console.log(`[Enhanced AI Scheduler] ⚠ User ${user.username}: ${result.message || result.error}`);
                }
                
                // Save trading log to user profile
                await logTradingActivity(user.id, result);
                
            } catch (error) {
                console.error(`[Enhanced AI Scheduler] Error processing user ${user.username}:`, error.message);
            }
            
            // Small delay between users
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        console.log(`\n${'='.repeat(80)}`);
        console.log('[Enhanced AI Scheduler] Trading cycle completed');
        console.log(`${'='.repeat(80)}\n`);
        
    } catch (error) {
        console.error('[Enhanced AI Scheduler] Error in trading cycle:', error);
    } finally {
        isRunning = false;
    }
}

/**
 * Log trading activity to database
 */
async function logTradingActivity(userId, result) {
    try {
        await query(`
            INSERT INTO ai_trading_logs (
                user_id, success, trades_executed, capital_deployed,
                opportunities_found, message, trades_detail
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            userId,
            result.success,
            result.tradesExecuted || 0,
            result.capitalDeployed || 0,
            result.opportunitiesFound || 0,
            result.message || result.error,
            JSON.stringify(result.trades || [])
        ]);
    } catch (error) {
        console.error('[Enhanced AI Scheduler] Error logging activity:', error);
    }
}

/**
 * Start the scheduler
 */
function startScheduler() {
    if (schedulerInterval) {
        console.log('[Enhanced AI Scheduler] Already running');
        return;
    }
    
    console.log('[Enhanced AI Scheduler] Starting enhanced AI trading scheduler...');
    console.log('[Enhanced AI Scheduler] Check interval: 5 minutes');
    console.log('[Enhanced AI Scheduler] Will only trade during market hours (9:30 AM - 4:00 PM ET, Mon-Fri)');
    
    // Run immediately on start
    runScheduledTrading();
    
    // Then run every 5 minutes
    schedulerInterval = setInterval(runScheduledTrading, CHECK_INTERVAL);
    
    console.log('[Enhanced AI Scheduler] ✓ Scheduler started successfully\n');
}

/**
 * Stop the scheduler
 */
function stopScheduler() {
    if (schedulerInterval) {
        clearInterval(schedulerInterval);
        schedulerInterval = null;
        console.log('[Enhanced AI Scheduler] Scheduler stopped');
    }
}

/**
 * Get scheduler status
 */
function getStatus() {
    return {
        running: schedulerInterval !== null,
        isProcessing: isRunning,
        checkInterval: CHECK_INTERVAL,
        marketOpen: enhancedAITradingBot.isMarketOpen()
    };
}

module.exports = {
    startScheduler,
    stopScheduler,
    getStatus,
    runScheduledTrading
};
