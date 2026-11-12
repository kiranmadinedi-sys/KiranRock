
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const aiTradingBotService = require('../services/aiTradingBotService');
const userProfileService = require('../services/userProfileService');

// All routes require authentication
router.use(protect);

/**
 * GET /api/ai-trading/settings
 * Retrieve user AI trading settings
 */
router.get('/settings', async (req, res) => {
    try {
        const aiTradingSettings = await userProfileService.getAITradingSettings(req.userId);
        res.json({ aiTradingSettings });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/ai-trading/settings
 * Save user AI trading settings (stop-loss, take-profit, cash reserve)
 */
router.post('/settings', async (req, res) => {
    try {
        const { stopLoss, takeProfit, minCashReserve, maxPositionSize, maxOpenPositions, maxOrderNotional } = req.body;
        const aiTradingSettings = await userProfileService.updateAITradingSettings(req.userId, {
            stopLoss,
            takeProfit,
            minCashReserve,
            maxPositionSize,
            maxOpenPositions,
            maxOrderNotional
        });
        res.json({ success: true, aiTradingSettings });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/ai-trading/initialize
 * Initialize AI-managed portfolio
 */
// Retired 2026-11-12 — placed live market orders outside every enhanced-bot guard.
router.post('/initialize', (req, res) => {
    res.status(410).json({ error: 'Retired: the enhanced bot manages positions automatically. Nothing was traded.' });
});

/**
 * POST /api/ai-trading/rebalance
 * Rebalance portfolio based on AI recommendations
 */
// Retired 2026-11-12 — placed live market orders outside every enhanced-bot guard.
router.post('/rebalance', (req, res) => {
    res.status(410).json({ error: 'Retired: the enhanced bot manages positions automatically. Nothing was traded.' });
});

/**
 * GET /api/ai-trading/recommendations
 * Get current AI stock recommendations
 */
router.get('/recommendations', async (req, res) => {
    try {
        const recommendations = await aiTradingBotService.getAIRecommendations(req.userId);
        res.json(recommendations);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/ai-trading/status
 * Get AI portfolio status and performance
 */
router.get('/status', async (req, res) => {
    try {
        const status = await aiTradingBotService.getAIPortfolioStatus(req.userId);
        res.json(status);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/ai-trading/analyze/:symbol
 * Get AI analysis for specific stock
 */
router.get('/analyze/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const analysis = await aiTradingBotService.analyzeStock(symbol);
        
        if (!analysis) {
            return res.status(404).json({ error: 'Stock not found or analysis failed' });
        }
        
        res.json(analysis);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
