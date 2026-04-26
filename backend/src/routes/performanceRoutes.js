const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const performanceService = require('../services/performanceMetricsService');
const marketRegimeService = require('../services/marketRegimeService');
const { logger } = require('../utils/logger');

/**
 * GET /api/performance/scorecard
 * Live performance scorecard — all key metrics in one call.
 * Returns today's P&L, 30-day Sharpe, drawdown, win rate, circuit breaker status,
 * Kelly metrics, and current market regime.
 */
router.get('/scorecard', protect, async (req, res) => {
    try {
        const userId = req.userId;
        const [scorecard, regime] = await Promise.all([
            performanceService.getDailyScorecardData(userId),
            marketRegimeService.getMarketRegime()
        ]);

        if (!scorecard) {
            return res.status(500).json({ error: 'Failed to build scorecard' });
        }

        res.json({
            ...scorecard,
            market: {
                regime:           regime.regime,
                description:      regime.description,
                vix:              regime.vix,
                minBuyScore:      regime.minBuyScore,
                positionSizeMultiplier: regime.positionSizeMultiplier
            }
        });
    } catch (err) {
        logger.error('Scorecard endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/daily?date=YYYY-MM-DD
 * Single-day performance metrics.
 */
router.get('/daily', protect, async (req, res) => {
    try {
        const date = req.query.date || null;
        const data = await performanceService.getDailyPerformance(req.userId, date);
        res.json(data || {});
    } catch (err) {
        logger.error('Daily performance endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/weekly
 */
router.get('/weekly', protect, async (req, res) => {
    try {
        const data = await performanceService.getWeeklyPerformance(req.userId);
        res.json(data || {});
    } catch (err) {
        logger.error('Weekly performance endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/monthly
 */
router.get('/monthly', protect, async (req, res) => {
    try {
        const data = await performanceService.getMonthlyPerformance(req.userId);
        res.json(data || {});
    } catch (err) {
        logger.error('Monthly performance endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/sharpe?days=30
 */
router.get('/sharpe', protect, async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const sharpe = await performanceService.calculateSharpeRatio(req.userId, days);
        res.json({ sharpeRatio: sharpe, days });
    } catch (err) {
        logger.error('Sharpe endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/kelly
 * Returns Kelly Criterion inputs — win rate, avg win/loss from last 90 days.
 */
router.get('/kelly', protect, async (req, res) => {
    try {
        const metrics = await performanceService.getKellyMetrics(req.userId);
        if (!metrics) {
            return res.json({ available: false, reason: 'Need at least 10 closed trades' });
        }
        const W = metrics.winRate / 100;
        const absLoss = Math.abs(metrics.avgLoss);
        const R = absLoss > 0 ? metrics.avgWin / absLoss : 0;
        const kelly = R > 0 ? W - (1 - W) / R : 0;
        const halfKelly = Math.max(0, kelly * 0.5);

        res.json({
            available:    true,
            winRate:      metrics.winRate,
            avgWin:       metrics.avgWin,
            avgLoss:      metrics.avgLoss,
            totalTrades:  metrics.totalTrades,
            kellyFraction: kelly,
            halfKellyFraction: halfKelly,
            halfKellyPct: (halfKelly * 100).toFixed(2) + '%'
        });
    } catch (err) {
        logger.error('Kelly endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
