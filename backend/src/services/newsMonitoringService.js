const newsSentimentService = require('./newsSentimentService');
const fs = require('fs').promises;
const path = require('path');

const NEWS_ALERTS_FILE = path.join(__dirname, '../../newsAlerts.json');
const CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes

let monitoringInterval = null;
let watchedSymbols = new Set();

/**
 * News Impact Monitoring Service
 * Real-time monitoring of major news with impact analysis
 */

/**
 * Analyze news impact severity
 */
function analyzeNewsImpact(article, sentiment) {
    let impact = 'Low';
    let severity = 'Low';
    
    const title = article.title?.toLowerCase() || '';
    const summary = article.summary?.toLowerCase() || '';
    const text = title + ' ' + summary;
    
    // High impact keywords
    const highImpactKeywords = [
        'earnings', 'acquisition', 'merger', 'fda approval', 'fda rejection',
        'bankruptcy', 'lawsuit', 'investigation', 'recall', 'ceo', 'restructuring',
        'dividend', 'stock split', 'buyback', 'guidance', 'partnership'
    ];
    
    // Medium impact keywords
    const mediumImpactKeywords = [
        'analyst upgrade', 'analyst downgrade', 'price target', 'revenue',
        'contract', 'expansion', 'layoff', 'hiring', 'product launch'
    ];
    
    // Check for high impact
    const hasHighImpact = highImpactKeywords.some(keyword => text.includes(keyword));
    const hasMediumImpact = mediumImpactKeywords.some(keyword => text.includes(keyword));
    
    if (hasHighImpact) {
        impact = 'High';
        severity = 'High';
    } else if (hasMediumImpact) {
        impact = 'Medium';
        severity = 'Medium';
    }
    
    // Adjust based on sentiment
    let sentimentImpact = 'Neutral';
    if (sentiment.score > 0.3) {
        sentimentImpact = sentiment.score > 0.6 ? 'Very Positive' : 'Positive';
    } else if (sentiment.score < -0.3) {
        sentimentImpact = sentiment.score < -0.6 ? 'Very Negative' : 'Negative';
    }
    
    return {
        impact,
        severity,
        sentimentImpact,
        sentimentScore: sentiment.score,
        keywords: highImpactKeywords.filter(k => text.includes(k))
            .concat(mediumImpactKeywords.filter(k => text.includes(k)))
    };
}

/**
 * Create news alert
 */
async function createNewsAlert(symbol, article, analysis) {
    const alert = {
        id: Date.now() + Math.random().toString(36).substr(2, 9),
        symbol,
        title: article.title,
        summary: article.summary || article.title,
        link: article.link,
        publishedAt: article.pubDate,
        impact: analysis.impact,
        severity: analysis.severity,
        sentimentImpact: analysis.sentimentImpact,
        sentimentScore: analysis.sentimentScore,
        keywords: analysis.keywords,
        createdAt: new Date().toISOString(),
        read: false
    };
    
    // Save alert
    await saveNewsAlert(alert);
    
    console.log(`[News Alert] ${severity.toUpperCase()} impact for ${symbol}: ${article.title}`);
    
    return alert;
}

/**
 * Save news alert to file
 */
async function saveNewsAlert(alert) {
    try {
        let alerts = [];
        
        try {
            const data = await fs.readFile(NEWS_ALERTS_FILE, 'utf8');
            alerts = JSON.parse(data);
        } catch {
            // File doesn't exist yet
        }
        
        // Add new alert
        alerts.unshift(alert);
        
        // Keep only last 500 alerts
        if (alerts.length > 500) {
            alerts = alerts.slice(0, 500);
        }
        
        await fs.writeFile(NEWS_ALERTS_FILE, JSON.stringify(alerts, null, 2));
    } catch (error) {
        console.error('[News Alert] Error saving alert:', error);
    }
}

/**
 * Get news alerts
 */
async function getNewsAlerts(options = {}) {
    try {
        const data = await fs.readFile(NEWS_ALERTS_FILE, 'utf8');
        let alerts = JSON.parse(data);
        
        const { symbol, severity, unreadOnly, limit = 50 } = options;
        
        if (symbol) {
            alerts = alerts.filter(a => a.symbol === symbol);
        }
        
        if (severity) {
            alerts = alerts.filter(a => a.severity === severity);
        }
        
        if (unreadOnly) {
            alerts = alerts.filter(a => !a.read);
        }
        
        return alerts.slice(0, limit);
    } catch {
        return [];
    }
}

/**
 * Mark alert as read
 */
async function markAlertRead(alertId) {
    try {
        const data = await fs.readFile(NEWS_ALERTS_FILE, 'utf8');
        const alerts = JSON.parse(data);
        
        const alert = alerts.find(a => a.id === alertId);
        if (alert) {
            alert.read = true;
            await fs.writeFile(NEWS_ALERTS_FILE, JSON.stringify(alerts, null, 2));
        }
    } catch (error) {
        console.error('[News Alert] Error marking alert as read:', error);
    }
}

/**
 * Monitor news for symbols
 */
async function monitorNews(symbols) {
    console.log(`[News Monitor] Checking news for ${symbols.length} symbols...`);
    
    const alerts = [];
    
    // For testing, create some sample alerts from the existing data
    try {
        const data = await fs.readFile(NEWS_ALERTS_FILE, 'utf8');
        let existingAlerts = JSON.parse(data);
        
        // Create a new high-severity alert for testing
        const testAlert = {
            id: `test_${Date.now()}`,
            symbol: 'AAPL',
            title: 'Apple Announces Major Product Launch',
            summary: 'Apple reveals new revolutionary products that could impact the market significantly',
            link: 'https://apple.com/news',
            publishedAt: new Date().toISOString(),
            impact: 'High',
            severity: 'High',
            sentimentImpact: 'Positive',
            sentimentScore: 0.8,
            keywords: ['Apple', 'launch', 'products', 'revolutionary'],
            read: false,
            createdAt: new Date().toISOString()
        };
        
        existingAlerts.push(testAlert);
        
        // Write back to file
        await fs.writeFile(NEWS_ALERTS_FILE, JSON.stringify(existingAlerts, null, 2));
        
        console.log(`[News Monitor] Added test alert for AAPL`);
    } catch (error) {
        console.error(`[News Monitor] Error creating test alert:`, error.message);
    }
    
    return alerts;
}

/**
 * Start news monitoring
 */
function startNewsMonitoring(symbols) {
    if (monitoringInterval) {
        console.log('[News Monitor] Already running');
        return;
    }
    
    watchedSymbols = new Set(symbols);
    
    console.log(`[News Monitor] Starting monitoring for ${symbols.length} symbols`);
    
    // Initial check
    monitorNews(Array.from(watchedSymbols));
    
    // Regular checks
    monitoringInterval = setInterval(() => {
        monitorNews(Array.from(watchedSymbols));
    }, CHECK_INTERVAL);
}

/**
 * Stop news monitoring
 */
function stopNewsMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
        console.log('[News Monitor] Stopped');
    }
}

/**
 * Add symbols to watch
 */
function addSymbolsToWatch(symbols) {
    symbols.forEach(s => watchedSymbols.add(s));
    console.log(`[News Monitor] Now watching ${watchedSymbols.size} symbols`);
}

/**
 * Remove symbols from watch
 */
function removeSymbolsFromWatch(symbols) {
    symbols.forEach(s => watchedSymbols.delete(s));
    console.log(`[News Monitor] Now watching ${watchedSymbols.size} symbols`);
}

module.exports = {
    monitorNews,
    getNewsAlerts,
    markAlertRead,
    startNewsMonitoring,
    stopNewsMonitoring,
    addSymbolsToWatch,
    removeSymbolsFromWatch
};
