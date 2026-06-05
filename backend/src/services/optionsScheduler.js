const cron = require('node-cron');
const optionsService = require('./optionsService');
const userService = require('./userService');
const { query } = require('../config/database');

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

let scheduledJobs = [];
let optionsAlertsSchemaReady = null;

function ensureOptionsAlertsSchema() {
    if (!optionsAlertsSchemaReady) {
        optionsAlertsSchemaReady = (async () => {
            await query(`
                CREATE TABLE IF NOT EXISTS options_alerts (
                    id VARCHAR(100) PRIMARY KEY,
                    symbol VARCHAR(10) NOT NULL,
                    market_cap VARCHAR(30),
                    scan_time VARCHAR(30),
                    severity VARCHAR(20),
                    option_type VARCHAR(20),
                    strike DECIMAL(12, 4),
                    expiration VARCHAR(30),
                    delta DECIMAL(10, 6),
                    gamma DECIMAL(10, 6),
                    theta DECIMAL(10, 6),
                    vega DECIMAL(10, 6),
                    last_price DECIMAL(12, 4),
                    volume INTEGER,
                    open_interest INTEGER,
                    title TEXT,
                    message TEXT,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    read BOOLEAN DEFAULT false
                )
            `);

            await query(`
                CREATE INDEX IF NOT EXISTS idx_options_alerts_created_at
                ON options_alerts(created_at DESC)
            `);

            await query(`
                CREATE INDEX IF NOT EXISTS idx_options_alerts_symbol
                ON options_alerts(symbol)
            `);
        })().catch((error) => {
            optionsAlertsSchemaReady = null;
            throw error;
        });
    }

    return optionsAlertsSchemaReady;
}

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
        await ensureOptionsAlertsSchema();

        await query(`
            INSERT INTO options_alerts (
                id, symbol, market_cap, scan_time, severity, option_type, strike,
                expiration, delta, gamma, theta, vega, last_price, volume,
                open_interest, title, message, read
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7,
                $8, $9, $10, $11, $12, $13, $14,
                $15, $16, $17, false
            )
        `, [
            `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            alert.symbol,
            alert.marketCap || null,
            alert.scanTime || null,
            alert.severity || null,
            alert.type || null,
            alert.strike ?? null,
            alert.expiration || null,
            alert.delta ?? null,
            alert.gamma ?? null,
            alert.theta ?? null,
            alert.vega ?? null,
            alert.lastPrice ?? null,
            alert.volume ?? null,
            alert.openInterest ?? null,
            alert.title || null,
            alert.message || null
        ]);
    } catch (error) {
        console.error('[Options Scheduler] Error saving alert:', error.message);
    }
}

function mapOptionsAlertRow(row) {
    return {
        id: row.id,
        symbol: row.symbol,
        marketCap: row.market_cap,
        scanTime: row.scan_time,
        severity: row.severity,
        type: row.option_type,
        strike: row.strike === null ? null : Number(row.strike),
        expiration: row.expiration,
        delta: row.delta === null ? null : Number(row.delta),
        gamma: row.gamma === null ? null : Number(row.gamma),
        theta: row.theta === null ? null : Number(row.theta),
        vega: row.vega === null ? null : Number(row.vega),
        lastPrice: row.last_price === null ? null : Number(row.last_price),
        volume: row.volume,
        openInterest: row.open_interest,
        title: row.title,
        message: row.message,
        timestamp: row.created_at,
        read: Boolean(row.read)
    };
}

/**
 * Scan for options opportunities
 * @param {string} scanTime - Time identifier (morning, midday, preclose, afterhours)
 */
async function scanOptionsOpportunities(scanTime) {
    try {
        console.log(`[Options Scheduler] Starting ${scanTime} scan at ${new Date().toLocaleString()}`);
        
        // Build symbol universe: HERMES top liquid + user holdings/watchlists
        const symbolsSet = new Set();

        // 1. HERMES top options-eligible stocks (high volume, large cap, RS-sorted)
        //    Options require: price > $20, avgVolume > 1M, marketCap > $5B
        try {
            const marketScreenerService = require('./marketScreenerService');
            const universe = await marketScreenerService.getStockUniverse();
            const optionsEligible = universe.filter(s =>
                (s.price || 0) > 20 &&
                (s.avgVolume || 0) > 1000000 &&
                (s.marketCap || 0) > 5000000000
            ).slice(0, 40); // top 40 options-eligible by RS score
            optionsEligible.forEach(s => symbolsSet.add(s.symbol));
            console.log(`[Options Scheduler] HERMES options-eligible: ${optionsEligible.length} symbols`);
        } catch (err) {
            console.warn('[Options Scheduler] HERMES universe unavailable:', err.message);
        }

        // 2. User holdings and watchlists (always include — users own these)
        const users = await userService.getAllUsers();
        for (const user of users) {
            if (user.portfolio) {
                user.portfolio.forEach(holding => symbolsSet.add(holding.symbol));
            }
            if (user.watchlist) {
                user.watchlist.forEach(symbol => symbolsSet.add(symbol));
            }
        }

        const symbols = Array.from(symbolsSet);
        console.log(`[Options Scheduler] Scanning ${symbols.length} symbols (HERMES + user portfolios)`);
        
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

    if (scheduledJobs.length > 0) {
        console.log('[Options Scheduler] Scheduler already running');
        return;
    }
    
    // Morning scan: 10:00 AM EST (14:00 UTC in winter, 15:00 UTC in summer)
    // Using cron format: minute hour * * day-of-week
    // Run Monday-Friday at 10 AM EST (adjust for timezone)
    scheduledJobs.push(cron.schedule('0 10 * * 1-5', async () => {
        await scanOptionsOpportunities('morning');
    }, {
        timezone: 'America/New_York'
    }));
    
    // Midday scan: 12:00 PM EST
    scheduledJobs.push(cron.schedule('0 12 * * 1-5', async () => {
        await scanOptionsOpportunities('midday');
    }, {
        timezone: 'America/New_York'
    }));
    
    // Pre-close scan: 3:45 PM EST
    scheduledJobs.push(cron.schedule('45 15 * * 1-5', async () => {
        await scanOptionsOpportunities('preclose');
    }, {
        timezone: 'America/New_York'
    }));
    
    // After-hours scan: 4:05 PM EST
    scheduledJobs.push(cron.schedule('5 16 * * 1-5', async () => {
        await scanOptionsOpportunities('afterhours');
    }, {
        timezone: 'America/New_York'
    }));
    
    console.log('[Options Scheduler] Scheduled scans:');
    console.log('  - 10:00 AM EST - Morning scan');
    console.log('  - 12:00 PM EST - Midday scan');
    console.log('  - 3:45 PM EST - Pre-close scan');
    console.log('  - 4:05 PM EST - After-hours scan');
    console.log('  - Market cap filter: > $2B');
}

function stopOptionsScheduler() {
    if (scheduledJobs.length === 0) {
        console.log('[Options Scheduler] Scheduler not running');
        return;
    }

    scheduledJobs.forEach((job) => job.stop());
    scheduledJobs = [];
    console.log('[Options Scheduler] Scheduler stopped');
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
        await ensureOptionsAlertsSchema();

        const conditions = [];
        const params = [];

        if (filters.symbol) {
            params.push(filters.symbol.toUpperCase());
            conditions.push(`symbol = $${params.length}`);
        }

        if (filters.severity) {
            params.push(filters.severity);
            conditions.push(`severity = $${params.length}`);
        }

        if (filters.unreadOnly) {
            conditions.push('read = false');
        }

        if (filters.scanTime) {
            params.push(filters.scanTime);
            conditions.push(`scan_time = $${params.length}`);
        }

        params.push(filters.limit || 50);

        const result = await query(`
            SELECT id, symbol, market_cap, scan_time, severity, option_type, strike,
                   expiration, delta, gamma, theta, vega, last_price, volume,
                   open_interest, title, message, created_at, read
            FROM options_alerts
            ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
            ORDER BY created_at DESC
            LIMIT $${params.length}
        `, params);

        return result.rows.map(mapOptionsAlertRow);
    } catch (error) {
        console.error('[Options Scheduler] Error fetching alerts:', error.message);
        return [];
    }
}

/**
 * Mark alert as read
 * @param {string} alertId - Alert ID
 */
async function markAlertAsRead(alertId) {
    try {
        await ensureOptionsAlertsSchema();

        const result = await query(`
            UPDATE options_alerts
            SET read = true
            WHERE id = $1
            RETURNING id, symbol, market_cap, scan_time, severity, option_type, strike,
                      expiration, delta, gamma, theta, vega, last_price, volume,
                      open_interest, title, message, created_at, read
        `, [alertId]);

        return result.rowCount > 0 ? mapOptionsAlertRow(result.rows[0]) : null;
    } catch (error) {
        console.error('[Options Scheduler] Error marking alert as read:', error.message);
        throw error;
    }
}

module.exports = {
    startOptionsScheduler,
    stopOptionsScheduler,
    scanOptionsOpportunities,
    manualScan,
    getOptionsAlerts,
    markAlertAsRead
};
