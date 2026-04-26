const express = require('express');
const router = express.Router();
const backtestService = require('../services/backtestService');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

/**
 * GET /api/backtest/report
 * Get AI bot backtest performance report
 * Supports filtering by trade type (stocks or options)
 */
router.get('/report', async (req, res) => {
    try {
        const userId = req.userId;
        const { type = 'stocks', dateRange = 'all', strategy = 'all' } = req.query;
        
        // Get appropriate report based on type
        let report;
        if (type === 'options') {
            report = await backtestService.getOptionsBacktestReport(userId, { dateRange, strategy });
        } else {
            report = await backtestService.getBacktestReport(userId);
        }
        
        res.json(report);
    } catch (error) {
        console.error('[Backtest API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
