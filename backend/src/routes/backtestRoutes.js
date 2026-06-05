const express = require('express');
const router = express.Router();
const backtestService = require('../services/backtestService');
const ollamaBacktestService = require('../services/ollamaBacktestService');
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

/**
 * GET /api/backtest/ai-analysis
 * Deep AI-powered performance analysis using local Ollama (llama3.2:3b).
 * Analyses trade history by setup family, regime, sector, score band, hold duration.
 * Provides expert recommendations to improve bot performance — zero API cost.
 */
router.get('/ai-analysis', async (req, res) => {
    try {
        const userId = req.userId;
        const report = await ollamaBacktestService.getAIBacktestAnalysis(userId);
        res.json(report);
    } catch (error) {
        console.error('[Backtest AI-Analysis API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/backtest/stats
 * Raw pre-computed trade statistics (no Ollama) — fast response.
 */
router.get('/stats', async (req, res) => {
    try {
        const userId = req.userId;
        const stats = await ollamaBacktestService.buildTradeStats(userId);
        res.json({ hasData: stats.overall.totalTrades > 0, stats });
    } catch (error) {
        console.error('[Backtest Stats API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
