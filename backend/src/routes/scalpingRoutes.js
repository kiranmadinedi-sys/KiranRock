const express = require('express');
const router = express.Router();
const scalpingStrategyService = require('../services/scalpingStrategyService');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

/**
 * GET /api/scalping/:symbol
 * Find scalping opportunities for a specific symbol
 */
router.get('/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const opportunities = await scalpingStrategyService.findScalpingOpportunities(symbol.toUpperCase());
        res.json(opportunities);
    } catch (error) {
        console.error('[Scalping API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/scalping/scan
 * Scan multiple symbols for scalping opportunities
 */
router.post('/scan', async (req, res) => {
    try {
        const { symbols, limit } = req.body;
        
        if (!symbols || !Array.isArray(symbols)) {
            return res.status(400).json({ error: 'symbols array required' });
        }
        
        const results = await scalpingStrategyService.scanMarketForScalps(
            symbols.map(s => s.toUpperCase()),
            limit || 20
        );
        
        res.json(results);
    } catch (error) {
        console.error('[Scalping API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/scalping/watchlist
 * Get recommended scalping watchlist
 */
router.get('/watchlist/recommended', async (req, res) => {
    try {
        const watchlist = scalpingStrategyService.getScalpingWatchlist();
        res.json({ watchlist, count: watchlist.length });
    } catch (error) {
        console.error('[Scalping API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/scalping/criteria
 * Get scalping criteria settings
 */
router.get('/criteria/settings', async (req, res) => {
    try {
        res.json(scalpingStrategyService.SCALPING_CRITERIA);
    } catch (error) {
        console.error('[Scalping API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
