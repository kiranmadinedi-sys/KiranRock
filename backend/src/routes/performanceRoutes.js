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
 * GET /api/performance/hypothesis?days=180
 * The three core measurement hypotheses:
 *   1. byHoldPeriod — win rate by holding duration bucket (1-3d, 4-7d, 8-14d, 15+d)
 *   2. byExitReason — win rate by why the position was closed
 *   3. byScoreBucket — win rate by PANTHEON score tier (validates score-weighted sizing)
 * All sourced from trade_decision_journal (CLOSED phase).
 */
router.get('/hypothesis', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const userId = req.userId;
        const days = Math.max(7, Math.min(parseInt(req.query.days) || 180, 365));

        const [holdRows, exitRows, scoreRows] = await Promise.all([
            // 1. Holding period bucketed win rate (calendar days)
            query(`
                WITH closed AS (
                    SELECT
                        GREATEST(0, EXTRACT(DAY FROM (closed_at - opened_at))::int) AS hold_days,
                        pnl_percent
                    FROM trade_decision_journal
                    WHERE user_id = $1
                      AND decision_phase = 'CLOSED'
                      AND pnl_percent IS NOT NULL
                      AND opened_at IS NOT NULL
                      AND closed_at IS NOT NULL
                      AND closed_at >= NOW() - ($2 * INTERVAL '1 day')
                )
                SELECT
                    CASE
                        WHEN hold_days <= 3  THEN '1-3d'
                        WHEN hold_days <= 7  THEN '4-7d'
                        WHEN hold_days <= 14 THEN '8-14d'
                        ELSE '15+d'
                    END AS bucket,
                    MIN(hold_days)  AS sort_key,
                    COUNT(*)        AS total,
                    COUNT(*) FILTER (WHERE pnl_percent > 0) AS wins,
                    ROUND(AVG(pnl_percent)::numeric, 2) AS avg_return,
                    ROUND(MIN(pnl_percent)::numeric, 2) AS min_return,
                    ROUND(MAX(pnl_percent)::numeric, 2) AS max_return,
                    ROUND(SUM(pnl_percent)::numeric, 2) AS total_return
                FROM closed
                GROUP BY bucket
                ORDER BY sort_key
            `, [userId, days]),

            // 2. Exit reason breakdown
            query(`
                SELECT
                    COALESCE(metadata->>'exitReason', 'untagged') AS reason,
                    COUNT(*)  AS total,
                    COUNT(*) FILTER (WHERE pnl_percent > 0) AS wins,
                    ROUND(AVG(pnl_percent)::numeric, 2) AS avg_return,
                    ROUND(SUM(pnl)::numeric, 2) AS total_pnl
                FROM trade_decision_journal
                WHERE user_id = $1
                  AND decision_phase = 'CLOSED'
                  AND pnl_percent IS NOT NULL
                  AND closed_at >= NOW() - ($2 * INTERVAL '1 day')
                GROUP BY reason
                ORDER BY COUNT(*) DESC
                LIMIT 12
            `, [userId, days]),

            // 3. Score bucket win rate (validates score-weighted position sizing)
            query(`
                SELECT
                    CASE
                        WHEN score >= 95 THEN '95-100'
                        WHEN score >= 90 THEN '90-94'
                        WHEN score >= 85 THEN '85-89'
                        WHEN score >= 80 THEN '80-84'
                        ELSE '< 80'
                    END AS bucket,
                    MIN(score)  AS sort_key,
                    COUNT(*)    AS total,
                    COUNT(*) FILTER (WHERE pnl_percent > 0) AS wins,
                    ROUND(AVG(pnl_percent)::numeric, 2) AS avg_return,
                    ROUND(SUM(pnl)::numeric, 2) AS total_pnl
                FROM trade_decision_journal
                WHERE user_id = $1
                  AND decision_phase = 'CLOSED'
                  AND score IS NOT NULL
                  AND pnl_percent IS NOT NULL
                  AND closed_at >= NOW() - ($2 * INTERVAL '1 day')
                GROUP BY bucket
                ORDER BY sort_key DESC NULLS LAST
            `, [userId, days])
        ]);

        const toWR = (wins, total) => total > 0 ? Math.round((parseInt(wins) / parseInt(total)) * 100) : 0;

        res.json({
            days,
            byHoldPeriod: holdRows.rows.map(r => ({
                bucket:      r.bucket,
                total:       parseInt(r.total),
                wins:        parseInt(r.wins),
                winRate:     toWR(r.wins, r.total),
                avgReturn:   parseFloat(r.avg_return) || 0,
                minReturn:   parseFloat(r.min_return) || 0,
                maxReturn:   parseFloat(r.max_return) || 0,
            })),
            byExitReason: exitRows.rows.map(r => ({
                reason:    r.reason,
                total:     parseInt(r.total),
                wins:      parseInt(r.wins),
                winRate:   toWR(r.wins, r.total),
                avgReturn: parseFloat(r.avg_return) || 0,
                totalPnl:  parseFloat(r.total_pnl) || 0,
            })),
            byScoreBucket: scoreRows.rows.map(r => ({
                bucket:    r.bucket,
                total:     parseInt(r.total),
                wins:      parseInt(r.wins),
                winRate:   toWR(r.wins, r.total),
                avgReturn: parseFloat(r.avg_return) || 0,
                totalPnl:  parseFloat(r.total_pnl) || 0,
            })),
        });
    } catch (err) {
        logger.error('Hypothesis endpoint error', { error: err.message });
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

/**
 * GET /api/performance/calibration
 * Returns the latest score-calibration report for the dashboard.
 * Shows per-bucket profit factor, win rate, and the suggested minBuyScore.
 * This is read-only — the user applies any threshold change manually in config.
 */
router.get('/calibration', protect, async (req, res) => {
    try {
        const scoreCalibratorService = require('../services/scoreCalibratorService');
        const report = await scoreCalibratorService.buildCalibrationReport(req.userId);
        res.json(report);
    } catch (err) {
        logger.error('Calibration endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── Trade Attribution ────────────────────────────────────────────────────────

// Create a stable DB view the first time any user hits this endpoint so the
// user can query it directly: SELECT * FROM trade_attribution WHERE user_id=...
let _tradeAttributionViewCreated = false;
async function ensureTradeAttributionView(query) {
    if (_tradeAttributionViewCreated) return;
    await query(`
        CREATE OR REPLACE VIEW trade_attribution AS
        SELECT
            j.id,
            j.user_id,
            j.symbol,
            j.score,
            j.confidence,
            j.regime,
            j.setup_family,
            j.strategy_family,
            j.outcome,
            j.entry_price,
            j.exit_price,
            j.pnl,
            j.pnl_percent,
            j.opened_at,
            j.closed_at,
            EXTRACT(DAY FROM (j.closed_at - j.opened_at))::int AS hold_days,
            CASE
                WHEN j.score >= 95 THEN '95-100'
                WHEN j.score >= 90 THEN '90-94'
                WHEN j.score >= 85 THEN '85-89'
                WHEN j.score >= 80 THEN '80-84'
                WHEN j.score IS NOT NULL THEN '< 80'
                ELSE 'No Score'
            END AS score_bucket,
            j.metadata->>'sector'               AS sector,
            j.metadata->>'exitReason'           AS exit_reason,
            j.metadata->>'winLossReason'        AS win_loss_reason,
            (j.metadata->>'atrPct')::numeric    AS atr_pct,
            (j.metadata->>'daysToEarnings')::numeric      AS dte_at_entry,
            (j.metadata->>'daysToEarningsAtExit')::numeric AS dte_at_exit,
            j.metadata->>'bullBearRatio'        AS bull_bear_ratio
        FROM trade_decision_journal j
        WHERE j.decision_phase = 'CLOSED'
          AND j.pnl IS NOT NULL
    `);
    _tradeAttributionViewCreated = true;
}

/**
 * GET /api/performance/trade-attribution?days=180&outcome=win|loss|breakeven
 *
 * Returns per-trade attribution detail plus aggregation breakdowns by:
 *   score bucket · confidence bucket · sector · regime · exit reason · hold period
 *
 * Each aggregation row includes avgWinPct + avgLossPct so the frontend can
 * compute % expectancy = (winRate/100 * avgWinPct) - ((1 - winRate/100) * |avgLossPct|)
 *
 * Also returns post-exit drift (5d and 10d) from daily_bars for trades where
 * that data exists — answers "did we exit too early or at the right time?"
 */
router.get('/trade-attribution', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        await ensureTradeAttributionView(query);

        const userId  = req.userId;
        const days    = Math.max(7, Math.min(parseInt(req.query.days) || 365, 730));
        const symbol  = typeof req.query.symbol === 'string' ? req.query.symbol.toUpperCase() : null;
        const sector  = typeof req.query.sector === 'string' ? req.query.sector : null;
        const outcome = typeof req.query.outcome === 'string' ? req.query.outcome : null;

        const extraClauses = [];
        const params = [userId, days];
        if (symbol)  { params.push(symbol);  extraClauses.push(`j.symbol = $${params.length}`); }
        if (sector)  { params.push(sector);  extraClauses.push(`j.metadata->>'sector' = $${params.length}`); }
        if (outcome) { params.push(outcome); extraClauses.push(`j.outcome = $${params.length}`); }
        const extraWhere = extraClauses.length ? 'AND ' + extraClauses.join(' AND ') : '';

        // ── 1. Per-trade rows with post-exit drift from daily_bars ─────────────
        const tradesRes = await query(`
            SELECT
                j.id,
                j.symbol,
                j.score,
                j.confidence,
                j.regime,
                j.setup_family,
                j.strategy_family,
                j.outcome,
                j.entry_price,
                j.exit_price,
                j.pnl,
                j.pnl_percent,
                j.opened_at,
                j.closed_at,
                EXTRACT(DAY FROM (j.closed_at - j.opened_at))::int AS hold_days,
                j.metadata->>'sector'               AS sector,
                j.metadata->>'exitReason'           AS exit_reason,
                j.metadata->>'winLossReason'        AS win_loss_reason,
                j.metadata->>'atrPct'               AS atr_pct,
                j.metadata->>'daysToEarnings'       AS dte_at_entry,
                j.metadata->>'daysToEarningsAtExit' AS dte_at_exit,
                j.metadata->>'bullBearRatio'        AS bull_bear_ratio,
                j.metadata->'autoTags'              AS auto_tags,
                -- Post-exit drift: closest daily_bars close >= 5 calendar days after exit
                (SELECT ROUND(((b5.close - j.exit_price) / NULLIF(j.exit_price,0) * 100)::numeric, 2)
                 FROM daily_bars b5
                 WHERE b5.symbol = j.symbol
                   AND b5.timestamp >= j.closed_at + INTERVAL '5 days'
                   AND b5.timestamp <= j.closed_at + INTERVAL '9 days'
                 ORDER BY b5.timestamp ASC LIMIT 1
                ) AS post_exit_drift_5d,
                (SELECT ROUND(((b10.close - j.exit_price) / NULLIF(j.exit_price,0) * 100)::numeric, 2)
                 FROM daily_bars b10
                 WHERE b10.symbol = j.symbol
                   AND b10.timestamp >= j.closed_at + INTERVAL '10 days'
                   AND b10.timestamp <= j.closed_at + INTERVAL '16 days'
                 ORDER BY b10.timestamp ASC LIMIT 1
                ) AS post_exit_drift_10d
            FROM trade_decision_journal j
            WHERE j.user_id = $1
              AND j.decision_phase = 'CLOSED'
              AND j.pnl IS NOT NULL
              AND j.closed_at >= NOW() - ($2 * INTERVAL '1 day')
              ${extraWhere}
            ORDER BY j.closed_at DESC
            LIMIT 200
        `, params);

        // ── 2. Aggregations ────────────────────────────────────────────────────
        // avgWinPct / avgLossPct enable % expectancy on the frontend without
        // needing separate API calls.
        const aggParams = [userId, days];
        if (symbol)  aggParams.push(symbol);
        if (sector)  aggParams.push(sector);
        if (outcome) aggParams.push(outcome);

        const buildAgg = (groupExpr) => query(`
            SELECT
                ${groupExpr} AS bucket,
                COUNT(*)                                                              AS total,
                COUNT(*) FILTER (WHERE pnl > 0)                                     AS wins,
                ROUND(COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*),0) * 100, 1)
                                                                                     AS win_rate,
                ROUND(AVG(pnl_percent)::numeric, 2)                                 AS avg_return,
                ROUND(SUM(pnl)::numeric, 2)                                         AS total_pnl,
                ROUND(AVG(CASE WHEN pnl > 0 THEN pnl     ELSE NULL END)::numeric, 2) AS avg_win,
                ROUND(AVG(CASE WHEN pnl < 0 THEN pnl     ELSE NULL END)::numeric, 2) AS avg_loss,
                ROUND(AVG(CASE WHEN pnl > 0 THEN pnl_percent ELSE NULL END)::numeric, 2) AS avg_win_pct,
                ROUND(AVG(CASE WHEN pnl < 0 THEN pnl_percent ELSE NULL END)::numeric, 2) AS avg_loss_pct
            FROM trade_decision_journal j
            WHERE j.user_id = $1
              AND j.decision_phase = 'CLOSED'
              AND j.pnl IS NOT NULL
              AND j.closed_at >= NOW() - ($2 * INTERVAL '1 day')
              ${extraWhere}
            GROUP BY bucket
            ORDER BY total_pnl DESC NULLS LAST
        `, aggParams);

        // Exit Quality aggregation uses a CTE to join daily_bars once per trade,
        // then aggregates both P&L metrics and post-exit drift by exit reason.
        const exitQualityAgg = query(`
            WITH td AS (
                SELECT
                    j.pnl,
                    j.pnl_percent,
                    j.exit_price,
                    j.closed_at,
                    j.symbol,
                    COALESCE(j.metadata->>'exitReason', 'untagged') AS exit_reason,
                    (SELECT b5.close
                     FROM daily_bars b5
                     WHERE b5.symbol = j.symbol
                       AND b5.timestamp >= j.closed_at + INTERVAL '5 days'
                       AND b5.timestamp <= j.closed_at + INTERVAL '9 days'
                     ORDER BY b5.timestamp ASC LIMIT 1) AS price_5d,
                    (SELECT b10.close
                     FROM daily_bars b10
                     WHERE b10.symbol = j.symbol
                       AND b10.timestamp >= j.closed_at + INTERVAL '10 days'
                       AND b10.timestamp <= j.closed_at + INTERVAL '16 days'
                     ORDER BY b10.timestamp ASC LIMIT 1) AS price_10d
                FROM trade_decision_journal j
                WHERE j.user_id = $1
                  AND j.decision_phase = 'CLOSED'
                  AND j.pnl IS NOT NULL
                  AND j.closed_at >= NOW() - ($2 * INTERVAL '1 day')
                  ${extraWhere}
            )
            SELECT
                exit_reason                                                           AS bucket,
                COUNT(*)                                                              AS total,
                COUNT(*) FILTER (WHERE pnl > 0)                                     AS wins,
                ROUND(COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*),0) * 100, 1) AS win_rate,
                ROUND(AVG(pnl_percent)::numeric, 2)                                 AS avg_return,
                ROUND(SUM(pnl)::numeric, 2)                                         AS total_pnl,
                ROUND(AVG(CASE WHEN pnl > 0 THEN pnl     ELSE NULL END)::numeric, 2) AS avg_win,
                ROUND(AVG(CASE WHEN pnl < 0 THEN pnl     ELSE NULL END)::numeric, 2) AS avg_loss,
                ROUND(AVG(CASE WHEN pnl > 0 THEN pnl_percent ELSE NULL END)::numeric, 2) AS avg_win_pct,
                ROUND(AVG(CASE WHEN pnl < 0 THEN pnl_percent ELSE NULL END)::numeric, 2) AS avg_loss_pct,
                ROUND(AVG(CASE WHEN price_5d  IS NOT NULL
                               THEN (price_5d  - exit_price) / NULLIF(exit_price,0) * 100
                          END)::numeric, 2) AS avg_drift_5d,
                ROUND(AVG(CASE WHEN price_10d IS NOT NULL
                               THEN (price_10d - exit_price) / NULLIF(exit_price,0) * 100
                          END)::numeric, 2) AS avg_drift_10d,
                COUNT(*) FILTER (WHERE price_10d IS NOT NULL)                       AS drift_sample_count
            FROM td
            GROUP BY exit_reason
            ORDER BY total DESC
        `, aggParams);

        const [byScore, byConfidence, bySector, byRegime, byExit, byHold, byOutcome] = await Promise.all([
            buildAgg(`CASE
                WHEN score >= 95 THEN '95-100'
                WHEN score >= 90 THEN '90-94'
                WHEN score >= 85 THEN '85-89'
                WHEN score >= 80 THEN '80-84'
                WHEN score IS NOT NULL THEN '< 80'
                ELSE 'No Score'
            END`),
            buildAgg(`CASE
                WHEN confidence >= 90 THEN '90-100'
                WHEN confidence >= 80 THEN '80-89'
                WHEN confidence >= 70 THEN '70-79'
                WHEN confidence IS NOT NULL THEN '< 70'
                ELSE 'No Conf'
            END`),
            buildAgg(`COALESCE(metadata->>'sector', 'Unknown')`),
            buildAgg(`COALESCE(regime, 'UNKNOWN')`),
            exitQualityAgg,  // replaces plain buildAgg for byExit — includes drift
            buildAgg(`CASE
                WHEN EXTRACT(DAY FROM (closed_at - opened_at)) <= 1  THEN '0-1d'
                WHEN EXTRACT(DAY FROM (closed_at - opened_at)) <= 3  THEN '2-3d'
                WHEN EXTRACT(DAY FROM (closed_at - opened_at)) <= 7  THEN '4-7d'
                WHEN EXTRACT(DAY FROM (closed_at - opened_at)) <= 14 THEN '8-14d'
                ELSE '15+d'
            END`),
            buildAgg(`COALESCE(outcome, 'unknown')`),
        ]);

        const mapAgg = (rows, includeDrift = false) => rows.map(r => {
            const wr = parseFloat(r.win_rate) || 0;
            const awp = parseFloat(r.avg_win_pct) || 0;
            const alp = parseFloat(r.avg_loss_pct) || 0; // negative
            const expectancyPct = parseFloat(((wr / 100) * awp + (1 - wr / 100) * alp).toFixed(2));
            const base = {
                bucket:        r.bucket,
                total:         parseInt(r.total),
                wins:          parseInt(r.wins),
                winRate:       wr,
                avgReturn:     parseFloat(r.avg_return) || 0,
                totalPnl:      parseFloat(r.total_pnl) || 0,
                avgWin:        parseFloat(r.avg_win) || 0,
                avgLoss:       parseFloat(r.avg_loss) || 0,
                avgWinPct:     awp,
                avgLossPct:    alp,
                expectancyPct,
            };
            if (!includeDrift) return base;
            return {
                ...base,
                avgDrift5d:       r.avg_drift_5d  != null ? parseFloat(r.avg_drift_5d)  : null,
                avgDrift10d:      r.avg_drift_10d != null ? parseFloat(r.avg_drift_10d) : null,
                driftSampleCount: parseInt(r.drift_sample_count) || 0,
            };
        });

        // ── 3. Post-exit summary across all closed trades ──────────────────────
        // Average drift tells us whether exits are systematically early or late.
        const driftRows = tradesRes.rows.filter(r => r.post_exit_drift_5d != null);
        const avgDrift5d  = driftRows.length
            ? parseFloat((driftRows.reduce((s, r) => s + parseFloat(r.post_exit_drift_5d), 0) / driftRows.length).toFixed(2))
            : null;
        const driftRows10 = tradesRes.rows.filter(r => r.post_exit_drift_10d != null);
        const avgDrift10d = driftRows10.length
            ? parseFloat((driftRows10.reduce((s, r) => s + parseFloat(r.post_exit_drift_10d), 0) / driftRows10.length).toFixed(2))
            : null;

        res.json({
            days,
            filters: { symbol, sector, outcome },
            totalClosed: tradesRes.rows.length,
            postExitSummary: {
                avgDrift5d,
                avgDrift10d,
                tradesWithDriftData: driftRows.length,
            },
            trades: tradesRes.rows.map(r => ({
                id:              r.id,
                symbol:          r.symbol,
                score:           r.score     != null ? parseFloat(r.score)      : null,
                confidence:      r.confidence != null ? parseFloat(r.confidence) : null,
                regime:          r.regime,
                setupFamily:     r.setup_family,
                strategyFamily:  r.strategy_family,
                outcome:         r.outcome,
                entryPrice:      r.entry_price  != null ? parseFloat(r.entry_price)  : null,
                exitPrice:       r.exit_price   != null ? parseFloat(r.exit_price)   : null,
                pnl:             r.pnl          != null ? parseFloat(r.pnl)          : null,
                pnlPct:          r.pnl_percent  != null ? parseFloat(r.pnl_percent)  : null,
                openedAt:        r.opened_at,
                closedAt:        r.closed_at,
                holdDays:        r.hold_days,
                sector:          r.sector,
                exitReason:      r.exit_reason,
                winLossReason:   r.win_loss_reason,
                atrPct:          r.atr_pct      != null ? parseFloat(r.atr_pct)      : null,
                dteAtEntry:      r.dte_at_entry  != null ? parseFloat(r.dte_at_entry)  : null,
                dteAtExit:       r.dte_at_exit   != null ? parseFloat(r.dte_at_exit)   : null,
                bullBearRatio:   r.bull_bear_ratio != null ? parseFloat(r.bull_bear_ratio) : null,
                autoTags:        r.auto_tags || [],
                postExitDrift5d:  r.post_exit_drift_5d  != null ? parseFloat(r.post_exit_drift_5d)  : null,
                postExitDrift10d: r.post_exit_drift_10d != null ? parseFloat(r.post_exit_drift_10d) : null,
            })),
            byScore:       mapAgg(byScore.rows),
            byConfidence:  mapAgg(byConfidence.rows),
            bySector:      mapAgg(bySector.rows),
            byRegime:      mapAgg(byRegime.rows),
            byExit:        mapAgg(byExit.rows, true),  // includes avgDrift5d/10d
            byHold:        mapAgg(byHold.rows),
            byOutcome:     mapAgg(byOutcome.rows),
        });
    } catch (err) {
        logger.error('Trade attribution endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

// ─── Weekly Trading Reports ───────────────────────────────────────────────────

const weeklyTradingReportService = require('../services/weeklyTradingReportService');

/**
 * GET /api/performance/trading-report
 * Returns the most recent stored weekly trading performance report for the user.
 * If none stored, generates the current week on-the-fly.
 */
router.get('/trading-report', protect, async (req, res) => {
    try {
        const report = await weeklyTradingReportService.getLatestReport(req.userId);
        res.json(report);
    } catch (err) {
        logger.error('Trading report endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/trading-report/history
 * Returns a list of past weekly reports (summary only) for the user.
 */
router.get('/trading-report/history', protect, async (req, res) => {
    try {
        const limit = Math.min(parseInt(req.query.limit) || 12, 52);
        const history = await weeklyTradingReportService.getReportHistory(req.userId, limit);
        res.json(history);
    } catch (err) {
        logger.error('Trading report history endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/trading-report/:id
 * Returns a specific historical weekly report by ID.
 */
router.get('/trading-report/:id', protect, async (req, res) => {
    try {
        const report = await weeklyTradingReportService.getReportById(req.userId, parseInt(req.params.id));
        if (!report) return res.status(404).json({ error: 'Report not found' });
        res.json(report);
    } catch (err) {
        logger.error('Trading report by id endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/performance/trading-report/generate
 * Manually generates (or regenerates) the weekly report for the current or specified week.
 * Body: { weekStart?: 'YYYY-MM-DD', weekEnd?: 'YYYY-MM-DD' }
 */
router.post('/trading-report/generate', protect, async (req, res) => {
    try {
        const { weekStart, weekEnd } = req.body?.weekStart
            ? req.body
            : weeklyTradingReportService.currentWeekRange();
        const report = await weeklyTradingReportService.generateWeeklyReport(req.userId, weekStart, weekEnd);
        res.json({ success: true, report });
    } catch (err) {
        logger.error('Generate trading report endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/score-analysis?days=90
 * AI score calibration from the trades table (ai_score on SELL records).
 * Buckets are tuned to this bot's threshold range (base minBuyScore = 88).
 * Returns win rate, avg return, and expectancy per bucket so you can see
 * whether raising/lowering the score floor improves outcomes.
 */
router.get('/score-analysis', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const days = Math.max(7, Math.min(parseInt(req.query.days) || 90, 365));
        const userId = req.userId;

        const result = await query(`
            WITH sells AS (
                SELECT
                    ai_score,
                    pnl,
                    pnl_percent
                FROM trades
                WHERE user_id  = $1
                  AND action   = 'SELL'
                  AND ai_score IS NOT NULL
                  AND pnl      IS NOT NULL
                  AND trade_date >= NOW() - ($2 * INTERVAL '1 day')
            )
            SELECT
                CASE
                    WHEN ai_score >= 98 THEN '98-100'
                    WHEN ai_score >= 95 THEN '95-97'
                    WHEN ai_score >= 92 THEN '92-94'
                    WHEN ai_score >= 88 THEN '88-91'
                    ELSE '< 88'
                END                                                                 AS bucket,
                MIN(ai_score)                                                       AS sort_key,
                COUNT(*)                                                            AS total,
                COUNT(*) FILTER (WHERE pnl > 0)                                    AS wins,
                COUNT(*) FILTER (WHERE pnl < 0)                                    AS losses,
                ROUND(
                    COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*),0) * 100,
                    1
                )                                                                   AS win_rate,
                ROUND(AVG(pnl_percent)::numeric, 2)                                AS avg_return,
                ROUND(SUM(pnl)::numeric, 2)                                        AS total_pnl,
                ROUND(AVG(pnl)::numeric, 2)                                        AS avg_pnl,
                ROUND(AVG(CASE WHEN pnl > 0 THEN pnl_percent END)::numeric, 2)    AS avg_win_pct,
                ROUND(AVG(CASE WHEN pnl < 0 THEN pnl_percent END)::numeric, 2)    AS avg_loss_pct,
                ROUND(MIN(ai_score)::numeric, 1)                                   AS min_score,
                ROUND(MAX(ai_score)::numeric, 1)                                   AS max_score,
                ROUND(AVG(ai_score)::numeric, 1)                                   AS avg_score
            FROM sells
            GROUP BY bucket
            ORDER BY sort_key DESC NULLS LAST
        `, [userId, days]);

        const toWR = (wins, total) => total > 0 ? Math.round((parseInt(wins) / parseInt(total)) * 100) : 0;

        const buckets = result.rows.map(r => {
            const wr  = parseFloat(r.win_rate) || 0;
            const awp = parseFloat(r.avg_win_pct) || 0;
            const alp = parseFloat(r.avg_loss_pct) || 0; // negative
            const expectancy = parseFloat(((wr / 100) * awp + (1 - wr / 100) * alp).toFixed(2));
            return {
                bucket:       r.bucket,
                total:        parseInt(r.total),
                wins:         parseInt(r.wins),
                losses:       parseInt(r.losses),
                winRate:      wr,
                avgReturn:    parseFloat(r.avg_return) || 0,
                totalPnl:     parseFloat(r.total_pnl) || 0,
                avgPnl:       parseFloat(r.avg_pnl) || 0,
                avgWinPct:    awp,
                avgLossPct:   alp,
                expectancy,
                minScore:     parseFloat(r.min_score) || 0,
                maxScore:     parseFloat(r.max_score) || 0,
                avgScore:     parseFloat(r.avg_score) || 0,
            };
        });

        res.json({ days, buckets });
    } catch (err) {
        logger.error('Score analysis endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/hold-time-analysis?days=90
 * Hold-time performance analysis using the hold_hours column on SELL records.
 * Buckets: ≤24h (day-trade/overnight), 25-48h, 49-72h, 73-96h, 97-120h, >120h.
 * Helps identify whether shorter or longer holds produce better outcomes for this bot.
 */
router.get('/hold-time-analysis', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const days = Math.max(7, Math.min(parseInt(req.query.days) || 90, 365));
        const userId = req.userId;

        const result = await query(`
            WITH sells AS (
                SELECT
                    hold_hours,
                    pnl,
                    pnl_percent
                FROM trades
                WHERE user_id    = $1
                  AND action     = 'SELL'
                  AND hold_hours IS NOT NULL
                  AND pnl        IS NOT NULL
                  AND trade_date >= NOW() - ($2 * INTERVAL '1 day')
            )
            SELECT
                CASE
                    WHEN hold_hours <= 24  THEN '0-24h'
                    WHEN hold_hours <= 48  THEN '25-48h'
                    WHEN hold_hours <= 72  THEN '49-72h'
                    WHEN hold_hours <= 96  THEN '73-96h'
                    WHEN hold_hours <= 120 THEN '97-120h'
                    ELSE '120h+'
                END                                                                  AS bucket,
                MIN(hold_hours)                                                      AS sort_key,
                COUNT(*)                                                             AS total,
                COUNT(*) FILTER (WHERE pnl > 0)                                     AS wins,
                COUNT(*) FILTER (WHERE pnl < 0)                                     AS losses,
                ROUND(
                    COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*),0) * 100,
                    1
                )                                                                    AS win_rate,
                ROUND(AVG(pnl_percent)::numeric, 2)                                 AS avg_return,
                ROUND(SUM(pnl)::numeric, 2)                                         AS total_pnl,
                ROUND(AVG(pnl)::numeric, 2)                                         AS avg_pnl,
                ROUND(AVG(CASE WHEN pnl > 0 THEN pnl_percent END)::numeric, 2)     AS avg_win_pct,
                ROUND(AVG(CASE WHEN pnl < 0 THEN pnl_percent END)::numeric, 2)     AS avg_loss_pct,
                ROUND(MIN(hold_hours)::numeric, 1)                                  AS min_hours,
                ROUND(MAX(hold_hours)::numeric, 1)                                  AS max_hours,
                ROUND(AVG(hold_hours)::numeric, 1)                                  AS avg_hours
            FROM sells
            GROUP BY bucket
            ORDER BY sort_key ASC
        `, [userId, days]);

        const buckets = result.rows.map(r => {
            const wr  = parseFloat(r.win_rate) || 0;
            const awp = parseFloat(r.avg_win_pct) || 0;
            const alp = parseFloat(r.avg_loss_pct) || 0;
            const expectancy = parseFloat(((wr / 100) * awp + (1 - wr / 100) * alp).toFixed(2));
            return {
                bucket:     r.bucket,
                total:      parseInt(r.total),
                wins:       parseInt(r.wins),
                losses:     parseInt(r.losses),
                winRate:    wr,
                avgReturn:  parseFloat(r.avg_return) || 0,
                totalPnl:   parseFloat(r.total_pnl) || 0,
                avgPnl:     parseFloat(r.avg_pnl) || 0,
                avgWinPct:  awp,
                avgLossPct: alp,
                expectancy,
                minHours:   parseFloat(r.min_hours) || 0,
                maxHours:   parseFloat(r.max_hours) || 0,
                avgHours:   parseFloat(r.avg_hours) || 0,
            };
        });

        res.json({ days, buckets });
    } catch (err) {
        logger.error('Hold-time analysis endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
