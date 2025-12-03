const express = require('express');
const router = express.Router();
const newsMonitoringService = require('../services/newsMonitoringService');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

/**
 * GET /api/news-alerts
 * Get news alerts
 */
router.get('/', async (req, res) => {
    try {
        const { symbol, severity, unreadOnly, limit } = req.query;
        
        const alerts = await newsMonitoringService.getNewsAlerts({
            symbol,
            severity,
            unreadOnly: unreadOnly === 'true',
            limit: parseInt(limit) || 50
        });
        
        // Prevent caching for real-time alerts
        res.set({
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        
        res.json({ alerts });
    } catch (error) {
        console.error('[News Alerts API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/news-alerts/:id/read
 * Mark alert as read
 */
router.put('/:id/read', async (req, res) => {
    try {
        const { id } = req.params;
        await newsMonitoringService.markAlertRead(id);
        res.json({ success: true });
    } catch (error) {
        console.error('[News Alerts API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/news-alerts/monitor
 * Start monitoring specific symbols
 */
router.post('/monitor', async (req, res) => {
    try {
        const { symbols } = req.body;
        
        if (!symbols || !Array.isArray(symbols)) {
            return res.status(400).json({ error: 'symbols array required' });
        }
        
        newsMonitoringService.addSymbolsToWatch(symbols.map(s => s.toUpperCase()));
        res.json({ success: true, message: `Monitoring ${symbols.length} symbols` });
    } catch (error) {
        console.error('[News Alerts API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
