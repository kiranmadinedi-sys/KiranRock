const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const fs = require('fs').promises;
const path = require('path');

const EARNINGS_FILE = path.join(__dirname, '../../earnings.json');

/**
 * Earnings Monitoring Service
 * Automatically captures and analyzes earnings results
 */

/**
 * Get upcoming earnings calendar
 */
async function getEarningsCalendar(symbols) {
    const earningsData = [];
    
    for (const symbol of symbols) {
        try {
            const quote = await yahooFinance.quoteSummary(symbol, {
                modules: ['calendarEvents', 'earnings', 'earningsHistory']
            });
            
            if (quote.calendarEvents && quote.calendarEvents.earnings) {
                const earningsDate = quote.calendarEvents.earnings.earningsDate;
                
                earningsData.push({
                    symbol,
                    earningsDate: earningsDate ? earningsDate[0] : null,
                    earningsCallTime: quote.calendarEvents.earnings.earningsCallTime || 'Unknown',
                    revenueEstimate: quote.earnings?.financialsChart?.yearly?.[0]?.revenue || null,
                    epsEstimate: quote.earningsHistory?.history?.[0]?.epsEstimate || null,
                    lastUpdated: new Date().toISOString()
                });
            }
        } catch (error) {
            console.error(`[Earnings] Error fetching calendar for ${symbol}:`, error.message);
        }
    }
    
    return earningsData;
}

/**
 * Capture earnings results after announcement
 */
async function captureEarningsResults(symbol) {
    try {
        const quote = await yahooFinance.quoteSummary(symbol, {
            modules: ['earningsHistory', 'earnings', 'financialData']
        });
        
        if (!quote.earningsHistory || !quote.earningsHistory.history) {
            return null;
        }
        
        const latestEarnings = quote.earningsHistory.history[0];
        
        const result = {
            symbol,
            quarter: latestEarnings.quarter,
            period: latestEarnings.period,
            earningsDate: latestEarnings.earningsDate,
            epsActual: latestEarnings.epsActual,
            epsEstimate: latestEarnings.epsEstimate,
            epsSurprise: latestEarnings.epsSurprise || (latestEarnings.epsActual - latestEarnings.epsEstimate),
            epsSurprisePercent: latestEarnings.epsSurprisePercent || 
                ((latestEarnings.epsActual - latestEarnings.epsEstimate) / latestEarnings.epsEstimate * 100),
            revenue: quote.earnings?.financialsChart?.quarterly?.[0]?.revenue || null,
            revenueEstimate: quote.earnings?.financialsChart?.quarterly?.[0]?.revenueEstimate || null,
            capturedAt: new Date().toISOString()
        };
        
        // Save to earnings history
        await saveEarningsResult(result);
        
        return result;
    } catch (error) {
        console.error(`[Earnings] Error capturing results for ${symbol}:`, error.message);
        return null;
    }
}

/**
 * Save earnings result to file
 */
async function saveEarningsResult(result) {
    try {
        let earnings = [];
        
        try {
            const data = await fs.readFile(EARNINGS_FILE, 'utf8');
            earnings = JSON.parse(data);
        } catch {
            // File doesn't exist yet
        }
        
        // Add new result
        earnings.unshift(result);
        
        // Keep only last 1000 earnings results
        if (earnings.length > 1000) {
            earnings = earnings.slice(0, 1000);
        }
        
        await fs.writeFile(EARNINGS_FILE, JSON.stringify(earnings, null, 2));
        console.log(`[Earnings] Saved results for ${result.symbol}: EPS ${result.epsActual} (Est: ${result.epsEstimate})`);
    } catch (error) {
        console.error('[Earnings] Error saving results:', error);
    }
}

/**
 * Get earnings history from file
 */
async function getEarningsHistory(symbol = null, limit = 50) {
    try {
        const data = await fs.readFile(EARNINGS_FILE, 'utf8');
        let earnings = JSON.parse(data);
        
        if (symbol) {
            earnings = earnings.filter(e => e.symbol === symbol);
        }
        
        return earnings.slice(0, limit);
    } catch {
        return [];
    }
}

/**
 * Analyze earnings impact
 */
function analyzeEarningsImpact(result) {
    if (!result) return null;
    
    const epsBeat = result.epsActual > result.epsEstimate;
    const epsMiss = result.epsActual < result.epsEstimate;
    const significantBeat = result.epsSurprisePercent > 5;
    const significantMiss = result.epsSurprisePercent < -5;
    
    let impact = 'Neutral';
    let severity = 'Low';
    
    if (significantBeat) {
        impact = 'Very Positive';
        severity = 'High';
    } else if (epsBeat) {
        impact = 'Positive';
        severity = 'Medium';
    } else if (significantMiss) {
        impact = 'Very Negative';
        severity = 'High';
    } else if (epsMiss) {
        impact = 'Negative';
        severity = 'Medium';
    }
    
    return {
        impact,
        severity,
        epsSurprisePercent: result.epsSurprisePercent?.toFixed(2) + '%',
        recommendation: epsBeat ? 'Consider buying on pullback' : 'Avoid or consider selling'
    };
}

/**
 * Monitor earnings for portfolio holdings
 */
async function monitorPortfolioEarnings(symbols) {
    console.log('[Earnings] Monitoring portfolio earnings...');
    
    const upcoming = await getEarningsCalendar(symbols);
    const results = [];
    
    // Check for earnings today
    const today = new Date().toISOString().split('T')[0];
    
    for (const earning of upcoming) {
        if (earning.earningsDate) {
            const earningsDay = new Date(earning.earningsDate).toISOString().split('T')[0];
            
            if (earningsDay === today) {
                console.log(`[Earnings] ${earning.symbol} has earnings today! Capturing results...`);
                const result = await captureEarningsResults(earning.symbol);
                if (result) {
                    const analysis = analyzeEarningsImpact(result);
                    results.push({ ...result, analysis });
                }
            }
        }
    }
    
    return { upcoming, results };
}

module.exports = {
    getEarningsCalendar,
    captureEarningsResults,
    getEarningsHistory,
    analyzeEarningsImpact,
    monitorPortfolioEarnings
};
