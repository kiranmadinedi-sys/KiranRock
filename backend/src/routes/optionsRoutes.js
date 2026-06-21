const express = require('express');
const router = express.Router();
const optionsService = require('../services/optionsService');
const optionsScheduler = require('../services/optionsScheduler');
const { protect } = require('../middleware/authMiddleware');
const YahooFinance = require('yahoo-finance2').default;
const dataProvider = require('../services/dataProvider');

// All routes require authentication
// Temporarily disabled for local dev
// router.use(protect);

/**
 * GET /api/options/chain?symbol=AAPL&expiration=<unix_seconds>
 * Full options chain viewer endpoint — returns expiration dates + calls/puts for one expiration.
 * Tries Yahoo Finance first (single call = no rate limit cascade), falls back to DB cache.
 */
router.get('/chain', async (req, res) => {
    const symbol = (req.query.symbol || '').toUpperCase().trim();
    const expiration = req.query.expiration ? Number(req.query.expiration) : null;

    if (!symbol) return res.status(400).json({ error: 'symbol query param required' });

    const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

    const toContract = (c, type) => ({
        strike:            Number(c.strike || 0),
        bid:               Number(c.bid || 0),
        ask:               Number(c.ask || 0),
        lastPrice:         Number(c.lastPrice || 0),
        volume:            Number(c.volume || 0),
        openInterest:      Number(c.openInterest || 0),
        impliedVolatility: Number(c.impliedVolatility || 0),
        inTheMoney:        Boolean(c.inTheMoney),
        change:            Number(c.change || 0),
        percentChange:     Number(c.percentChange || 0),
        type
    });

    try {
        // Single initial call — returns expiration list + nearest-expiration contracts
        const base = await yf.options(symbol);
        const expirationDates = (base.expirationDates || []).map(ts => ({
            timestamp: ts,
            date: new Date(ts * 1000).toISOString().split('T')[0]
        }));

        let selectedChain = base;
        let selectedTs = expirationDates[0]?.timestamp;
        if (expiration && expirationDates.some(e => e.timestamp === expiration)) {
            selectedChain = await yf.options(symbol, { date: expiration });
            selectedTs = expiration;
        }

        const stockPrice = base.quote?.regularMarketPrice || null;
        const calls = (selectedChain.calls || []).map(c => toContract(c, 'call'));
        const puts  = (selectedChain.puts  || []).map(c => toContract(c, 'put'));

        // Persist to local history whenever we get live data (user-initiated fetches
        // also build our long-term options dataset)
        const selectedDate = expirationDates.find(e => e.timestamp === selectedTs)?.date;
        if (selectedDate && (calls.length + puts.length > 0)) {
            const histContracts = [
                ...calls.map(c => ({ ...c, optionType: 'call', strikePrice: c.strike, expirationDate: selectedDate, daysToExpiration: Math.max(1, Math.ceil((new Date(selectedDate) - new Date()) / 86400000)) })),
                ...puts.map(c =>  ({ ...c, optionType: 'put',  strikePrice: c.strike, expirationDate: selectedDate, daysToExpiration: Math.max(1, Math.ceil((new Date(selectedDate) - new Date()) / 86400000)) }))
            ];
            optionsService.saveOptionsToDB(symbol, { stockPrice, options: histContracts })
                .catch(() => {}); // fire-and-forget, don't delay the response
        }

        return res.json({
            symbol,
            stockPrice,
            expirationDates,
            selectedExpiration: selectedTs,
            calls,
            puts,
            source: 'live'
        });
    } catch (liveErr) {
        // Fall back to DB cache
        try {
            const cached = await optionsService.getOptionsWithGreeks(symbol);
            if (cached.options && cached.options.length > 0) {
                const byExp = {};
                for (const o of cached.options) {
                    if (!byExp[o.expirationDate]) byExp[o.expirationDate] = { calls: [], puts: [] };
                    byExp[o.expirationDate][o.optionType === 'call' ? 'calls' : 'puts'].push({
                        strike:            o.strikePrice,
                        bid:               o.bid,
                        ask:               o.ask,
                        lastPrice:         o.lastPrice || 0,
                        volume:            o.volume,
                        openInterest:      o.openInterest,
                        impliedVolatility: o.impliedVolatility,
                        inTheMoney:        cached.stockPrice
                            ? (o.optionType === 'call' ? o.strikePrice < cached.stockPrice : o.strikePrice > cached.stockPrice)
                            : false,
                        change: 0, percentChange: 0, type: o.optionType
                    });
                }
                const expDates = Object.keys(byExp).sort().map(d => ({ timestamp: null, date: d }));
                const sel = expDates[0]?.date;
                return res.json({
                    symbol,
                    stockPrice: cached.stockPrice,
                    expirationDates: expDates,
                    selectedExpiration: sel,
                    calls: byExp[sel]?.calls || [],
                    puts:  byExp[sel]?.puts  || [],
                    source: 'cache',
                    warning: 'Live data unavailable — showing cached data'
                });
            }
        } catch (_) { /* ignore cache error */ }

        return res.status(503).json({
            error: 'Options data temporarily unavailable',
            details: liveErr.message,
            suggestion: 'Upgrade Polygon subscription to include Options tier for reliable data'
        });
    }
});

/**
 * GET /api/options/:symbol
 * Get options chain with Greeks for a symbol
 */
router.get('/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const data = await optionsService.getOptionsWithGreeks(symbol.toUpperCase());
        
        // Service now returns graceful errors instead of throwing
        // Always return 200 with the data object (which may contain an error field)
        res.json(data);
    } catch (error) {
        console.error('[Options API] Error:', error);
        res.status(500).json({ 
            symbol: req.params.symbol,
            error: error.message,
            options: []
        });
    }
});

/**
 * POST /api/options/opportunities
 * Find options opportunities based on criteria
 * Body: { symbol, criteria: { minDelta, maxDelta, ... } }
 */
router.post('/opportunities', async (req, res) => {
    try {
        const { symbol, criteria } = req.body;
        
        if (!symbol) {
            return res.status(400).json({ error: 'Symbol is required' });
        }
        
        const opportunities = await optionsService.findOptionsOpportunities(symbol.toUpperCase(), criteria || {});
        res.json({ symbol, count: opportunities.length, opportunities });
    } catch (error) {
        console.error('[Options API] Opportunities error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/options/scan
 * Manual trigger for options scan
 */
router.post('/scan', async (req, res) => {
    try {
        const { scanTime } = req.body;
        const results = await optionsScheduler.manualScan(scanTime || 'manual');
        res.json({ scannedAt: new Date().toISOString(), count: results.length, results });
    } catch (error) {
        console.error('[Options API] Scan error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/options/alerts/list
 * Get options alerts
 */
router.get('/alerts/list', async (req, res) => {
    try {
        const { symbol, severity, unreadOnly, scanTime, limit } = req.query;
        
        const filters = {
            symbol,
            severity,
            unreadOnly: unreadOnly === 'true',
            scanTime,
            limit: limit ? parseInt(limit) : undefined
        };
        
        const alerts = await optionsScheduler.getOptionsAlerts(filters);
        res.json(alerts);
    } catch (error) {
        console.error('[Options API] Alerts error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/options/alerts/:id/read
 * Mark alert as read
 */
router.put('/alerts/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        const alert = await optionsScheduler.markAlertAsRead(id);
        res.json(alert);
    } catch (error) {
        console.error('[Options API] Mark read error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
