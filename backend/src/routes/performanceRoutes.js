const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const performanceService       = require('../services/performanceMetricsService');
const marketRegimeService      = require('../services/marketRegimeService');
const tradeIntelligenceService = require('../services/tradeIntelligenceService');
const overfitDetector          = require('../services/overfitDetectorService');
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
                vix:              regime.vixLevel,
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

/**
 * POST /api/performance/sync-balance
 * Recompute cash balance from full trade history (fixes $0 drift).
 */
router.post('/sync-balance', protect, async (req, res) => {
    try {
        const accountDb = require('../services/tradingAccountDatabaseService');
        const result = await accountDb.syncBalanceFromHistory(req.userId);
        res.json({ success: true, ...result });
    } catch (err) {
        logger.error('Sync balance error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/history?days=30
 * Daily P&L history for charts — returns array of { date, pnl, winRate, trades }.
 */
router.get('/history', protect, async (req, res) => {
    try {
        const days = Math.min(parseInt(req.query.days) || 30, 90);
        const { query } = require('../config/database');
        const result = await query(`
            SELECT
                date,
                total_profit_loss   AS pnl,
                win_rate            AS "winRate",
                total_trades        AS trades,
                winning_trades      AS wins,
                losing_trades       AS losses,
                sharpe_ratio        AS "sharpeRatio",
                profit_factor       AS "profitFactor"
            FROM ai_performance_metrics
            WHERE user_id = $1
              AND date >= CURRENT_DATE - ($2 * INTERVAL '1 day')
            ORDER BY date ASC
        `, [req.userId, days]);
        res.json(result.rows);
    } catch (err) {
        logger.error('Performance history error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/intelligence?days=180
 * Aggregated AI learning view from the trade decision journal.
 */
router.get('/intelligence', protect, async (req, res) => {
    try {
        const days = Math.max(7, Math.min(parseInt(req.query.days) || 180, 365));
        const compareDays = Math.max(7, Math.min(parseInt(req.query.compareDays) || Math.min(45, Math.max(14, Math.floor(days / 2))), 90));
        const botType = typeof req.query.botType === 'string' ? req.query.botType : null;
        const regime = typeof req.query.regime === 'string' ? req.query.regime : null;
        const summary = await tradeIntelligenceService.getTradeIntelligenceSummary(req.userId, {
            days,
            compareDays,
            botType,
            regime
        });
        res.json(summary);
    } catch (err) {
        logger.error('Performance intelligence endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/intelligence/drilldown
 * Raw filtered journal rows for inspecting why a setup/strategy/regime is learning the way it is.
 */
router.get('/intelligence/drilldown', protect, async (req, res) => {
    try {
        const days = Math.max(7, Math.min(parseInt(req.query.days) || 180, 365));
        const limit = Math.max(10, Math.min(parseInt(req.query.limit) || 50, 200));
        const botType = typeof req.query.botType === 'string' ? req.query.botType : null;
        const regime = typeof req.query.regime === 'string' ? req.query.regime : null;
        const strategyFamily = typeof req.query.strategyFamily === 'string' ? req.query.strategyFamily : null;
        const setupFamily = typeof req.query.setupFamily === 'string' ? req.query.setupFamily : null;
        const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : null;
        const sector = typeof req.query.sector === 'string' ? req.query.sector : null;

        const detail = await tradeIntelligenceService.getTradeIntelligenceDrilldown(req.userId, {
            days,
            limit,
            botType,
            regime,
            strategyFamily,
            setupFamily,
            symbol,
            sector
        });

        res.json(detail);
    } catch (err) {
        logger.error('Performance intelligence drilldown endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/advanced
 * Hold time, time-of-day win rate, and slippage analytics.
 * Computed from the trades table — requires at least a few closed trades.
 */
router.get('/advanced', protect, async (req, res) => {
    try {
        const metrics = await performanceService.getAdvancedMetrics(req.userId);
        res.json(metrics);
    } catch (err) {
        logger.error('Advanced metrics endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/overfit
 * Overfitting risk report — walk-forward stability, OOS decay,
 * regime concentration, and consistency ratio.
 */
router.get('/overfit', protect, async (req, res) => {
    try {
        const report = await overfitDetector.getOverfitReport(req.userId);
        res.json(report);
    } catch (err) {
        logger.error('Overfit report endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/regime?days=180
 * P&L breakdown by market regime — win rate, net P&L, avg P&L per trade.
 * Sourced from trade_decision_journal (decision_phase='CLOSED').
 */
router.get('/regime', protect, async (req, res) => {
    try {
        const days = Math.max(7, Math.min(parseInt(req.query.days) || 180, 365));
        const { query } = require('../config/database');
        const result = await query(`
            SELECT
                regime,
                COUNT(*)                                                                              AS total_trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)                                            AS wins,
                ROUND(
                    (SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::decimal / NULLIF(COUNT(*), 0)) * 100,
                    1
                )                                                                                    AS win_rate_pct,
                ROUND(SUM(pnl)::numeric, 2)                                                          AS net_pnl,
                ROUND(AVG(pnl)::numeric, 2)                                                          AS avg_pnl_per_trade,
                ROUND(AVG(pnl_percent)::numeric, 2)                                                  AS avg_pnl_pct,
                ROUND(AVG(score)::numeric, 1)                                                        AS avg_score,
                ROUND(AVG(confidence)::numeric, 1)                                                   AS avg_confidence
            FROM trade_decision_journal
            WHERE user_id       = $1
              AND decision_phase = 'CLOSED'
              AND regime         IS NOT NULL
              AND opened_at     >= NOW() - ($2 * INTERVAL '1 day')
            GROUP BY regime
            ORDER BY net_pnl DESC
        `, [req.userId, days]);

        res.json({
            days,
            regimes: result.rows.map(r => ({
                regime:          r.regime,
                totalTrades:     parseInt(r.total_trades),
                wins:            parseInt(r.wins),
                winRatePct:      parseFloat(r.win_rate_pct),
                netPnl:          parseFloat(r.net_pnl),
                avgPnlPerTrade:  parseFloat(r.avg_pnl_per_trade),
                avgPnlPct:       parseFloat(r.avg_pnl_pct),
                avgScore:        parseFloat(r.avg_score),
                avgConfidence:   parseFloat(r.avg_confidence),
            })),
        });
    } catch (err) {
        logger.error('Regime P&L endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/attribution?days=90
 * P&L breakdown by sector, plus a sector × regime win-rate heatmap.
 * Reads metadata->>'sector' from trade_decision_journal (CLOSED trades only).
 */
router.get('/attribution', protect, async (req, res) => {
    try {
        const days = Math.max(7, Math.min(parseInt(req.query.days) || 90, 365));
        const { query } = require('../config/database');

        const sectorSql = (periodClause) => `
            SELECT
                COALESCE(metadata->>'sector', 'Unknown')                                              AS sector,
                COUNT(*)                                                                              AS trades,
                SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)                                            AS wins,
                ROUND(SUM(pnl)::numeric, 2)                                                          AS total_pnl,
                ROUND(AVG(pnl)::numeric, 2)                                                          AS avg_pnl,
                ROUND(
                    (SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::decimal / NULLIF(COUNT(*), 0)) * 100,
                    1
                )                                                                                    AS win_rate
            FROM trade_decision_journal
            WHERE user_id       = $1
              AND decision_phase = 'CLOSED'
              AND pnl           IS NOT NULL
              AND ${periodClause}
            GROUP BY 1
            ORDER BY total_pnl DESC
        `;

        const [sectorRes, heatmapRes, sectorPriorRes] = await Promise.all([
            // Current period
            query(sectorSql(`opened_at >= NOW() - ($2 * INTERVAL '1 day')`), [req.userId, days]),
            // Sector × regime heatmap (current period only)
            query(`
                SELECT
                    COALESCE(metadata->>'sector', 'Unknown')                                              AS sector,
                    COALESCE(regime, 'UNKNOWN')                                                           AS regime,
                    COUNT(*)                                                                              AS trades,
                    ROUND(
                        (SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)::decimal / NULLIF(COUNT(*), 0)) * 100,
                        1
                    )                                                                                    AS win_rate,
                    ROUND(SUM(pnl)::numeric, 2)                                                          AS total_pnl
                FROM trade_decision_journal
                WHERE user_id       = $1
                  AND decision_phase = 'CLOSED'
                  AND pnl           IS NOT NULL
                  AND opened_at     >= NOW() - ($2 * INTERVAL '1 day')
                GROUP BY 1, 2
            `, [req.userId, days]),
            // Prior period (same length, shifted back) for trend arrows
            query(sectorSql(`opened_at >= NOW() - ($3 * INTERVAL '1 day') AND opened_at < NOW() - ($2 * INTERVAL '1 day')`), [req.userId, days, days * 2])
        ]);

        const mapSectorRows = rows => rows.map(r => ({
            sector:   r.sector,
            trades:   parseInt(r.trades),
            wins:     parseInt(r.wins),
            totalPnl: parseFloat(r.total_pnl),
            avgPnl:   parseFloat(r.avg_pnl),
            winRate:  parseFloat(r.win_rate)
        }));

        res.json({
            days,
            bySector:      mapSectorRows(sectorRes.rows),
            bySectorPrior: mapSectorRows(sectorPriorRes.rows),
            heatmap: heatmapRes.rows.map(r => ({
                sector:   r.sector,
                regime:   r.regime,
                trades:   parseInt(r.trades),
                winRate:  parseFloat(r.win_rate),
                totalPnl: parseFloat(r.total_pnl)
            }))
        });
    } catch (err) {
        logger.error('Attribution endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
