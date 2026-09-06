const cron = require('node-cron');
const autonomousOptionsBot = require('./autonomousOptionsBot');
const optionsService = require('./optionsService');
const { logger } = require('../utils/logger');
const telegramAlertService = require('./telegramAlertService');
const { query } = require('../config/database');
// Was a local weekday+time-only reimplementation — never checked NYSE holidays.
// See utils/marketCalendar.js (found 2026-09-06, the eve of Labor Day 2026-09-07).
const { isMarketOpen } = require('../utils/marketCalendar');

// All symbols the options bot may trade — fetched pre-market to warm the DB cache
const PREWARM_UNIVERSE = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'AMD', 'META', 'TSLA', 'PANW'];

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
let scanJobs = [];
let monitorJob = null;
let summaryJob = null;


/**
 * Get all users with options bot enabled
 */
async function getActiveOptionsBotUsers() {
    try {
        const result = await query(`
            SELECT u.id, u.username,
                   obc.enabled, obc.max_position_risk, obc.max_account_risk,
                   obc.max_open_positions, obc.max_daily_loss
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
 * Pre-market options chain collection.
 * Fetches live options data for every symbol in PREWARM_UNIVERSE and stores it
 * in the options_chain_cache DB table so market-hours scans can serve from DB
 * instead of hammering Yahoo Finance at peak time.
 */
async function collectOptionsChains() {
    // Skip entirely when no user has the options bot enabled — this cache exists
    // to serve the options bot's market-hours scans, so warming it for nobody is
    // pure wasted Yahoo/Polygon traffic (found 2026-08-21: contributed to the
    // Polygon-403 → Yahoo-429 chain hitting every single day, twice a day,
    // regardless of whether the feature was even in use — currently zero users
    // have it enabled after disabling it for the paper account).
    const activeUsers = await getActiveOptionsBotUsers();
    if (activeUsers.length === 0) {
        logger.info('[Options Prewarm] Skipped — no users have the options bot enabled');
        return;
    }

    logger.info('[Options Prewarm] Starting options chain collection', {
        symbols: PREWARM_UNIVERSE.length,
        forUsers: activeUsers.length
    });

    let succeeded = 0;
    let failed = 0;
    const failures = [];

    for (const symbol of PREWARM_UNIVERSE) {
        try {
            const data = await optionsService.getOptionsWithGreeks(symbol);
            if (data.options && data.options.length > 0) {
                succeeded++;
                logger.info('[Options Prewarm] Cached options chain', {
                    symbol,
                    contracts: data.options.length,
                    stockPrice: data.stockPrice
                });
            } else {
                failed++;
                failures.push(symbol);
                logger.warn('[Options Prewarm] No options data returned', { symbol, error: data.error });
            }
        } catch (error) {
            failed++;
            failures.push(symbol);
            logger.error('[Options Prewarm] Failed to cache symbol', { symbol, error: error.message });
        }
        // 8-second gap between symbols — gives Yahoo crumb time to refresh
        await new Promise(resolve => setTimeout(resolve, 8000));
    }

    logger.info('[Options Prewarm] Collection complete', { succeeded, failed });

    // Cache-warming status is an ops concern (is the bot ready for open?), not
    // any individual trader's business — admin-only, single send.
    try {
        const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        const failLine = failures.length > 0 ? `\n❌ Failed: ${failures.join(', ')}` : '';
        const message =
            `📦 *OPTIONS CHAIN CACHE READY*\n\n` +
            `✅ Cached: ${succeeded}/${PREWARM_UNIVERSE.length} symbols\n` +
            `📅 As of: ${now} ET` +
            failLine +
            `\n\nBot is ready for market open.`;

        await telegramAlertService.sendAdminMessage(message);
    } catch (alertError) {
        logger.warn('[Options Prewarm] Telegram summary failed', { error: alertError.message });
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
    scanJobs.push(cron.schedule('45 9 * * 1-5', runOptionsScans, {
        timezone: 'America/New_York'
    }));
    
    // 11:00 AM ET - Mid-morning scan
    scanJobs.push(cron.schedule('0 11 * * 1-5', runOptionsScans, {
        timezone: 'America/New_York'
    }));
    
    // 01:00 PM ET - Post-lunch scan
    scanJobs.push(cron.schedule('0 13 * * 1-5', runOptionsScans, {
        timezone: 'America/New_York'
    }));
    
    // 03:00 PM ET - Pre-close scan
    scanJobs.push(cron.schedule('0 15 * * 1-5', runOptionsScans, {
        timezone: 'America/New_York'
    }));
    
    // Monitor open positions every 5 minutes during market hours
    monitorJob = cron.schedule('*/5 * * * 1-5', monitorOpenPositions, {
        timezone: 'America/New_York'
    });

    // Daily summary at 4:15 PM ET (after market close)
    summaryJob = cron.schedule('15 16 * * 1-5', sendDailySummary, {
        timezone: 'America/New_York'
    });

    // 8:00 AM ET — pre-market cache warmup (1.5h before open, fresh data for the day)
    cron.schedule('0 8 * * 1-5', collectOptionsChains, {
        timezone: 'America/New_York'
    });

    // 6:00 PM ET — evening refresh (captures after-hours IV moves, ready for next morning)
    cron.schedule('0 18 * * 1-5', collectOptionsChains, {
        timezone: 'America/New_York'
    });

    schedulerActive = true;
    logger.info('[Options Scheduler] ✓ Scheduler started successfully');
    logger.info('[Options Scheduler] Scan times: 09:45, 11:00, 13:00, 15:00 ET');
    logger.info('[Options Scheduler] Pre-market cache: 08:00 ET | Evening refresh: 18:00 ET');
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
    
    scanJobs.forEach((job) => job.stop());
    scanJobs = [];

    if (monitorJob) {
        monitorJob.stop();
        monitorJob = null;
    }

    if (summaryJob) {
        summaryJob.stop();
        summaryJob = null;
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
    collectOptionsChains,
    isMarketOpen
};
