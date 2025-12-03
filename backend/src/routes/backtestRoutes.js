const express = require('express');
const router = express.Router();
const backtestService = require('../services/backtestService');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

/**
 * GET /api/backtest/report
 * Get AI bot backtest performance report
 */
router.get('/report', async (req, res) => {
    try {
        const userId = req.userId;
        const report = await backtestService.getBacktestReport(userId);
        res.json(report);
    } catch (error) {
        console.error('[Backtest API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
