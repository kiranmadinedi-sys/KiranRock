const express = require('express');
const router = express.Router();
const swingTradingService = require('../services/swingTradingService');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

/**
 * GET /api/swing-trading/analysis/:symbol
 * Get swing trading analysis for a specific symbol
 */
router.get('/analysis/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const analysis = await swingTradingService.getSwingTradingAnalysis(symbol.toUpperCase());
        res.json(analysis);
    } catch (error) {
        console.error('[Swing Trading API] Analysis error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/swing-trading/scan
 * Scan multiple symbols for swing trading opportunities
 * Body: { symbols: ['AAPL', 'MSFT', ...] }
 */
router.post('/scan', async (req, res) => {
    try {
        const { symbols } = req.body;
        
        if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
            return res.status(400).json({ error: 'Please provide an array of symbols' });
        }
        
        const opportunities = await swingTradingService.scanForSwingOpportunities(symbols);
        res.json({ 
            scannedCount: symbols.length,
            opportunitiesFound: opportunities.length,
            opportunities 
        });
    } catch (error) {
        console.error('[Swing Trading API] Scan error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/swing-trading/ema-crossover/:symbol
 * Get EMA 9-day crossover signal
 */
router.get('/ema-crossover/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const crossover = await swingTradingService.detectEMACrossover(symbol.toUpperCase());
        res.json(crossover);
    } catch (error) {
        console.error('[Swing Trading API] EMA crossover error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/swing-trading/cup-and-handle/:symbol
 * Detect Cup and Handle pattern
 */
router.get('/cup-and-handle/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const pattern = await swingTradingService.detectCupAndHandle(symbol.toUpperCase());
        res.json(pattern);
    } catch (error) {
        console.error('[Swing Trading API] Cup & Handle error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
