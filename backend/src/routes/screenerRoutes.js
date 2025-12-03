const express = require('express');
const router = express.Router();
const marketScreenerService = require('../services/marketScreenerService');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

/**
 * GET /api/screener/universe
 * Get all stocks with market cap > $2B
 */
router.get('/universe', async (req, res) => {
    try {
        const universe = await marketScreenerService.getStockUniverse();
        res.json({
            count: universe.length,
            stocks: universe,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[Screener API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/screener/sector/:sector
 * Get stocks by sector
 */
router.get('/sector/:sector', async (req, res) => {
    try {
        const { sector } = req.params;
        const stocks = await marketScreenerService.getStocksBySector(sector);
        res.json({
            sector,
            count: stocks.length,
            stocks
        });
    } catch (error) {
        console.error('[Screener API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/screener/liquid
 * Get top liquid stocks for options trading
 */
router.get('/liquid', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const stocks = await marketScreenerService.getTopLiquidStocks(limit);
        res.json({
            count: stocks.length,
            stocks
        });
    } catch (error) {
        console.error('[Screener API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/screener/refresh
 * Manually refresh stock universe cache
 */
router.post('/refresh', async (req, res) => {
    try {
        marketScreenerService.refreshCache();
        res.json({ 
            success: true, 
            message: 'Cache cleared, will refresh on next request' 
        });
    } catch (error) {
        console.error('[Screener API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
