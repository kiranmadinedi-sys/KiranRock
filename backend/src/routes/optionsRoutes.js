const express = require('express');
const router = express.Router();
const optionsService = require('../services/optionsService');
const optionsScheduler = require('../services/optionsScheduler');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

/**
 * GET /api/options/:symbol
 * Get options chain with Greeks for a symbol
 */
router.get('/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const data = await optionsService.getOptionsWithGreeks(symbol.toUpperCase());
        res.json(data);
    } catch (error) {
        console.error('[Options API] Error:', error);
        res.status(500).json({ error: error.message });
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
