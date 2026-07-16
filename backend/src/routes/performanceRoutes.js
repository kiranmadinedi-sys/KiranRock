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
            j.metadata->>'bullBearRatio'        AS bull_bear_ratio,
            j.metadata->>'strategyVersion'      AS strategy_version
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
                j.metadata->>'strategyVersion'       AS strategy_version,
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
                ) AS post_exit_drift_10d,
                -- MFE/MAE: best/worst the position ever showed WHILE HELD, from daily bar
                -- highs/lows between entry and exit — answers "did we leave gains on the
                -- table" or "did the stop save us from something worse" (daily resolution,
                -- not tick-precise, but enough to see the shape of the trade — added 2026-07-11).
                (SELECT ROUND(((MAX(bh.high) - j.entry_price) / NULLIF(j.entry_price,0) * 100)::numeric, 2)
                 FROM daily_bars bh
                 WHERE bh.symbol = j.symbol
                   AND bh.timestamp >= j.opened_at
                   AND bh.timestamp <= j.closed_at
                ) AS mfe_pct,
                (SELECT ROUND(((MIN(bl.low) - j.entry_price) / NULLIF(j.entry_price,0) * 100)::numeric, 2)
                 FROM daily_bars bl
                 WHERE bl.symbol = j.symbol
                   AND bl.timestamp >= j.opened_at
                   AND bl.timestamp <= j.closed_at
                ) AS mae_pct
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

        const [byScore, byConfidence, bySector, byRegime, byExit, byHold, byOutcome, byVersion] = await Promise.all([
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
            buildAgg(`COALESCE(metadata->>'strategyVersion', 'pre-versioning')`),
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

        // Capture efficiency: of the best move a WINNING trade ever showed (MFE), how much
        // did we actually keep at exit? Only meaningful for winners — on a losing trade a
        // tiny favorable excursion (e.g. MFE +1.2%) divided into a real loss (-5.1%) produces
        // a meaningless triple-digit-negative ratio, which drowns out the actual signal.
        // Losers are better read via MAE-vs-exit (below): did the stop fire near the trade's
        // worst point, or well before/after it (added 2026-07-11, per review).
        const mfeRows = tradesRes.rows.filter(r => r.mfe_pct != null && parseFloat(r.mfe_pct) > 0 && r.pnl_percent != null && parseFloat(r.pnl_percent) > 0);
        const avgCaptureEfficiencyPct = mfeRows.length
            ? parseFloat((mfeRows.reduce((s, r) => s + (parseFloat(r.pnl_percent) / parseFloat(r.mfe_pct) * 100), 0) / mfeRows.length).toFixed(1))
            : null;
        const maeRows = tradesRes.rows.filter(r => r.mae_pct != null);
        const avgMaePct = maeRows.length
            ? parseFloat((maeRows.reduce((s, r) => s + parseFloat(r.mae_pct), 0) / maeRows.length).toFixed(2))
            : null;

        res.json({
            days,
            filters: { symbol, sector, outcome },
            totalClosed: tradesRes.rows.length,
            postExitSummary: {
                avgDrift5d,
                avgDrift10d,
                tradesWithDriftData: driftRows.length,
                avgCaptureEfficiencyPct,
                avgMaePct,
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
                mfePct:          r.mfe_pct != null ? parseFloat(r.mfe_pct) : null,
                maePct:          r.mae_pct != null ? parseFloat(r.mae_pct) : null,
                strategyVersion: r.strategy_version,
            })),
            byScore:       mapAgg(byScore.rows),
            byConfidence:  mapAgg(byConfidence.rows),
            bySector:      mapAgg(bySector.rows),
            byRegime:      mapAgg(byRegime.rows),
            byExit:        mapAgg(byExit.rows, true),  // includes avgDrift5d/10d
            byHold:        mapAgg(byHold.rows),
            byOutcome:     mapAgg(byOutcome.rows),
            byVersion:     mapAgg(byVersion.rows),
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

/**
 * GET /api/performance/trade-log?days=90&outcome=win|loss&sector=X&regime=X&exitType=X&minScore=N&maxScore=N
 * Full closed-trade history from the trades table (action='SELL').
 * Joins matching BUY record to get entry_price, ai_score, sector, entry_regime.
 * This is the ground-truth source — every executed trade appears here.
 */
router.get('/trade-log', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const userId   = req.userId;
        const days     = Math.max(7, Math.min(parseInt(req.query.days) || 90, 365));
        const outcome  = typeof req.query.outcome  === 'string' ? req.query.outcome  : null;
        const sector   = typeof req.query.sector   === 'string' ? req.query.sector   : null;
        const regime   = typeof req.query.regime   === 'string' ? req.query.regime   : null;
        const exitType = typeof req.query.exitType === 'string' ? req.query.exitType : null;
        const minScore = parseFloat(req.query.minScore) || null;
        const maxScore = parseFloat(req.query.maxScore) || null;

        // Build WHERE clauses
        const clauses = [
            `s.user_id   = $1`,
            `s.action    = 'SELL'`,
            `s.trade_date >= NOW() - ($2 * INTERVAL '1 day')`,
            `s.pnl       IS NOT NULL`,
        ];
        const params = [userId, days];

        if (outcome === 'win')  { clauses.push(`s.pnl > 0`); }
        if (outcome === 'loss') { clauses.push(`s.pnl < 0`); }
        if (sector)  { params.push(sector);   clauses.push(`COALESCE(s.sector, b.sector) = $${params.length}`); }
        if (regime)  { params.push(regime);   clauses.push(`COALESCE(s.entry_regime, b.entry_regime) = $${params.length}`); }
        if (minScore != null) { params.push(minScore); clauses.push(`COALESCE(s.ai_score, b.ai_score) >= $${params.length}`); }
        if (maxScore != null) { params.push(maxScore); clauses.push(`COALESCE(s.ai_score, b.ai_score) <= $${params.length}`); }
        if (exitType) {
            params.push(`%${exitType}%`);
            clauses.push(`(s.notes ILIKE $${params.length} OR s.executed_by ILIKE $${params.length})`);
        }

        const whereClause = clauses.join(' AND ');

        const result = await query(`
            SELECT
                s.id,
                s.symbol,
                s.quantity,
                s.price                                              AS exit_price,
                s.trade_date                                         AS closed_at,
                s.pnl,
                s.pnl_percent,
                s.hold_hours,
                s.slippage_pct,
                s.notes                                              AS exit_notes,
                s.executed_by,
                -- prefer data from SELL record, fall back to matched BUY
                COALESCE(s.ai_score,      b.ai_score)               AS ai_score,
                COALESCE(s.sector,        b.sector)                 AS sector,
                COALESCE(s.entry_regime,  b.entry_regime)           AS entry_regime,
                b.price                                              AS entry_price,
                b.trade_date                                         AS opened_at,
                b.notes                                              AS entry_notes
            FROM trades s
            LEFT JOIN LATERAL (
                SELECT price, trade_date, ai_score, sector, entry_regime, notes
                FROM   trades
                WHERE  user_id   = s.user_id
                  AND  symbol    = s.symbol
                  AND  action    = 'BUY'
                  AND  trade_date <= s.trade_date
                ORDER BY trade_date DESC
                LIMIT 1
            ) b ON true
            WHERE ${whereClause}
            ORDER BY s.trade_date DESC
            LIMIT 500
        `, params);

        const toWinLoss = (pnl) => pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'breakeven';

        // Derive exit type from notes/executed_by
        function deriveExitType(notes, executedBy) {
            const n = (notes || '').toLowerCase();
            const e = (executedBy || '').toLowerCase();
            if (/trailing.stop|trail/i.test(n + e))                    return 'trailing_stop';
            if (/partial.*profit|partial.*take|locking/i.test(n + e))  return 'partial_take_profit';
            if (/take.profit|profit.target/i.test(n + e))              return 'take_profit';
            if (/stop.loss|stopped.out|stop loss/i.test(n + e))        return 'stop_loss';
            if (/reconcil/i.test(e))                                    return 'stop_loss';
            if (/slow.mover|max.hold|time.exit/i.test(n + e))          return 'time_exit';
            if (/manual/i.test(e))                                      return 'manual';
            return 'bot';
        }

        const trades = result.rows.map(r => ({
            id:          r.id,
            symbol:      r.symbol,
            quantity:    parseFloat(r.quantity),
            exitPrice:   r.exit_price  != null ? parseFloat(r.exit_price)  : null,
            entryPrice:  r.entry_price != null ? parseFloat(r.entry_price) : null,
            closedAt:    r.closed_at,
            openedAt:    r.opened_at,
            pnl:         r.pnl         != null ? parseFloat(r.pnl)         : null,
            pnlPct:      r.pnl_percent != null ? parseFloat(r.pnl_percent) : null,
            holdHours:   r.hold_hours  != null ? parseFloat(r.hold_hours)  : null,
            slippagePct: r.slippage_pct != null ? parseFloat(r.slippage_pct) : null,
            aiScore:     r.ai_score    != null ? parseFloat(r.ai_score)    : null,
            sector:      r.sector      || null,
            regime:      r.entry_regime || null,
            exitType:    deriveExitType(r.exit_notes, r.executed_by),
            executedBy:  r.executed_by || null,
            outcome:     r.pnl != null ? toWinLoss(parseFloat(r.pnl)) : null,
        }));

        // Aggregate breakdowns
        function buildAgg(rows, keyFn) {
            const map = {};
            for (const t of rows) {
                const k = keyFn(t) || 'Unknown';
                if (!map[k]) map[k] = { total: 0, wins: 0, pnls: [], returns: [] };
                map[k].total++;
                if (t.pnl > 0) map[k].wins++;
                map[k].pnls.push(t.pnl || 0);
                map[k].returns.push(t.pnlPct || 0);
            }
            return Object.entries(map).map(([bucket, d]) => ({
                bucket,
                total:     d.total,
                wins:      d.wins,
                winRate:   parseFloat(((d.wins / d.total) * 100).toFixed(1)),
                avgReturn: parseFloat((d.returns.reduce((s, v) => s + v, 0) / d.total).toFixed(2)),
                totalPnl:  parseFloat(d.pnls.reduce((s, v) => s + v, 0).toFixed(2)),
            })).sort((a, b) => b.totalPnl - a.totalPnl);
        }

        // Sector filter options for the UI
        const sectors  = [...new Set(trades.map(t => t.sector).filter(Boolean))].sort();
        const regimes  = [...new Set(trades.map(t => t.regime).filter(Boolean))].sort();
        const exitTypes = [...new Set(trades.map(t => t.exitType).filter(Boolean))].sort();

        res.json({
            days,
            totalTrades: trades.length,
            trades,
            filters: { sectors, regimes, exitTypes },
            byExit:   buildAgg(trades, t => t.exitType),
            bySector: buildAgg(trades, t => t.sector),
            byRegime: buildAgg(trades, t => t.regime),
            byHold:   buildAgg(trades, t => {
                const h = t.holdHours;
                if (h == null) return 'Unknown';
                if (h <= 24)  return '0-24h';
                if (h <= 48)  return '25-48h';
                if (h <= 72)  return '49-72h';
                if (h <= 96)  return '73-96h';
                if (h <= 120) return '97-120h';
                return '120h+';
            }),
        });
    } catch (err) {
        logger.error('Trade log endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/performance/plain-summary
 * Body: { days: 30|90|180|365 }
 *
 * Collects all trading stats for the period, then asks Claude to write
 * a plain-English summary a non-trader can fully understand.
 * Uses the same Anthropic SDK already wired up for ORACLE/assistant.
 */
router.post('/plain-summary', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const Anthropic = require('@anthropic-ai/sdk');
        const userId = req.userId;
        const days   = Math.max(7, Math.min(parseInt(req.body?.days) || 90, 365));

        // ── 1. Gather all stats from the trades table ──────────────────────
        const statsRes = await query(`
            WITH sells AS (
                SELECT
                    s.symbol,
                    s.pnl,
                    s.pnl_percent,
                    s.hold_hours,
                    s.trade_date                                      AS closed_at,
                    COALESCE(s.ai_score,     b.ai_score)             AS ai_score,
                    COALESCE(s.sector,       b.sector)               AS sector,
                    COALESCE(s.entry_regime, b.entry_regime)         AS regime,
                    s.notes,
                    s.executed_by
                FROM trades s
                LEFT JOIN LATERAL (
                    SELECT ai_score, sector, entry_regime
                    FROM   trades
                    WHERE  user_id = s.user_id AND symbol = s.symbol AND action = 'BUY'
                      AND  trade_date <= s.trade_date
                    ORDER BY trade_date DESC LIMIT 1
                ) b ON true
                WHERE s.user_id = $1
                  AND s.action  = 'SELL'
                  AND s.pnl     IS NOT NULL
                  AND s.trade_date >= NOW() - ($2 * INTERVAL '1 day')
            )
            SELECT
                COUNT(*)                                                          AS total_trades,
                COUNT(*) FILTER (WHERE pnl > 0)                                  AS winners,
                COUNT(*) FILTER (WHERE pnl < 0)                                  AS losers,
                ROUND(COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*),0) * 100, 1) AS win_rate,
                ROUND(SUM(pnl)::numeric, 2)                                      AS net_pnl,
                ROUND(AVG(pnl)::numeric, 2)                                      AS avg_pnl,
                ROUND(AVG(pnl_percent)::numeric, 2)                              AS avg_return_pct,
                -- Winner/loser averages separately (keeps Haiku from confusing overall avg with per-direction avg)
                ROUND((AVG(pnl)         FILTER (WHERE pnl > 0))::numeric, 2)    AS avg_win_usd,
                ROUND((AVG(pnl_percent) FILTER (WHERE pnl > 0))::numeric, 2)    AS avg_win_pct,
                ROUND(ABS((AVG(pnl)         FILTER (WHERE pnl < 0))::numeric), 2) AS avg_loss_usd,
                ROUND(ABS((AVG(pnl_percent) FILTER (WHERE pnl < 0))::numeric), 2) AS avg_loss_pct,
                ROUND(MAX(pnl)::numeric, 2)                                      AS best_trade_pnl,
                ROUND(MIN(pnl)::numeric, 2)                                      AS worst_trade_pnl,
                (SELECT symbol FROM sells ORDER BY pnl DESC  LIMIT 1)           AS best_symbol,
                (SELECT symbol FROM sells ORDER BY pnl ASC   LIMIT 1)           AS worst_symbol,
                ROUND(AVG(hold_hours)::numeric, 1)                               AS avg_hold_hours,
                -- Best and worst sector
                (SELECT sector FROM sells WHERE sector IS NOT NULL
                 GROUP BY sector ORDER BY SUM(pnl) DESC  LIMIT 1)               AS best_sector,
                (SELECT sector FROM sells WHERE sector IS NOT NULL
                 GROUP BY sector ORDER BY SUM(pnl) ASC   LIMIT 1)               AS worst_sector,
                -- Most common exit
                (SELECT CASE
                    WHEN notes ILIKE '%trailing%' THEN 'trailing stop'
                    WHEN notes ILIKE '%partial%'  THEN 'partial profit'
                    WHEN notes ILIKE '%stop%'     THEN 'stop loss'
                    WHEN notes ILIKE '%target%'   THEN 'profit target'
                    ELSE 'bot decision'
                 END
                 FROM sells
                 GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1)                     AS most_common_exit,
                -- Market regime during trades
                (SELECT regime FROM sells WHERE regime IS NOT NULL
                 GROUP BY regime ORDER BY COUNT(*) DESC LIMIT 1)                AS dominant_regime,
                -- Score stats
                ROUND(AVG(ai_score)::numeric, 1)                                AS avg_ai_score,
                ROUND(MIN(ai_score)::numeric, 0)                                AS min_ai_score,
                ROUND(MAX(ai_score)::numeric, 0)                                AS max_ai_score,
                -- Gross wins / losses for profit factor
                ROUND(SUM(pnl) FILTER (WHERE pnl > 0)::numeric, 2)             AS gross_wins,
                ROUND(ABS(SUM(pnl) FILTER (WHERE pnl < 0))::numeric, 2)        AS gross_losses
            FROM sells
        `, [userId, days]);

        const s = statsRes.rows[0];
        const total = parseInt(s.total_trades || 0);

        // ── 1b. Skipped-opportunity stats for the SAME period — this is the piece a
        // plain-English summary was previously blind to. A stretch of zero/few trades
        // used to read as "nothing happened"; it's usually "the bot correctly sat out,
        // and here's the evidence" (see the Skipped Opportunities analytics tab).
        const skippedRes = await query(`
            SELECT
                COUNT(DISTINCT scan_date) FILTER (WHERE was_traded = false)                    AS blocked_days,
                COUNT(*) FILTER (WHERE was_traded = false AND ai_score >= 85)                   AS candidates_85,
                ROUND(AVG(return_5d_pct) FILTER (WHERE was_traded = false AND ai_score >= 85)::numeric, 2) AS avg_return_5d_85,
                ROUND(
                    (COUNT(*) FILTER (WHERE was_traded = false AND ai_score >= 85 AND return_5d_pct > 0))::numeric /
                    NULLIF(COUNT(*) FILTER (WHERE was_traded = false AND ai_score >= 85 AND return_5d_pct IS NOT NULL), 0) * 100, 1
                ) AS win_rate_5d_85,
                MODE() WITHIN GROUP (ORDER BY regime) FILTER (WHERE was_traded = false)         AS dominant_blocked_regime
            FROM market_review_snapshots
            WHERE scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
        `, [days]);
        const sk = skippedRes.rows[0];
        const skippedBlob = {
            blockedDays:         parseInt(sk.blocked_days || 0),
            candidates85:        parseInt(sk.candidates_85 || 0),
            avgReturn5d85:       sk.avg_return_5d_85 != null ? parseFloat(sk.avg_return_5d_85) : null,
            winRate5d85:         sk.win_rate_5d_85 != null ? parseFloat(sk.win_rate_5d_85) : null,
            dominantBlockedRegime: sk.dominant_blocked_regime || null,
        };

        if (total === 0) {
            if (skippedBlob.blockedDays > 0 && skippedBlob.candidates85 > 0) {
                const verdict = skippedBlob.avgReturn5d85 != null && skippedBlob.avgReturn5d85 < 0
                    ? 'the data suggests sitting out was the right call'
                    : 'worth double-checking whether the regime filter is too conservative';
                return res.json({
                    summary: `No trades were completed in the last ${days} days, but that wasn't inactivity — the bot sat out ` +
                        `${skippedBlob.blockedDays} day(s) of ${skippedBlob.dominantBlockedRegime ? `mostly ${skippedBlob.dominantBlockedRegime.replace(/_/g,' ')} conditions` : 'unfavorable conditions'}. ` +
                        `Looking at the ${skippedBlob.candidates85} high-scoring stocks (85+) it passed on, they averaged ` +
                        `${skippedBlob.avgReturn5d85 != null ? `${skippedBlob.avgReturn5d85 >= 0 ? '+' : ''}${skippedBlob.avgReturn5d85.toFixed(2)}%` : 'an unclear return'} ` +
                        `over the next 5 trading days${skippedBlob.winRate5d85 != null ? ` with only a ${skippedBlob.winRate5d85.toFixed(0)}% win rate` : ''} — ${verdict}. ` +
                        `See the Skipped Opportunities tab for the full breakdown.`,
                    stats: { totalTrades: 0, days, skipped: skippedBlob }
                });
            }
            return res.json({
                summary: `No closed trades found in the last ${days} days. The bot may still be building positions, or no trades were completed in this period. Check the AI Bot page to see if the bot is active and scanning for opportunities.`,
                stats: { totalTrades: 0, days }
            });
        }

        const profitFactor = s.gross_losses > 0
            ? (parseFloat(s.gross_wins || 0) / parseFloat(s.gross_losses)).toFixed(2)
            : s.gross_wins > 0 ? '∞' : '0';

        // ── 2. Build the data blob for Claude ─────────────────────────────
        const winners    = parseInt(s.winners || 0);
        const losers     = parseInt(s.losers  || 0);
        const grossWins  = parseFloat(s.gross_wins  || 0);
        const grossLoss  = parseFloat(s.gross_losses || 0);
        const avgWinUsd  = parseFloat(s.avg_win_usd  || 0);
        const avgLossUsd = parseFloat(s.avg_loss_usd || 0);
        const winLossRatio = avgLossUsd > 0 ? (avgWinUsd / avgLossUsd).toFixed(2) : null;

        const statsBlob = {
            period:           `last ${days} days`,
            totalTrades:      total,
            winners,
            losers,
            winRatePct:       parseFloat(s.win_rate || 0),
            netPnlUsd:        parseFloat(s.net_pnl || 0),
            avgNetPnlPerTrade: parseFloat(s.avg_pnl || 0),  // renamed to make clear it's OVERALL avg
            avgReturnPct:     parseFloat(s.avg_return_pct || 0),
            // Per-direction averages — DO NOT confuse with avgNetPnlPerTrade
            avgWinUsd,
            avgWinPct:        parseFloat(s.avg_win_pct  || 0),
            avgLossUsd,
            avgLossPct:       parseFloat(s.avg_loss_pct || 0),
            winLossRatio,     // avgWin ÷ avgLoss (>1.5 = good edge)
            grossWins,
            grossLosses:      grossLoss,
            bestTradePnl:     parseFloat(s.best_trade_pnl || 0),
            worstTradePnl:    parseFloat(s.worst_trade_pnl || 0),
            bestSymbol:       s.best_symbol,
            worstSymbol:      s.worst_symbol,
            avgHoldHours:     parseFloat(s.avg_hold_hours || 0),
            bestSector:       s.best_sector,
            worstSector:      s.worst_sector,
            mostCommonExit:   s.most_common_exit,
            dominantRegime:   s.dominant_regime,
            avgAiScore:       parseFloat(s.avg_ai_score || 0),
            profitFactor,
            skippedOpportunities: skippedBlob.blockedDays > 0 ? skippedBlob : null,
        };

        // ── 3. Ask Claude for the plain-English summary ────────────────────
        const apiKey = process.env.ANTHROPIC_API_KEY;
        if (!apiKey) {
            // Fallback: build a template summary without Claude
            const direction = statsBlob.netPnlUsd >= 0 ? 'made money' : 'lost money';
            const summary = [
                `Over the ${statsBlob.period}, the bot completed ${statsBlob.totalTrades} trades — ` +
                `${statsBlob.winners} winners and ${statsBlob.losers} losers (${statsBlob.winRatePct}% win rate).`,
                `Overall the account ${direction}: net profit/loss was $${Math.abs(statsBlob.netPnlUsd).toFixed(2)} ` +
                `(${statsBlob.avgReturnPct >= 0 ? '+' : ''}${statsBlob.avgReturnPct.toFixed(2)}% average per trade).`,
                statsBlob.bestSymbol ? `Best trade: ${statsBlob.bestSymbol} (+$${statsBlob.bestTradePnl.toFixed(2)}). ` +
                `Worst trade: ${statsBlob.worstSymbol} ($${statsBlob.worstTradePnl.toFixed(2)}).` : '',
                statsBlob.avgHoldHours > 0
                    ? `Stocks were held for ${statsBlob.avgHoldHours.toFixed(0)} hours on average (about ${(statsBlob.avgHoldHours / 24).toFixed(1)} days).` : '',
                statsBlob.bestSector ? `Best performing sector: ${statsBlob.bestSector}. Worst: ${statsBlob.worstSector}.` : '',
                statsBlob.skippedOpportunities ? `Separately, the bot sat out ${statsBlob.skippedOpportunities.blockedDays} day(s) in this period ` +
                `(mostly ${statsBlob.skippedOpportunities.dominantBlockedRegime || 'unfavorable'} conditions) — the ${statsBlob.skippedOpportunities.candidates85} ` +
                `high-scoring stocks it passed on during those days averaged ${statsBlob.skippedOpportunities.avgReturn5d85 != null ? `${statsBlob.skippedOpportunities.avgReturn5d85 >= 0 ? '+' : ''}${statsBlob.skippedOpportunities.avgReturn5d85.toFixed(2)}%` : 'an unclear return'} over the next 5 days.` : '',
            ].filter(Boolean).join(' ');
            return res.json({ summary, stats: statsBlob });
        }

        const client = new Anthropic({ apiKey });
        const prompt = `You are a friendly assistant explaining a stock trading bot's performance to someone with zero trading knowledge. Use simple everyday language — no jargon.

Here are the trading results for the ${statsBlob.period}:
${JSON.stringify(statsBlob, null, 2)}

IMPORTANT number guide (read before writing):
- "netPnlUsd" = total money made or lost across ALL trades combined
- "avgNetPnlPerTrade" = net profit divided by total trades (overall average per trade — includes both wins and losses)
- "avgWinUsd" = average profit on the WINNING trades only
- "avgLossUsd" = average loss on the LOSING trades only (already positive, so treat as a cost)
- "winLossRatio" = avgWinUsd ÷ avgLossUsd — above 1.5 is strong, below 1.0 means losses outsize wins
- "profitFactor" = gross wins ÷ gross losses — above 1.5 = healthy edge
- "skippedOpportunities" (only present if the bot also sat out some days this period) = what happened
  to the high-scoring (85+) stocks the bot did NOT trade on its no-trade days. "avgReturn5d85" is their
  average return over the next 5 trading days had they been bought anyway — negative means sitting out
  was correct, positive means the regime filter may be too conservative. This is a SEPARATE, complementary
  fact from the executed-trade stats above — it did not happen to money already in the account.
Do NOT confuse "avgNetPnlPerTrade" with "avgWinUsd" or "avgLossUsd". They are different numbers.

Write a clear, friendly performance summary covering:
1. Overall result — did the account make or lose money, and by how much?
2. Win rate and what the average winning trade made vs what the average losing trade cost
3. Which stocks or sectors did well, which did poorly?
4. How long were stocks typically held?
5. How the bot decided to exit trades (stop loss, profit target, etc.)
6. If "skippedOpportunities" is present, one sentence on whether the no-trade days were correctly avoiding bad setups or possibly too cautious — grounded in the actual numbers, not a guess
7. One honest strength and one honest area to watch
8. A single plain sentence verdict at the end

Rules:
- Write in plain English a family member could understand
- Always name the specific dollar amounts for wins and losses with context ("each winning trade made about $X on average")
- Keep it under 280 words
- Use short paragraphs, not bullet points
- Do NOT start with "Overall" — vary the opening`;

        const message = await client.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 512,
            messages:   [{ role: 'user', content: prompt }]
        });

        const summary = message.content?.[0]?.text?.trim() || 'Summary unavailable.';
        res.json({ summary, stats: statsBlob });

    } catch (err) {
        logger.error('Plain summary endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/equity-curve?days=90
 * Returns daily cumulative P&L for charting the equity curve.
 * Each row = one day that had at least one closed trade.
 * Also returns max drawdown computed from running peak.
 */
router.get('/equity-curve', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const userId = req.userId;
        const days   = Math.max(7, Math.min(parseInt(req.query.days) || 90, 365));

        const result = await query(`
            WITH daily AS (
                SELECT
                    DATE(trade_date)                                    AS day,
                    SUM(pnl)                                            AS daily_pnl,
                    COUNT(*)                                            AS trades,
                    COUNT(*) FILTER (WHERE pnl > 0)                    AS wins,
                    COUNT(*) FILTER (WHERE pnl < 0)                    AS losses,
                    ROUND(MAX(pnl)::numeric, 2)                        AS best_trade,
                    ROUND(MIN(pnl)::numeric, 2)                        AS worst_trade,
                    STRING_AGG(DISTINCT symbol, ', ' ORDER BY symbol)  AS symbols
                FROM trades
                WHERE user_id  = $1
                  AND action   = 'SELL'
                  AND pnl      IS NOT NULL
                  AND trade_date >= NOW() - ($2 * INTERVAL '1 day')
                GROUP BY DATE(trade_date)
            ),
            running AS (
                -- Step 1: running cumulative P&L (single window function)
                SELECT
                    day, daily_pnl, trades, wins, losses,
                    best_trade, worst_trade, symbols,
                    SUM(daily_pnl) OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative_pnl
                FROM daily
            ),
            with_peak AS (
                -- Step 2: running peak of the cumulative P&L (second window function, not nested)
                SELECT
                    *,
                    MAX(cumulative_pnl) OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS peak_pnl
                FROM running
            )
            SELECT
                day,
                ROUND(daily_pnl::numeric, 2)     AS daily_pnl,
                trades, wins, losses,
                best_trade, worst_trade, symbols,
                ROUND(cumulative_pnl::numeric, 2) AS cumulative_pnl,
                ROUND(peak_pnl::numeric, 2)       AS peak_pnl,
                ROUND((cumulative_pnl - peak_pnl)::numeric, 2) AS drawdown
            FROM with_peak
            ORDER BY day ASC
        `, [userId, days]);

        const rows = result.rows;
        const maxDrawdown = rows.length > 0
            ? Math.min(...rows.map(r => parseFloat(r.drawdown || 0)))
            : 0;
        const finalPnl    = rows.length > 0 ? parseFloat(rows[rows.length - 1].cumulative_pnl || 0) : 0;
        const peakPnl     = rows.length > 0 ? Math.max(...rows.map(r => parseFloat(r.cumulative_pnl || 0))) : 0;
        const totalTrades = rows.reduce((s, r) => s + parseInt(r.trades || 0), 0);

        res.json({
            days,
            totalTrades,
            finalPnl,
            peakPnl: parseFloat(peakPnl.toFixed(2)),
            maxDrawdown: parseFloat(maxDrawdown.toFixed(2)),
            points: rows.map(r => ({
                date:          r.day,
                dailyPnl:      parseFloat(r.daily_pnl),
                cumulativePnl: parseFloat(r.cumulative_pnl),
                peakPnl:       parseFloat(r.peak_pnl),
                drawdown:      parseFloat(r.drawdown),
                trades:        parseInt(r.trades),
                wins:          parseInt(r.wins),
                losses:        parseInt(r.losses),
                bestTrade:     parseFloat(r.best_trade || 0),
                worstTrade:    parseFloat(r.worst_trade || 0),
                symbols:       r.symbols || '',
            })),
        });
    } catch (err) {
        logger.error('Equity curve endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/strategy-health?days=90
 * Returns the 9 key metrics from the ChatGPT monitoring table with current
 * values, targets, and pass/warn/fail status. All computed from the trades table.
 */
router.get('/strategy-health', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const userId = req.userId;
        const days   = Math.max(7, Math.min(parseInt(req.query.days) || 90, 365));

        const result = await query(`
            WITH sells AS (
                SELECT
                    s.pnl,
                    s.pnl_percent,
                    s.hold_hours,
                    s.slippage_pct,
                    s.trade_date,
                    s.notes
                FROM trades s
                WHERE s.user_id  = $1
                  AND s.action   = 'SELL'
                  AND s.pnl      IS NOT NULL
                  AND s.trade_date >= NOW() - ($2 * INTERVAL '1 day')
            ),
            agg AS (
                SELECT
                    COUNT(*)                                                          AS total,
                    COUNT(*) FILTER (WHERE pnl > 0)                                  AS winners,
                    COUNT(*) FILTER (WHERE pnl < 0)                                  AS losers,
                    -- Profit Factor
                    ROUND(
                        NULLIF(SUM(pnl) FILTER (WHERE pnl > 0), 0) /
                        NULLIF(ABS(SUM(pnl) FILTER (WHERE pnl < 0)), 0),
                    2)                                                                AS profit_factor,
                    -- Win Rate
                    ROUND(COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*),0) * 100, 1) AS win_rate,
                    -- Avg Winner % and Avg Loser % for ratio + expectancy
                    ROUND(AVG(pnl_percent) FILTER (WHERE pnl > 0)::numeric, 2)       AS avg_win_pct,
                    ROUND(ABS(AVG(pnl_percent) FILTER (WHERE pnl < 0))::numeric, 2)  AS avg_loss_pct,
                    -- Hold time (only rows where hold_hours is populated)
                    COUNT(*) FILTER (WHERE hold_hours IS NOT NULL)                    AS hold_count,
                    ROUND(AVG(hold_hours)::numeric, 1)                               AS avg_hold_hours,
                    ROUND(STDDEV(hold_hours)::numeric, 1)                            AS stddev_hold_hours,
                    -- Slippage (only rows where slippage_pct is populated)
                    COUNT(*) FILTER (WHERE slippage_pct IS NOT NULL)                 AS slippage_count,
                    ROUND(AVG(ABS(slippage_pct))::numeric, 4)                        AS avg_slippage,
                    ROUND(MAX(ABS(slippage_pct))::numeric, 4)                        AS max_slippage,
                    -- Stop repair proxy: sells by reconciler (Alpaca stop fired)
                    COUNT(*) FILTER (WHERE notes ILIKE '%stop%' OR notes ILIKE '%reconcil%') AS stop_exits,
                    -- Running drawdown: consecutive loss streaks (max losing run)
                    COUNT(*) FILTER (WHERE pnl < 0)                                  AS total_losers
                FROM sells
            )
            SELECT * FROM agg
        `, [userId, days]);

        const r = result.rows[0];
        const total      = parseInt(r.total || 0);
        const winners    = parseInt(r.winners || 0);
        const losers     = parseInt(r.losers  || 0);
        const winRate    = parseFloat(r.win_rate    || 0);
        const pf         = parseFloat(r.profit_factor || 0);
        const avgWinPct  = parseFloat(r.avg_win_pct  || 0);
        const avgLossPct = parseFloat(r.avg_loss_pct || 0); // already abs
        const winLossRatio = avgLossPct > 0 ? parseFloat((avgWinPct / avgLossPct).toFixed(2)) : null;
        const expectancy   = parseFloat(
            ((winRate / 100) * avgWinPct - (1 - winRate / 100) * avgLossPct).toFixed(2)
        );
        const holdCount     = parseInt(r.hold_count || 0);
        const avgHoldHours  = holdCount > 0 ? parseFloat(r.avg_hold_hours || 0) : null;
        const stddevHold    = holdCount > 0 ? parseFloat(r.stddev_hold_hours || 0) : null;
        const holdStability = (avgHoldHours != null && avgHoldHours > 0 && stddevHold != null)
            ? parseFloat((stddevHold / avgHoldHours).toFixed(2)) : null;

        const slippageCount = parseInt(r.slippage_count || 0);
        const avgSlippage   = slippageCount > 0 ? parseFloat(r.avg_slippage || 0) : null;
        const stopExits     = parseInt(r.stop_exits || 0);

        // Estimate stop repair events from trading logs (best-effort)
        let stopRepairCount = 0;
        try {
            const repairRes = await query(`
                SELECT COUNT(*) AS cnt
                FROM   trading_activity_log
                WHERE  user_id   = $1
                  AND  action    ILIKE '%stop repair%'
                  AND  timestamp >= NOW() - ($2 * INTERVAL '1 day')
            `, [userId, days]);
            stopRepairCount = parseInt(repairRes.rows[0]?.cnt || 0);
        } catch (_) { /* table may not exist in all envs */ }

        function status(val, greenTest, yellowTest) {
            if (val == null || total === 0) return 'na';
            if (greenTest(val)) return 'green';
            if (yellowTest(val)) return 'yellow';
            return 'red';
        }

        const metrics = [
            {
                key:      'profitFactor',
                label:    'Profit Factor',
                desc:     'Gross wins ÷ gross losses. Above 1.5 = good edge.',
                current:  pf || null,
                target:   '> 1.5',
                unit:     'x',
                status:   status(pf, v => v >= 1.5, v => v >= 1.2),
            },
            {
                key:      'winRate',
                label:    'Win Rate',
                desc:     'Percentage of trades that closed profitably.',
                current:  winRate || null,
                target:   '50–60%',
                unit:     '%',
                status:   status(winRate, v => v >= 50 && v <= 65, v => v >= 45),
            },
            {
                key:      'winLossRatio',
                label:    'Avg Winner / Avg Loser',
                desc:     'How much bigger wins are vs losses on average.',
                current:  winLossRatio,
                target:   '> 1.5×',
                unit:     'x',
                status:   status(winLossRatio, v => v >= 1.5, v => v >= 1.1),
            },
            {
                key:      'expectancy',
                label:    'Expectancy',
                desc:     'Average % return per trade taken (positive = edge exists).',
                current:  expectancy || null,
                target:   'Positive',
                unit:     '%',
                status:   status(expectancy, v => v > 0, v => v > -0.5),
            },
            {
                key:      'avgHoldHours',
                label:    'Avg Hold Time',
                desc:     'Average hours a position was open before closing.',
                current:  avgHoldHours,
                target:   'Stable (low variance)',
                unit:     'h',
                status:   holdCount === 0 || holdStability === null ? 'na'
                    : holdStability < 1.0 ? 'green'
                    : holdStability < 1.5 ? 'yellow' : 'red',
                note:     holdCount > 0 ? `${holdCount} of ${total} trades have hold time data` : 'hold_hours not yet populated',
            },
            {
                key:      'slippage',
                label:    'Slippage',
                desc:     'Difference between expected and actual fill price.',
                current:  avgSlippage,
                target:   '< 0.15%',
                unit:     '%',
                status:   slippageCount === 0 ? 'na' : status(avgSlippage, v => v < 0.15, v => v < 0.30),
                note:     slippageCount > 0 ? `${slippageCount} of ${total} trades have slippage data` : 'slippage_pct not yet populated',
            },
            {
                key:      'sampleSize',
                label:    'Sample Size',
                desc:     'Closed trades in period. Need 100+ for early confidence.',
                current:  total,
                target:   '≥ 100',
                unit:     'trades',
                status:   total >= 100 ? 'green' : total >= 50 ? 'yellow' : 'red',
            },
            {
                key:      'stopRepairEvents',
                label:    'Stop Repair Events',
                desc:     'Times the bot had to replace a missing stop. Should be rare.',
                current:  stopRepairCount,
                target:   'Rare (< 5)',
                unit:     '',
                status:   stopRepairCount === 0 ? 'green' : stopRepairCount < 5 ? 'yellow' : 'red',
            },
            {
                key:      'stopLossExits',
                label:    'Stop-Loss Exit Rate',
                desc:     'Percentage of trades that exited via a stop-loss.',
                current:  total > 0 ? parseFloat(((stopExits / total) * 100).toFixed(1)) : null,
                target:   '< 40%',
                unit:     '%',
                status:   status(
                    total > 0 ? (stopExits / total) * 100 : null,
                    v => v < 30, v => v < 45
                ),
            },
        ];

        const passing = metrics.filter(m => m.status === 'green').length;
        const warning = metrics.filter(m => m.status === 'yellow').length;
        const failing = metrics.filter(m => m.status === 'red').length;

        res.json({ days, total, metrics, summary: { passing, warning, failing, na: metrics.length - passing - warning - failing } });
    } catch (err) {
        logger.error('Strategy health endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/exit-breakdown?days=90
 * Categorizes closed trades by exit type and returns avg return + trade count per category.
 * Exit types are derived from the notes/reason text recorded at sell time.
 * Used by the Analytics page to show which exit mechanisms contribute most to P&L.
 */
router.get('/exit-breakdown', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const userId = req.userId;
        const days   = Math.max(7, Math.min(parseInt(req.query.days) || 90, 365));

        const result = await query(`
            SELECT
                CASE
                    WHEN notes ILIKE '%break-even%' OR notes ILIKE '%breakeven%'
                         THEN 'Break-even Stop'
                    WHEN notes ILIKE '%trailing stop%'
                         THEN 'Trailing Stop'
                    WHEN notes ILIKE '%stop-loss%' OR notes ILIKE '%stop loss%'
                         THEN 'Initial Stop'
                    WHEN notes ILIKE '%partial take-profit%' OR notes ILIKE '%partial profit%'
                         THEN 'Partial Profit'
                    WHEN notes ILIKE '%take-profit%' OR notes ILIKE '%take profit%'
                         THEN 'Full Profit Target'
                    WHEN notes ILIKE '%max-hold%' OR notes ILIKE '%max hold%'
                         THEN 'Max Hold (7d)'
                    WHEN notes ILIKE '%slow mover%'
                         THEN 'Slow Mover Exit'
                    WHEN notes ILIKE '%earnings%'
                         THEN 'Earnings Exit'
                    WHEN notes ILIKE '%swing%'
                         THEN 'Swing Exit'
                    ELSE 'Other'
                END                                                   AS exit_type,
                COUNT(*)                                              AS trades,
                COUNT(*) FILTER (WHERE pnl > 0)                      AS winners,
                ROUND((AVG(pnl_percent))::numeric, 2)                AS avg_return_pct,
                ROUND((AVG(pnl))::numeric, 2)                        AS avg_pnl_usd,
                ROUND((SUM(pnl))::numeric, 2)                        AS total_pnl_usd,
                ROUND(
                    (COUNT(*) FILTER (WHERE pnl > 0))::numeric /
                    NULLIF(COUNT(*), 0) * 100, 1
                )                                                     AS win_rate
            FROM trades
            WHERE user_id   = $1
              AND action     = 'SELL'
              AND pnl        IS NOT NULL
              AND trade_date >= NOW() - ($2 * INTERVAL '1 day')
            GROUP BY 1
            ORDER BY total_pnl_usd DESC
        `, [userId, days]);

        res.json({
            days,
            rows: result.rows.map(r => ({
                exitType:      r.exit_type,
                trades:        parseInt(r.trades),
                winners:       parseInt(r.winners),
                winRate:       parseFloat(r.win_rate || 0),
                avgReturnPct:  parseFloat(r.avg_return_pct || 0),
                avgPnlUsd:     parseFloat(r.avg_pnl_usd || 0),
                totalPnlUsd:   parseFloat(r.total_pnl_usd || 0),
            }))
        });
    } catch (err) {
        const logger = require('../utils/logger');
        logger.error('Exit breakdown endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/holdback-sim?days=90
 * For every trailing-stop and break-even exit, looks up what the stock did on
 * the next trading day (using daily_bars, which is already ingested nightly).
 * Answers: "Was our exit too early — would holding 24h longer have made more?"
 * Pure observation — no bot behavior changes.
 */
router.get('/holdback-sim', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const userId = req.userId;
        const days   = Math.max(7, Math.min(parseInt(req.query.days) || 90, 365));

        // Join each exit trade to the next available daily bar close after the exit date.
        // We consider only trailing stop and break-even exits — those are where holding
        // longer is meaningful. Initial stops exited because the trade was wrong; simulating
        // holding a loser longer is not useful.
        const result = await query(`
            WITH exits AS (
                SELECT
                    t.id,
                    t.symbol,
                    t.trade_date                            AS exit_date,
                    t.price                                 AS exit_price,
                    t.quantity,
                    t.pnl                                   AS actual_pnl,
                    t.pnl_percent                           AS actual_pnl_pct,
                    CASE
                        WHEN t.notes ILIKE '%break-even%' OR t.notes ILIKE '%breakeven%'
                             THEN 'Break-even Stop'
                        WHEN t.notes ILIKE '%trailing stop%'
                             THEN 'Trailing Stop'
                    END                                     AS exit_type
                FROM trades t
                WHERE t.user_id  = $1
                  AND t.action   = 'SELL'
                  AND t.pnl      IS NOT NULL
                  AND t.price    IS NOT NULL
                  AND t.quantity IS NOT NULL
                  AND t.trade_date >= NOW() - ($2 * INTERVAL '1 day')
                  AND (
                    t.notes ILIKE '%trailing stop%'
                    OR t.notes ILIKE '%break-even%'
                    OR t.notes ILIKE '%breakeven%'
                  )
            ),
            next_bar AS (
                SELECT DISTINCT ON (e.id)
                    e.id,
                    b.close AS next_day_close
                FROM exits e
                JOIN daily_bars b ON b.symbol = e.symbol
                    AND b.timestamp > e.exit_date
                ORDER BY e.id, b.timestamp ASC
            )
            SELECT
                e.exit_type,
                e.symbol,
                e.exit_date,
                ROUND(e.exit_price::numeric, 2)                                AS exit_price,
                ROUND(nb.next_day_close::numeric, 2)                           AS next_day_price,
                ROUND(e.actual_pnl::numeric, 2)                                AS actual_pnl,
                -- What we would have made if held one more day
                ROUND((nb.next_day_close - e.exit_price) * e.quantity::numeric, 2) AS holdback_delta,
                -- Positive = exit was too early (stock kept going up)
                -- Negative = exit was correct (stock dropped after we sold)
                ROUND(((nb.next_day_close - e.exit_price) / NULLIF(e.exit_price, 0) * 100)::numeric, 2) AS holdback_pct
            FROM exits e
            JOIN next_bar nb ON nb.id = e.id
            ORDER BY e.exit_date DESC
        `, [userId, days]);

        const rows = result.rows;

        // Aggregate: was exiting early net positive or negative?
        const trailingRows = rows.filter(r => r.exit_type === 'Trailing Stop');
        const breakevenRows = rows.filter(r => r.exit_type === 'Break-even Stop');

        const summarize = (rws) => {
            if (!rws.length) return null;
            const totalDelta  = rws.reduce((s, r) => s + parseFloat(r.holdback_delta || 0), 0);
            const tooEarly    = rws.filter(r => parseFloat(r.holdback_delta) > 0).length;
            const correct     = rws.filter(r => parseFloat(r.holdback_delta) <= 0).length;
            const avgPct      = rws.reduce((s, r) => s + parseFloat(r.holdback_pct || 0), 0) / rws.length;
            return {
                count: rws.length,
                tooEarly,
                correct,
                totalDelta: parseFloat(totalDelta.toFixed(2)),
                avgHoldbackPct: parseFloat(avgPct.toFixed(2)),
                verdict: totalDelta > 0 ? 'exits too early' : 'exits correctly'
            };
        };

        res.json({
            days,
            trailing:  summarize(trailingRows),
            breakeven: summarize(breakevenRows),
            trades: rows.map(r => ({
                exitType:      r.exit_type,
                symbol:        r.symbol,
                exitDate:      r.exit_date,
                exitPrice:     parseFloat(r.exit_price),
                nextDayPrice:  parseFloat(r.next_day_price),
                actualPnl:     parseFloat(r.actual_pnl),
                holdbackDelta: parseFloat(r.holdback_delta),  // >0 = left money on table, <0 = exit was right
                holdbackPct:   parseFloat(r.holdback_pct),
            }))
        });
    } catch (err) {
        const logger = require('../utils/logger');
        logger.error('Holdback sim endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/market-review?days=7
 * Compares AI score/recommendation against actual forward market returns for the FULL
 * scan universe (every ticker analyzed, not just what the bot traded). Not user-scoped —
 * market_review_snapshots is global scan data, same for every account.
 * Answers: "is the model's score correlated with real outcomes, and what did it pass on?"
 */
router.get('/market-review', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const days = Math.max(1, Math.min(parseInt(req.query.days) || 7, 90));

        const bucketRes = await query(`
            SELECT
                COALESCE(recommendation, 'UNSCORED')                                        AS recommendation,
                COUNT(*)                                                                     AS count,
                COUNT(*) FILTER (WHERE return_1d_pct IS NOT NULL)                            AS count_1d,
                ROUND(AVG(return_1d_pct)::numeric, 2)                                        AS avg_return_1d,
                ROUND(AVG(return_3d_pct)::numeric, 2)                                        AS avg_return_3d,
                ROUND(AVG(return_5d_pct)::numeric, 2)                                        AS avg_return_5d,
                ROUND(
                    (COUNT(*) FILTER (WHERE return_1d_pct > 0))::numeric /
                    NULLIF(COUNT(*) FILTER (WHERE return_1d_pct IS NOT NULL), 0) * 100, 1
                )                                                                            AS win_rate_1d
            FROM market_review_snapshots
            WHERE scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
            GROUP BY recommendation
            ORDER BY CASE recommendation
                WHEN 'STRONG BUY'  THEN 1 WHEN 'BUY' THEN 2 WHEN 'HOLD' THEN 3
                WHEN 'SELL'        THEN 4 WHEN 'STRONG SELL' THEN 5 ELSE 6 END
        `, [days]);

        // Highest-return tickers the bot did NOT trade — what did the score miss?
        const missedRes = await query(`
            SELECT scan_date, symbol, ai_score, recommendation, sector, setup_family, regime, blocked_reason,
                   price_at_scan, return_1d_pct, return_3d_pct, return_5d_pct
            FROM market_review_snapshots
            WHERE scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
              AND was_traded = false
              AND COALESCE(return_5d_pct, return_3d_pct, return_1d_pct) IS NOT NULL
            ORDER BY COALESCE(return_5d_pct, return_3d_pct, return_1d_pct) DESC
            LIMIT 20
        `, [days]);

        // Traded tickers that lost the most — what did the score get wrong?
        const worstTradedRes = await query(`
            SELECT scan_date, symbol, ai_score, recommendation, sector, setup_family, regime, blocked_reason,
                   price_at_scan, return_1d_pct, return_3d_pct, return_5d_pct
            FROM market_review_snapshots
            WHERE scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
              AND was_traded = true
              AND return_1d_pct IS NOT NULL
            ORDER BY return_1d_pct ASC
            LIMIT 20
        `, [days]);

        // Which market regime actually produced the best forward returns across the whole
        // scanned universe? One regime label applies to all tickers captured that day.
        const regimeRes = await query(`
            SELECT
                COALESCE(regime, 'UNKNOWN')                                                  AS regime,
                COUNT(DISTINCT scan_date)                                                     AS days,
                COUNT(*)                                                                      AS count,
                ROUND(AVG(return_1d_pct)::numeric, 2)                                         AS avg_return_1d,
                ROUND(AVG(return_5d_pct)::numeric, 2)                                         AS avg_return_5d,
                ROUND(
                    (COUNT(*) FILTER (WHERE return_1d_pct > 0))::numeric /
                    NULLIF(COUNT(*) FILTER (WHERE return_1d_pct IS NOT NULL), 0) * 100, 1
                )                                                                             AS win_rate_1d
            FROM market_review_snapshots
            WHERE scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
            GROUP BY regime
            ORDER BY avg_return_1d DESC NULLS LAST
        `, [days]);

        // Full raw list for this period — lets the UI answer "did we even look at ticker X"
        // regardless of whether it ended up in the missed/worst-traded highlight lists.
        const allRes = await query(`
            SELECT scan_date, symbol, ai_score, recommendation, sector, setup_family, regime, blocked_reason,
                   price_at_scan, return_1d_pct, return_3d_pct, return_5d_pct, was_traded
            FROM market_review_snapshots
            WHERE scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
            ORDER BY scan_date DESC, ai_score DESC NULLS LAST
            LIMIT 2000
        `, [days]);

        const mapRow = (r) => ({
            scanDate:       r.scan_date,
            symbol:         r.symbol,
            aiScore:        r.ai_score != null ? parseFloat(r.ai_score) : null,
            recommendation: r.recommendation,
            sector:         r.sector,
            setupFamily:    r.setup_family,
            regime:         r.regime || null,
            blockedReason:  r.blocked_reason || null,
            priceAtScan:    r.price_at_scan != null ? parseFloat(r.price_at_scan) : null,
            return1d:       r.return_1d_pct != null ? parseFloat(r.return_1d_pct) : null,
            return3d:       r.return_3d_pct != null ? parseFloat(r.return_3d_pct) : null,
            return5d:       r.return_5d_pct != null ? parseFloat(r.return_5d_pct) : null,
        });

        res.json({
            days,
            bucketSummary: bucketRes.rows.map(r => ({
                recommendation: r.recommendation,
                count:          parseInt(r.count),
                count1d:        parseInt(r.count_1d),
                avgReturn1d:    r.avg_return_1d != null ? parseFloat(r.avg_return_1d) : null,
                avgReturn3d:    r.avg_return_3d != null ? parseFloat(r.avg_return_3d) : null,
                avgReturn5d:    r.avg_return_5d != null ? parseFloat(r.avg_return_5d) : null,
                winRate1d:      r.win_rate_1d != null ? parseFloat(r.win_rate_1d) : null,
            })),
            missedOpportunities: missedRes.rows.map(mapRow),
            worstTraded:         worstTradedRes.rows.map(mapRow),
            allRows:             allRes.rows.map(r => ({ ...mapRow(r), wasTraded: r.was_traded })),
            regimeSummary: regimeRes.rows.map(r => ({
                regime:      r.regime,
                days:        parseInt(r.days),
                count:       parseInt(r.count),
                avgReturn1d: r.avg_return_1d != null ? parseFloat(r.avg_return_1d) : null,
                avgReturn5d: r.avg_return_5d != null ? parseFloat(r.avg_return_5d) : null,
                winRate1d:   r.win_rate_1d != null ? parseFloat(r.win_rate_1d) : null,
            })),
        });
    } catch (err) {
        const logger = require('../utils/logger');
        logger.error('Market review endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/performance/skipped-opportunities?days=30
 * "Did sitting out actually cost us money?" — buckets every scanned-but-not-traded
 * candidate by AI score threshold (85+/90+/95+) and reports real forward returns
 * (1d/3d/5d, already precomputed in market_review_snapshots), plus a daily
 * candidate-count breakdown and the highest-scoring/best-performing names actually
 * missed. Answers whether CHOPPY (or any other reason for sitting out) is correctly
 * avoiding bad setups or leaving profit on the table — with evidence, not a guess
 * (2026-07-16, following a ChatGPT review recommending exactly this analysis).
 */
router.get('/skipped-opportunities', protect, async (req, res) => {
    try {
        const { query } = require('../config/database');
        const days = Math.max(1, Math.min(parseInt(req.query.days) || 30, 180));
        const THRESHOLDS = [85, 90, 95];

        // Median/stddev/payoff stats per threshold — win rate alone hides whether the losers
        // are small nicks or big drawdowns, and a mean can be skewed by one outlier name.
        const byThresholdRes = await query(`
            SELECT
                t.threshold,
                COUNT(*) FILTER (WHERE m.ai_score >= t.threshold)                              AS candidate_count,
                COUNT(*) FILTER (WHERE m.ai_score >= t.threshold AND m.return_1d_pct IS NOT NULL) AS sample_1d,
                COUNT(*) FILTER (WHERE m.ai_score >= t.threshold AND m.return_5d_pct IS NOT NULL) AS sample_5d,
                ROUND(AVG(m.return_1d_pct) FILTER (WHERE m.ai_score >= t.threshold)::numeric, 2) AS avg_return_1d,
                ROUND(AVG(m.return_3d_pct) FILTER (WHERE m.ai_score >= t.threshold)::numeric, 2) AS avg_return_3d,
                ROUND(AVG(m.return_5d_pct) FILTER (WHERE m.ai_score >= t.threshold)::numeric, 2) AS avg_return_5d,
                ROUND(
                    (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY m.return_5d_pct)
                     FILTER (WHERE m.ai_score >= t.threshold))::numeric, 2
                ) AS median_return_5d,
                ROUND((STDDEV_SAMP(m.return_5d_pct) FILTER (WHERE m.ai_score >= t.threshold))::numeric, 2) AS stddev_return_5d,
                COUNT(*) FILTER (WHERE m.ai_score >= t.threshold AND m.return_5d_pct > 0) AS winners_5d,
                COUNT(*) FILTER (WHERE m.ai_score >= t.threshold AND m.return_5d_pct < 0) AS losers_5d,
                ROUND(AVG(m.return_5d_pct) FILTER (WHERE m.ai_score >= t.threshold AND m.return_5d_pct > 0)::numeric, 2) AS avg_winner_5d,
                ROUND(AVG(m.return_5d_pct) FILTER (WHERE m.ai_score >= t.threshold AND m.return_5d_pct < 0)::numeric, 2) AS avg_loser_5d,
                ROUND(
                    (SUM(m.return_5d_pct) FILTER (WHERE m.ai_score >= t.threshold AND m.return_5d_pct > 0))::numeric /
                    NULLIF(ABS(SUM(m.return_5d_pct) FILTER (WHERE m.ai_score >= t.threshold AND m.return_5d_pct < 0)), 0), 2
                ) AS profit_factor_5d,
                ROUND(
                    (COUNT(*) FILTER (WHERE m.ai_score >= t.threshold AND m.return_5d_pct > 0))::numeric /
                    NULLIF(COUNT(*) FILTER (WHERE m.ai_score >= t.threshold AND m.return_5d_pct IS NOT NULL), 0) * 100, 1
                ) AS win_rate_5d
            FROM unnest(ARRAY[${THRESHOLDS.join(',')}]) AS t(threshold)
            CROSS JOIN market_review_snapshots m
            WHERE m.was_traded = false
              AND m.scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
            GROUP BY t.threshold
            ORDER BY t.threshold
        `, [days]);

        // SPY's own forward return over the same scan dates — a "would we have beaten
        // the market anyway" benchmark, not just an absolute return in isolation.
        const spyBenchmarkRes = await query(`
            WITH blocked_dates AS (
                SELECT DISTINCT scan_date::date AS d
                FROM market_review_snapshots
                WHERE was_traded = false AND scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
            ),
            spy_fwd AS (
                SELECT bd.d,
                    (SELECT db.close FROM daily_bars db WHERE db.symbol = 'SPY' AND db.timestamp::date = bd.d ORDER BY db.timestamp DESC LIMIT 1) AS base_close,
                    (SELECT db.close FROM daily_bars db WHERE db.symbol = 'SPY' AND db.timestamp::date > bd.d ORDER BY db.timestamp ASC OFFSET 4 LIMIT 1) AS fwd_5d_close
                FROM blocked_dates bd
            )
            SELECT ROUND(AVG((fwd_5d_close - base_close) / NULLIF(base_close, 0) * 100)::numeric, 2) AS avg_spy_return_5d,
                   COUNT(*) FILTER (WHERE fwd_5d_close IS NOT NULL) AS sample_days
            FROM spy_fwd
        `, [days]);

        const dailyRes = await query(`
            SELECT scan_date, regime,
                COUNT(*) FILTER (WHERE ai_score >= 85) AS c85,
                COUNT(*) FILTER (WHERE ai_score >= 90) AS c90,
                COUNT(*) FILTER (WHERE ai_score >= 95) AS c95,
                ROUND(AVG(return_5d_pct) FILTER (WHERE ai_score >= 85)::numeric, 2) AS avg_return_5d_85
            FROM market_review_snapshots
            WHERE was_traded = false
              AND scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
            GROUP BY scan_date, regime
            ORDER BY scan_date DESC
        `, [days]);

        const topMissedRes = await query(`
            SELECT scan_date, symbol, ai_score, sector, regime, price_at_scan,
                   return_1d_pct, return_3d_pct, return_5d_pct
            FROM market_review_snapshots
            WHERE was_traded = false
              AND ai_score >= 85
              AND scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
              AND return_5d_pct IS NOT NULL
            ORDER BY return_5d_pct DESC
            LIMIT 20
        `, [days]);

        const regimeRes = await query(`
            SELECT COALESCE(regime, 'UNKNOWN') AS regime,
                COUNT(DISTINCT scan_date) AS blocked_days,
                COUNT(*) FILTER (WHERE ai_score >= 85) AS candidates_85,
                ROUND(AVG(return_5d_pct) FILTER (WHERE ai_score >= 85)::numeric, 2) AS avg_return_5d_85
            FROM market_review_snapshots
            WHERE was_traded = false
              AND scan_date >= CURRENT_DATE - ($1 * INTERVAL '1 day')
            GROUP BY regime
            ORDER BY blocked_days DESC
        `, [days]);

        res.json({
            days,
            byThreshold: byThresholdRes.rows.map(r => ({
                threshold:      parseInt(r.threshold),
                candidateCount: parseInt(r.candidate_count),
                sample1d:       parseInt(r.sample_1d),
                sample5d:       parseInt(r.sample_5d),
                avgReturn1d:    r.avg_return_1d != null ? parseFloat(r.avg_return_1d) : null,
                avgReturn3d:    r.avg_return_3d != null ? parseFloat(r.avg_return_3d) : null,
                avgReturn5d:    r.avg_return_5d != null ? parseFloat(r.avg_return_5d) : null,
                medianReturn5d: r.median_return_5d != null ? parseFloat(r.median_return_5d) : null,
                stddevReturn5d: r.stddev_return_5d != null ? parseFloat(r.stddev_return_5d) : null,
                winners5d:      parseInt(r.winners_5d || 0),
                losers5d:       parseInt(r.losers_5d || 0),
                avgWinner5d:    r.avg_winner_5d != null ? parseFloat(r.avg_winner_5d) : null,
                avgLoser5d:     r.avg_loser_5d != null ? parseFloat(r.avg_loser_5d) : null,
                profitFactor5d: r.profit_factor_5d != null ? parseFloat(r.profit_factor_5d) : null,
                winRate5d:      r.win_rate_5d != null ? parseFloat(r.win_rate_5d) : null,
            })),
            spyBenchmark: {
                avgReturn5d: spyBenchmarkRes.rows[0]?.avg_spy_return_5d != null ? parseFloat(spyBenchmarkRes.rows[0].avg_spy_return_5d) : null,
                sampleDays:  parseInt(spyBenchmarkRes.rows[0]?.sample_days || 0),
            },
            dailyBreakdown: dailyRes.rows.map(r => ({
                scanDate:      r.scan_date,
                regime:        r.regime,
                count85:       parseInt(r.c85),
                count90:       parseInt(r.c90),
                count95:       parseInt(r.c95),
                avgReturn5d85: r.avg_return_5d_85 != null ? parseFloat(r.avg_return_5d_85) : null,
            })),
            topMissed: topMissedRes.rows.map(r => ({
                scanDate:     r.scan_date,
                symbol:       r.symbol,
                aiScore:      parseFloat(r.ai_score),
                sector:       r.sector,
                regime:       r.regime,
                priceAtScan:  r.price_at_scan != null ? parseFloat(r.price_at_scan) : null,
                return1d:     r.return_1d_pct != null ? parseFloat(r.return_1d_pct) : null,
                return3d:     r.return_3d_pct != null ? parseFloat(r.return_3d_pct) : null,
                return5d:     r.return_5d_pct != null ? parseFloat(r.return_5d_pct) : null,
            })),
            byRegime: regimeRes.rows.map(r => ({
                regime:        r.regime,
                blockedDays:   parseInt(r.blocked_days),
                candidates85:  parseInt(r.candidates_85),
                avgReturn5d85: r.avg_return_5d_85 != null ? parseFloat(r.avg_return_5d_85) : null,
            })),
        });
    } catch (err) {
        const logger = require('../utils/logger');
        logger.error('Skipped opportunities endpoint error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
