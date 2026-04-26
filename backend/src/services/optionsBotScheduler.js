const cron = require('node-cron');
const autonomousOptionsBot = require('./autonomousOptionsBot');
const { logger } = require('../utils/logger');
const telegramAlertService = require('./telegramAlertService');
const { query } = require('../config/database');

/**
 * AUTONOMOUS OPTIONS TRADING SCHEDULER
 * 
 * Runs options bot at optimal times during market hours:
 * - 09:45 AM ET - Post-open scan (volatility settles)
 * - 11:00 AM ET - Mid-morning scan
 * - 01:00 PM ET - Post-lunch scan
 * - 03:00 PM ET - Pre-close scan (increased volume)
 * 
 * Also monitors open positions every 5 minutes during market hours
 */

let schedulerActive = false;
let scanJob = null;
let monitorJob = null;

/**
 * Check if market is open (Monday-Friday, 9:30 AM - 4:00 PM ET)
 */
function isMarketOpen() {
    const now = new Date();
    const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = et.getDay(); // 0 = Sunday, 6 = Saturday
    const hours = et.getHours();
    const minutes = et.getMinutes();
    
    // Check if weekday (Monday = 1, Friday = 5)
    if (day === 0 || day === 6) return false;
    
    // Check if within trading hours (9:30 AM - 4:00 PM ET)
    const currentTime = hours * 60 + minutes;
    const marketOpen = 9 * 60 + 30; // 9:30 AM
    const marketClose = 16 * 60; // 4:00 PM
    
    return currentTime >= marketOpen && currentTime < marketClose;
}

/**
 * Get all users with options bot enabled
 */
async function getActiveOptionsBotUsers() {
    try {
        const result = await query(`
            SELECT DISTINCT u.id, u.username, obc.* 
            FROM users u
            INNER JOIN options_bot_config obc ON u.id = obc.user_id
            WHERE obc.enabled = true
        `);
        
        return result.rows;
    } catch (error) {
        logger.error('[Options Scheduler] Error getting active users', { error: error.message });
        return [];
    }
}

/**
 * Run options scan for all active users
 */
async function runOptionsScans() {
    try {
        if (!isMarketOpen()) {
            logger.info('[Options Scheduler] Market closed, skipping scan');
            return;
        }
        
        logger.info('[Options Scheduler] Starting scheduled options scan');
        
        const users = await getActiveOptionsBotUsers();
        
        if (users.length === 0) {
            logger.info('[Options Scheduler] No active options bot users');
            return;
        }
        
        logger.info('[Options Scheduler] Running for users', { count: users.length });
        
        // Run bot for each user sequentially
        for (const user of users) {
            try {
                logger.info('[Options Scheduler] Processing user', { 
                    userId: user.id, 
                    username: user.username 
                });
                
                await autonomousOptionsBot.executeAutonomousOptionsTrading(user.id);
                
                // Add delay between users to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (error) {
                logger.error('[Options Scheduler] Error processing user', { 
                    userId: user.id, 
                    error: error.message 
                });
            }
        }
        
        logger.info('[Options Scheduler] Scan complete');
        
    } catch (error) {
        logger.error('[Options Scheduler] Error in scheduled scan', { error: error.message });
    }
}

/**
 * Monitor open positions for all active users
 */
async function monitorOpenPositions() {
    try {
        if (!isMarketOpen()) {
            return;
        }
        
        const users = await getActiveOptionsBotUsers();
        
        for (const user of users) {
            try {
                await autonomousOptionsBot.monitorOptionsPositions(user.id);
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                logger.error('[Options Scheduler] Error monitoring positions', { 
                    userId: user.id, 
                    error: error.message 
                });
            }
        }
        
    } catch (error) {
        logger.error('[Options Scheduler] Error in position monitoring', { error: error.message });
    }
}

/**
 * Send daily summary at market close
 */
async function sendDailySummary() {
    try {
        logger.info('[Options Scheduler] Generating daily summaries');
        
        const users = await getActiveOptionsBotUsers();
        
        for (const user of users) {
            try {
                // Get today's trades
                const today = new Date().toISOString().split('T')[0];
                const result = await query(`
                    SELECT 
                        COUNT(*) as total_trades,
                        SUM(CASE WHEN profit_loss > 0 THEN 1 ELSE 0 END) as winning_trades,
                        SUM(CASE WHEN profit_loss < 0 THEN 1 ELSE 0 END) as losing_trades,
                        SUM(profit_loss) as total_pnl,
                        MAX(profit_loss) as best_trade,
                        MIN(profit_loss) as worst_trade
                    FROM options_trades
                    WHERE user_id = $1 
                        AND DATE(exit_date) = $2
                        AND status = 'CLOSED'
                `, [user.id, today]);
                
                const stats = result.rows[0];
                
                if (parseInt(stats.total_trades) > 0) {
                    const winRate = (parseInt(stats.winning_trades) / parseInt(stats.total_trades)) * 100;
                    
                    await telegramAlertService.alertDailySummary(user.id, {
                        trades: parseInt(stats.total_trades),
                        profitTrades: parseInt(stats.winning_trades),
                        lossTrades: parseInt(stats.losing_trades),
                        totalProfit: parseFloat(stats.total_pnl || 0),
                        winRate,
                        bestTrade: parseFloat(stats.best_trade || 0),
                        worstTrade: parseFloat(stats.worst_trade || 0)
                    });
                }
                
            } catch (error) {
                logger.error('[Options Scheduler] Error generating summary', { 
                    userId: user.id, 
                    error: error.message 
                });
            }
        }
        
    } catch (error) {
        logger.error('[Options Scheduler] Error in daily summary', { error: error.message });
    }
}

/**
 * Start the options trading scheduler
 */
async function startOptionsScheduler() {
    if (schedulerActive) {
        logger.warn('[Options Scheduler] Already running');
        return;
    }
    
    logger.info('[Options Scheduler] Starting autonomous options bot scheduler');
    
    // Schedule scans at specific times (EST/EDT)
    // Convert to cron format: minute hour * * day
    
    // 09:45 AM ET - Post-open scan
    cron.schedule('45 13 * * 1-5', runOptionsScans, {
        timezone: 'America/New_York'
    });
    
    // 11:00 AM ET - Mid-morning scan
    cron.schedule('0 15 * * 1-5', runOptionsScans, {
        timezone: 'America/New_York'
    });
    
    // 01:00 PM ET - Post-lunch scan
    cron.schedule('0 17 * * 1-5', runOptionsScans, {
        timezone: 'America/New_York'
    });
    
    // 03:00 PM ET - Pre-close scan
    cron.schedule('0 19 * * 1-5', runOptionsScans, {
        timezone: 'America/New_York'
    });
    
    // Monitor open positions every 5 minutes during market hours
    monitorJob = cron.schedule('*/5 * * * 1-5', monitorOpenPositions, {
        timezone: 'America/New_York'
    });
    
    // Daily summary at 4:15 PM ET (after market close)
    cron.schedule('15 20 * * 1-5', sendDailySummary, {
        timezone: 'America/New_York'
    });
    
    schedulerActive = true;
    logger.info('[Options Scheduler] ✓ Scheduler started successfully');
    logger.info('[Options Scheduler] Scan times: 09:45, 11:00, 13:00, 15:00 ET');
    logger.info('[Options Scheduler] Position monitoring: Every 5 minutes during market hours');
}

/**
 * Stop the options trading scheduler
 */
function stopOptionsScheduler() {
    if (!schedulerActive) {
        logger.warn('[Options Scheduler] Not running');
        return;
    }
    
    if (monitorJob) {
        monitorJob.stop();
    }
    
    schedulerActive = false;
    logger.info('[Options Scheduler] Stopped');
}

/**
 * Get scheduler status
 */
function getSchedulerStatus() {
    return {
        active: schedulerActive,
        marketOpen: isMarketOpen(),
        nextScans: [
            '09:45 AM ET',
            '11:00 AM ET',
            '01:00 PM ET',
            '03:00 PM ET'
        ]
    };
}

/**
 * Manual trigger for testing
 */
async function manualTrigger(userId = null) {
    logger.info('[Options Scheduler] Manual trigger initiated', { userId });
    
    if (userId) {
        // Run for specific user
        await autonomousOptionsBot.executeAutonomousOptionsTrading(userId);
        await autonomousOptionsBot.monitorOptionsPositions(userId);
    } else {
        // Run for all active users
        await runOptionsScans();
        await monitorOpenPositions();
    }
    
    logger.info('[Options Scheduler] Manual trigger complete');
}

module.exports = {
    startOptionsScheduler,
    stopOptionsScheduler,
    getSchedulerStatus,
    manualTrigger,
    isMarketOpen
};
