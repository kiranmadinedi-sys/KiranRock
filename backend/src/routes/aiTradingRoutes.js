
const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const aiTradingBotService = require('../services/aiTradingBotService');
const fs = require('fs').promises;
const path = require('path');
const USERS_FILE = path.join(__dirname, '../../users.json');

// All routes require authentication
router.use(protect);

/**
 * GET /api/ai-trading/settings
 * Retrieve user AI trading settings
 */
router.get('/settings', async (req, res) => {
    try {
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === req.userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ aiTradingSettings: user.aiTradingSettings || {} });
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
        const { stopLoss, takeProfit, minCashReserve } = req.body;
        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === req.userId);
        if (userIndex === -1) {
            return res.status(404).json({ error: 'User not found' });
        }
        users[userIndex].aiTradingSettings = {
            ...(users[userIndex].aiTradingSettings || {}),
            ...(stopLoss !== undefined ? { stopLoss: parseFloat(stopLoss) } : {}),
            ...(takeProfit !== undefined ? { takeProfit: parseFloat(takeProfit) } : {}),
            ...(minCashReserve !== undefined ? { minCashReserve: parseFloat(minCashReserve) } : {})
        };
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
        res.json({ success: true, aiTradingSettings: users[userIndex].aiTradingSettings });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/ai-trading/initialize
 * Initialize AI-managed portfolio
 */
router.post('/initialize', async (req, res) => {
    try {
        const result = await aiTradingBotService.initializeAIPortfolio(req.userId);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /api/ai-trading/rebalance
 * Rebalance portfolio based on AI recommendations
 */
router.post('/rebalance', async (req, res) => {
    try {
        const result = await aiTradingBotService.rebalancePortfolio(req.userId);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
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
