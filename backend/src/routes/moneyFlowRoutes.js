const express = require('express');
const router = express.Router();
const { analyzeMoneyFlow } = require('../services/moneyFlowService');
const { protect } = require('../middleware/authMiddleware');

/**
 * GET /api/moneyflow/:symbol
 * Analyzes institutional money flow and order sizes
 */
router.get('/:symbol', protect, async (req, res) => {
    try {
        const { symbol } = req.params;
        const { interval = '1d' } = req.query;
        const moneyFlow = await analyzeMoneyFlow(symbol, interval);
        res.json(moneyFlow);
    } catch (error) {
        console.error('Error in money flow route:', error);
        res.status(500).json({ error: 'Failed to analyze money flow' });
    }
});

module.exports = router;
