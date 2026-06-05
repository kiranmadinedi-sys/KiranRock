/**
 * Daily Signals Routes
 *
 * GET /api/daily-signals          — current day's STRONG BUY + BUY tickers
 * GET /api/daily-signals?date=YYYY-MM-DD — specific date
 * GET /api/daily-signals/dates    — list of dates with scan data (last 30 days)
 */

const express = require('express');
const router  = express.Router();
const { query } = require('../config/database');
const { protect } = require('../middleware/authMiddleware');

/** Most recent scan date with passed records, within 4 days. */
const LATEST_PASSED_DATE = `(
    SELECT MAX(analysis_date)
    FROM   daily_universe_analysis
    WHERE  analysis_date >= CURRENT_DATE - INTERVAL '4 days'
      AND  analysis_date <= CURRENT_DATE
      AND  passed_prescreen = true
)`;

router.get('/', protect, async (req, res) => {
    try {
        const requestedDate = req.query.date || null;
        const dateExpr = requestedDate ? `$1::date` : LATEST_PASSED_DATE;
        const params   = requestedDate ? [requestedDate] : [];

        const [tickersRes, summaryRes, regimeRes] = await Promise.all([
            // All scored tickers for the date, ordered by score desc
            query(
                `SELECT
                    symbol,
                    ai_score      AS "aiScore",
                    recommendation,
                    sector,
                    setup_family  AS "setupFamily",
                    market_cap    AS "marketCap",
                    passed_prescreen AS "passedPrescreen",
                    analysis_date AS "scanDate"
                 FROM daily_universe_analysis
                 WHERE analysis_date = ${dateExpr}
                   AND recommendation IN ('STRONG BUY', 'BUY')
                 ORDER BY ai_score DESC`,
                params
            ),
            // Summary counts
            query(
                `SELECT
                    analysis_date                                          AS "scanDate",
                    COUNT(*)                                               AS total,
                    COUNT(*) FILTER (WHERE recommendation = 'STRONG BUY') AS "strongBuy",
                    COUNT(*) FILTER (WHERE recommendation = 'BUY')        AS "buy",
                    MAX(ai_score)                                          AS "topScore",
                    ROUND(AVG(ai_score)::numeric, 1)                      AS "avgScore"
                 FROM daily_universe_analysis
                 WHERE analysis_date = ${dateExpr}
                   AND recommendation IN ('STRONG BUY', 'BUY')
                 GROUP BY analysis_date`,
                params
            ),
            // Market regime (from DB or default)
            query(
                `SELECT regime FROM daily_universe_analysis
                 WHERE analysis_date = ${dateExpr} AND regime IS NOT NULL
                 LIMIT 1`,
                params
            ).catch(() => ({ rows: [] }))
        ]);

        const summary = summaryRes.rows[0] || { scanDate: null, total: 0, strongBuy: 0, buy: 0, topScore: null, avgScore: null };
        const regime  = regimeRes.rows[0]?.regime || null;

        res.json({
            scanDate:  summary.scanDate,
            regime,
            summary: {
                total:     parseInt(summary.total) || 0,
                strongBuy: parseInt(summary.strongBuy) || 0,
                buy:       parseInt(summary.buy) || 0,
                topScore:  parseFloat(summary.topScore) || null,
                avgScore:  parseFloat(summary.avgScore) || null
            },
            tickers: tickersRes.rows.map(r => ({
                symbol:       r.symbol,
                aiScore:      parseFloat(r.aiScore),
                recommendation: r.recommendation,
                sector:       r.sector || 'Unknown',
                setupFamily:  r.setupFamily || 'unknown',
                passedPrescreen: r.passedPrescreen,
                scanDate:     r.scanDate
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/dates', protect, async (req, res) => {
    try {
        const result = await query(
            `SELECT DISTINCT analysis_date AS date,
                    COUNT(*) FILTER (WHERE recommendation = 'STRONG BUY') AS "strongBuy",
                    COUNT(*) FILTER (WHERE recommendation = 'BUY')        AS "buy"
             FROM daily_universe_analysis
             WHERE analysis_date >= CURRENT_DATE - INTERVAL '30 days'
               AND recommendation IN ('STRONG BUY', 'BUY')
             GROUP BY analysis_date
             ORDER BY analysis_date DESC`
        );
        res.json(result.rows.map(r => ({
            date:      r.date,
            strongBuy: parseInt(r.strongBuy) || 0,
            buy:       parseInt(r.buy) || 0
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
