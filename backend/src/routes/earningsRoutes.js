const express = require('express');
const router = express.Router();
const earningsService = require('../services/earningsService');

/**
 * GET /api/earnings/calendar
 * Get upcoming earnings calendar for symbols
 */
router.get('/calendar', async (req, res) => {
    try {
        const { symbols } = req.query;
        
        if (!symbols) {
            return res.status(400).json({ error: 'symbols query parameter required' });
        }
        
        const symbolArray = symbols.split(',').map(s => s.trim().toUpperCase());
        const calendar = await earningsService.getEarningsCalendar(symbolArray);
        
        res.json({ calendar });
    } catch (error) {
        console.error('[Earnings API] Error fetching calendar:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/earnings/results/:symbol
 * Get earnings results for a symbol
 */
router.get('/results/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const result = await earningsService.captureEarningsResults(symbol.toUpperCase());
        
        if (!result) {
            return res.status(404).json({ error: 'No earnings data available' });
        }
        
        const analysis = earningsService.analyzeEarningsImpact(result);
        res.json({ ...result, analysis });
    } catch (error) {
        console.error('[Earnings API] Error fetching results:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/earnings/history
 * Get earnings history
 */
router.get('/history', async (req, res) => {
    try {
        const { symbol, limit } = req.query;
        const history = await earningsService.getEarningsHistory(
            symbol?.toUpperCase(),
            parseInt(limit) || 50
        );
        
        res.json({ history });
    } catch (error) {
        console.error('[Earnings API] Error fetching history:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/earnings/monitor
 * Monitor portfolio earnings
 */
router.get('/monitor', async (req, res) => {
    try {
        const { symbols } = req.query;
        
        if (!symbols) {
            return res.status(400).json({ error: 'symbols query parameter required' });
        }
        
        const symbolArray = symbols.split(',').map(s => s.trim().toUpperCase());
        const monitoring = await earningsService.monitorPortfolioEarnings(symbolArray);
        
        res.json(monitoring);
    } catch (error) {
        console.error('[Earnings API] Error monitoring earnings:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
