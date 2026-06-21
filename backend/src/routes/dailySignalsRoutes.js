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
const globalSentimentService = require('../services/globalSentimentService');

/** Most recent scan date with passed records, within 4 days. */
const LATEST_PASSED_DATE = `(
    SELECT MAX(analysis_date)
    FROM   daily_universe_analysis
    WHERE  analysis_date >= CURRENT_DATE - INTERVAL '4 days'
      AND  analysis_date <= CURRENT_DATE
      AND  passed_prescreen = true
)`;

// In-memory cache — keyed by date string (or 'latest'). Avoids repeated DB+ATLAS round-trips.
// TTL: 5 min during market hours so live_score_cache overlays stay fresh; stale data is fine otherwise.
const _cache = new Map(); // key → { payload, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function _cacheGet(key) {
    const entry = _cache.get(key);
    if (!entry || Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
    return entry.payload;
}
function _cacheSet(key, payload) {
    _cache.set(key, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Wraps a promise with a hard timeout — ATLAS/Yahoo calls can hang on 429s.
function _withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);
}

router.get('/', protect, async (req, res) => {
    try {
        const requestedDate = req.query.date || null;
        const cacheKey = requestedDate || 'latest';

        const cached = _cacheGet(cacheKey);
        if (cached) return res.json(cached);

        const dateExpr = requestedDate ? `$1::date` : LATEST_PASSED_DATE;
        const params   = requestedDate ? [requestedDate] : [];

        const [tickersRes, summaryRes, regimeRes, metaRes, atlasSentiment] = await Promise.all([
            // All scored tickers — live_score_cache overlays intraday PANTHEON re-scores when
            // fresher than 10 minutes (written by the bot every 5-min cycle during market hours).
            query(
                `SELECT
                    d.symbol,
                    COALESCE(l.ai_score,        d.ai_score)      AS "aiScore",
                    COALESCE(l.recommendation,  d.recommendation) AS recommendation,
                    d.sector,
                    d.setup_family  AS "setupFamily",
                    d.market_cap    AS "marketCap",
                    d.passed_prescreen AS "passedPrescreen",
                    d.analysis_date AS "scanDate",
                    d.metadata->'scoringLog'       AS "scoringLog",
                    (d.metadata->>'entry')::numeric AS entry,
                    (d.metadata->>'stop')::numeric  AS stop,
                    (d.metadata->>'target')::numeric AS target,
                    (d.metadata->>'riskReward')     AS "riskReward",
                    d.metadata->>'oracleVerdict'    AS "oracleVerdict",
                    (d.metadata->>'smartMoneyScore')::numeric AS "smartMoneyScore",
                    l.live_scored_at AS "liveScoredAt"
                 FROM daily_universe_analysis d
                 LEFT JOIN live_score_cache l
                   ON l.symbol = d.symbol
                  AND l.scan_date = d.analysis_date
                  AND l.live_scored_at > NOW() - INTERVAL '10 minutes'
                 WHERE d.analysis_date = ${dateExpr}
                   AND COALESCE(l.recommendation, d.recommendation) IN ('STRONG BUY', 'BUY')
                 ORDER BY COALESCE(l.ai_score, d.ai_score) DESC`,
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
            ).catch(() => ({ rows: [] })),

            // Scan freshness + news-rescan alerts
            query(
                `SELECT
                    MAX(updated_at) AS generated_at,
                    jsonb_agg(
                        jsonb_build_object(
                            'symbol',       symbol,
                            'rescanAt',     metadata->>'rescanAt',
                            'rescanReason', metadata->>'rescanReason',
                            'prevRec',      metadata->>'prevRecommendation'
                        ) ORDER BY (metadata->>'rescanAt') DESC
                    ) FILTER (
                        WHERE metadata->>'rescanAt' IS NOT NULL
                          AND (metadata->>'rescanAt')::timestamptz >= NOW() - INTERVAL '4 hours'
                    ) AS rescan_alerts
                 FROM daily_universe_analysis
                 WHERE analysis_date = ${dateExpr}`,
                params
            ).catch(() => ({ rows: [] })),

            // Live global market sentiment (ATLAS) — hard 3s timeout so a Yahoo 429 never blocks the page
            _withTimeout(globalSentimentService.getGlobalSentiment().catch(() => null), 3000)
        ]);

        const summary      = summaryRes.rows[0] || { scanDate: null, total: 0, strongBuy: 0, buy: 0, topScore: null, avgScore: null };
        const regime       = regimeRes.rows[0]?.regime || null;
        const generatedAt  = metaRes.rows[0]?.generated_at || null;
        const rescanAlerts = metaRes.rows[0]?.rescan_alerts || [];

        const payload = {
            scanDate:     summary.scanDate,
            generatedAt,
            rescanAlerts,
            regime,
            globalMarket: atlasSentiment ? {
                label:       atlasSentiment.label,
                score:       atlasSentiment.globalScore,
                breakdown:   atlasSentiment.breakdown,
                rawData:     atlasSentiment.rawData,
            } : null,
            summary: {
                total:     parseInt(summary.total) || 0,
                strongBuy: parseInt(summary.strongBuy) || 0,
                buy:       parseInt(summary.buy) || 0,
                topScore:  parseFloat(summary.topScore) || null,
                avgScore:  parseFloat(summary.avgScore) || null
            },
            tickers: tickersRes.rows.map(r => ({
                symbol:          r.symbol,
                aiScore:         parseFloat(r.aiScore),
                recommendation:  r.recommendation,
                sector:          r.sector || 'Unknown',
                setupFamily:     r.setupFamily || 'unknown',
                passedPrescreen: r.passedPrescreen,
                scanDate:        r.scanDate,
                scoringLog:      r.scoringLog || [],
                entry:           r.entry != null ? parseFloat(r.entry) : null,
                stop:            r.stop  != null ? parseFloat(r.stop)  : null,
                target:          r.target != null ? parseFloat(r.target) : null,
                riskReward:      r.riskReward || null,
                oracleVerdict:   r.oracleVerdict || null,
                smartMoneyScore: r.smartMoneyScore != null ? parseFloat(r.smartMoneyScore) : null
            }))
        };

        // Only cache when scan data exists — don't cache "no data" responses
        if (payload.scanDate) _cacheSet(cacheKey, payload);
        res.json(payload);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Score bucket win-rate calibration — groups closed trades by ai_score bucket */
router.get('/calibration', protect, async (req, res) => {
    try {
        const result = await query(
            `SELECT
                CASE
                    WHEN ai_score >= 95 THEN '95-100'
                    WHEN ai_score >= 90 THEN '90-94'
                    WHEN ai_score >= 85 THEN '85-89'
                    WHEN ai_score >= 80 THEN '80-84'
                    ELSE '< 80'
                END AS bucket,
                COUNT(*)                                                AS total,
                COUNT(*) FILTER (WHERE pnl_percent > 0)                AS wins,
                ROUND(AVG(pnl_percent)::numeric, 2)                    AS "avgReturn",
                ROUND(SUM(pnl)::numeric, 2)                            AS "totalPnl"
             FROM trades
             WHERE ai_score IS NOT NULL AND pnl_percent IS NOT NULL
             GROUP BY bucket
             ORDER BY MIN(ai_score) DESC`
        );
        res.json(result.rows.map(r => ({
            bucket:    r.bucket,
            total:     parseInt(r.total) || 0,
            wins:      parseInt(r.wins) || 0,
            winRate:   r.total > 0 ? Math.round((r.wins / r.total) * 100) : 0,
            avgReturn: parseFloat(r.avgReturn) || 0,
            totalPnl:  parseFloat(r.totalPnl) || 0
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * Regime × score bucket performance matrix.
 * Shows profit factor, win rate, and avg return for every regime/bucket combination.
 * Needs 50+ trades to be statistically meaningful — run this after live validation period.
 */
router.get('/calibration/regime', protect, async (req, res) => {
    try {
        const result = await query(
            `SELECT
                COALESCE(notes::jsonb->>'regime', 'UNKNOWN') AS regime,
                CASE
                    WHEN ai_score >= 95 THEN '95-100'
                    WHEN ai_score >= 90 THEN '90-94'
                    WHEN ai_score >= 85 THEN '85-89'
                    WHEN ai_score >= 80 THEN '80-84'
                    ELSE '< 80'
                END AS bucket,
                COUNT(*)                                              AS total,
                COUNT(*) FILTER (WHERE pnl_percent > 0)              AS wins,
                ROUND(AVG(pnl_percent)::numeric, 2)                  AS "avgReturn",
                ROUND(SUM(pnl)::numeric,         2)                  AS "totalPnl",
                ROUND(
                    NULLIF(SUM(pnl) FILTER (WHERE pnl > 0), 0) /
                    NULLIF(ABS(SUM(pnl) FILTER (WHERE pnl < 0)), 0),
                    2
                )                                                     AS "profitFactor"
             FROM trades
             WHERE ai_score IS NOT NULL
               AND pnl_percent IS NOT NULL
               AND pnl IS NOT NULL
               AND action = 'SELL'
             GROUP BY regime, bucket
             ORDER BY regime, MIN(ai_score) DESC`
        );
        res.json(result.rows.map(r => ({
            regime:       r.regime,
            bucket:       r.bucket,
            total:        parseInt(r.total) || 0,
            wins:         parseInt(r.wins) || 0,
            winRate:      r.total > 0 ? Math.round((r.wins / r.total) * 100) : 0,
            avgReturn:    parseFloat(r.avgReturn) || 0,
            totalPnl:     parseFloat(r.totalPnl) || 0,
            profitFactor: r.profitFactor != null ? parseFloat(r.profitFactor) : null
        })));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/** Setup-family win-rate — groups closed trades by setup_family from scan data */
router.get('/setup-winrate', protect, async (req, res) => {
    try {
        const result = await query(
            `SELECT
                COALESCE(dua.setup_family, 'unknown') AS "setupFamily",
                COUNT(*)                                                AS total,
                COUNT(*) FILTER (WHERE t.pnl_percent > 0)             AS wins,
                ROUND(AVG(t.pnl_percent)::numeric, 2)                 AS "avgReturn",
                ROUND(SUM(t.pnl)::numeric, 2)                         AS "totalPnl"
             FROM trades t
             JOIN daily_universe_analysis dua
               ON t.symbol = dua.symbol
              AND dua.analysis_date = t.trade_date::date
             WHERE t.pnl_percent IS NOT NULL
               AND t.pnl IS NOT NULL
             GROUP BY dua.setup_family
             ORDER BY COUNT(*) DESC`
        );
        res.json(result.rows.map(r => ({
            setupFamily: r.setupFamily,
            total:       parseInt(r.total) || 0,
            wins:        parseInt(r.wins) || 0,
            winRate:     r.total > 0 ? Math.round((r.wins / r.total) * 100) : 0,
            avgReturn:   parseFloat(r.avgReturn) || 0,
            totalPnl:    parseFloat(r.totalPnl) || 0
        })));
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
