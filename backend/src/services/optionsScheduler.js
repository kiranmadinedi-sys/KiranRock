const cron = require('node-cron');
const optionsService = require('./optionsService');
const userService = require('./userService');
const fs = require('fs').promises;
const path = require('path');

/**
 * Options Trading Scheduler
 * Scans for options opportunities at specific times:
 * - 10:00 AM EST - Morning scan
 * - 12:00 PM EST - Midday scan
 * - 3:45 PM EST - Pre-close scan
 * - 4:05 PM EST - After-hours scan
 * 
 * Only scans stocks with market cap > $2B
 */

const ALERTS_FILE = path.join(__dirname, '../../optionsAlerts.json');

/**
 * Get market cap for a symbol
 * @param {string} symbol - Stock symbol
 * @returns {Promise<number>} Market cap in millions
 */
async function getMarketCap(symbol) {
    try {
        const YahooFinance = require('yahoo-finance2').default;
        const yahooFinance = new YahooFinance();
        const quote = await yahooFinance.quote(symbol);
        return quote.marketCap ? quote.marketCap / 1000000 : 0; // Convert to millions
    } catch (error) {
        console.error(`[Options Scheduler] Error getting market cap for ${symbol}:`, error.message);
        return 0;
    }
}

/**
 * Save options alert
 * @param {Object} alert - Alert data
 */
async function saveOptionsAlert(alert) {
    try {
        let alerts = [];
        try {
            const data = await fs.readFile(ALERTS_FILE, 'utf8');
            alerts = JSON.parse(data);
        } catch (err) {
            // File doesn't exist yet
        }
        
        alerts.unshift({
            ...alert,
            id: Date.now() + Math.random(),
            timestamp: new Date().toISOString(),
            read: false
        });
        
        // Keep last 500 alerts
        if (alerts.length > 500) {
            alerts = alerts.slice(0, 500);
        }
        
        await fs.writeFile(ALERTS_FILE, JSON.stringify(alerts, null, 2));
    } catch (error) {
        console.error('[Options Scheduler] Error saving alert:', error.message);
    }
}

/**
 * Scan for options opportunities
 * @param {string} scanTime - Time identifier (morning, midday, preclose, afterhours)
 */
async function scanOptionsOpportunities(scanTime) {
    try {
        console.log(`[Options Scheduler] Starting ${scanTime} scan at ${new Date().toLocaleString()}`);
        
        // Get all users' watchlists and portfolio symbols
        const users = await userService.getAllUsers();
        const symbolsSet = new Set();
        
        for (const user of users) {
            // Add portfolio symbols
            if (user.portfolio) {
                user.portfolio.forEach(holding => symbolsSet.add(holding.symbol));
            }
            
            // Add watchlist symbols
            if (user.watchlist) {
                user.watchlist.forEach(symbol => symbolsSet.add(symbol));
            }
        }
        
        const symbols = Array.from(symbolsSet);
        console.log(`[Options Scheduler] Scanning ${symbols.length} symbols`);
        
        const opportunities = [];
        
        for (const symbol of symbols) {
            try {
                // Check market cap filter
                const marketCap = await getMarketCap(symbol);
                
                if (marketCap < 2000) {
                    console.log(`[Options Scheduler] Skipping ${symbol} - market cap $${marketCap}M < $2B threshold`);
                    continue;
                }
                
                // Define criteria based on scan time
                let criteria = {
                    minDelta: 0.4,
                    maxDelta: 0.7,
                    minGamma: 0.01,
                    maxTheta: -0.5,
                    minVolume: 100,
                    minOpenInterest: 500,
                    optionType: 'both'
                };
                
                // Adjust criteria by scan time
                if (scanTime === 'morning') {
                    // Morning: Look for fresh opportunities
                    criteria.minDelta = 0.3;
                    criteria.minVolume = 50;
                } else if (scanTime === 'preclose') {
                    // Pre-close: Focus on high delta, liquid options
                    criteria.minDelta = 0.5;
                    criteria.minVolume = 200;
                } else if (scanTime === 'afterhours') {
                    // After-hours: Review day's activity
                    criteria.minVolume = 500;
                    criteria.minOpenInterest = 1000;
                }
                
                const options = await optionsService.findOptionsOpportunities(symbol, criteria);
                
                if (options.length > 0) {
                    // Take top 3 opportunities per symbol
                    const topOptions = options.slice(0, 3);
                    
                    for (const option of topOptions) {
                        opportunities.push({
                            symbol,
                            marketCap: `$${(marketCap / 1000).toFixed(2)}B`,
                            scanTime,
                            ...option
                        });
                        
                        // Create alert for high-quality opportunities
                        if (Math.abs(option.delta) > 0.6 && option.volume > 500) {
                            await saveOptionsAlert({
                                symbol,
                                marketCap: `$${(marketCap / 1000).toFixed(2)}B`,
                                scanTime,
                                severity: 'High',
                                type: option.type.toUpperCase(),
                                strike: option.strike,
                                expiration: option.expiration,
                                delta: option.delta,
                                gamma: option.gamma,
                                theta: option.theta,
                                vega: option.vega,
                                lastPrice: option.lastPrice,
                                volume: option.volume,
                                openInterest: option.openInterest,
                                title: `${option.type.toUpperCase()} opportunity: ${symbol} $${option.strike}`,
                                message: `Delta: ${option.delta}, Gamma: ${option.gamma}, Theta: ${option.theta}/day, Volume: ${option.volume}`
                            });
                        }
                    }
                }
            } catch (error) {
                console.error(`[Options Scheduler] Error scanning ${symbol}:`, error.message);
            }
        }
        
        console.log(`[Options Scheduler] ${scanTime} scan complete. Found ${opportunities.length} opportunities`);
        
        return opportunities;
    } catch (error) {
        console.error(`[Options Scheduler] Error in ${scanTime} scan:`, error.message);
        return [];
    }
}

/**
 * Start options scanner with scheduled times
 */
function startOptionsScheduler() {
    console.log('[Options Scheduler] Starting options scanner...');
    
    // Morning scan: 10:00 AM EST (14:00 UTC in winter, 15:00 UTC in summer)
    // Using cron format: minute hour * * day-of-week
    // Run Monday-Friday at 10 AM EST (adjust for timezone)
    cron.schedule('0 10 * * 1-5', async () => {
        await scanOptionsOpportunities('morning');
    }, {
        timezone: 'America/New_York'
    });
    
    // Midday scan: 12:00 PM EST
    cron.schedule('0 12 * * 1-5', async () => {
        await scanOptionsOpportunities('midday');
    }, {
        timezone: 'America/New_York'
    });
    
    // Pre-close scan: 3:45 PM EST
    cron.schedule('45 15 * * 1-5', async () => {
        await scanOptionsOpportunities('preclose');
    }, {
        timezone: 'America/New_York'
    });
    
    // After-hours scan: 4:05 PM EST
    cron.schedule('5 16 * * 1-5', async () => {
        await scanOptionsOpportunities('afterhours');
    }, {
        timezone: 'America/New_York'
    });
    
    console.log('[Options Scheduler] Scheduled scans:');
    console.log('  - 10:00 AM EST - Morning scan');
    console.log('  - 12:00 PM EST - Midday scan');
    console.log('  - 3:45 PM EST - Pre-close scan');
    console.log('  - 4:05 PM EST - After-hours scan');
    console.log('  - Market cap filter: > $2B');
}

/**
 * Manual scan trigger (for testing)
 */
async function manualScan(scanTime = 'manual') {
    return await scanOptionsOpportunities(scanTime);
}

/**
 * Get all options alerts
 * @param {Object} filters - Filter criteria
 * @returns {Promise<Array>} Options alerts
 */
async function getOptionsAlerts(filters = {}) {
    try {
        const data = await fs.readFile(ALERTS_FILE, 'utf8');
        let alerts = JSON.parse(data);
        
        // Apply filters
        if (filters.symbol) {
            alerts = alerts.filter(a => a.symbol === filters.symbol.toUpperCase());
        }
        
        if (filters.severity) {
            alerts = alerts.filter(a => a.severity === filters.severity);
        }
        
        if (filters.unreadOnly) {
            alerts = alerts.filter(a => !a.read);
        }
        
        if (filters.scanTime) {
            alerts = alerts.filter(a => a.scanTime === filters.scanTime);
        }
        
        if (filters.limit) {
            alerts = alerts.slice(0, filters.limit);
        }
        
        return alerts;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
}

/**
 * Mark alert as read
 * @param {string} alertId - Alert ID
 */
async function markAlertAsRead(alertId) {
    try {
        const data = await fs.readFile(ALERTS_FILE, 'utf8');
        const alerts = JSON.parse(data);
        
        const alert = alerts.find(a => a.id == alertId);
        if (alert) {
            alert.read = true;
            await fs.writeFile(ALERTS_FILE, JSON.stringify(alerts, null, 2));
        }
        
        return alert;
    } catch (error) {
        console.error('[Options Scheduler] Error marking alert as read:', error.message);
        throw error;
    }
}

module.exports = {
    startOptionsScheduler,
    scanOptionsOpportunities,
    manualScan,
    getOptionsAlerts,
    markAlertAsRead
};
