const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { generatePersonalizedRecommendations } = require('../services/recommendationService');
const { getWeeklyPredictions } = require('../services/weeklyPredictionService');
const { query } = require('../config/database');
const { enrichWithMarketHours, getETContext } = require('../services/marketHoursEnrichmentService');

/**
 * Load predictions from the nightly PANTHEON scan (daily_universe_analysis).
 * Returns null if no recent scan data is available — caller falls back to live analysis.
 *
 * Maps DB rows → the same shape that analyzeStockForWeek() returns so the
 * recommendation service works without modification.
 */
async function loadPredictionsFromNightlyScan(limit = 500) {
    try {
        const LATEST_DATE = `(
            SELECT MAX(analysis_date)
            FROM   daily_universe_analysis
            WHERE  analysis_date >= CURRENT_DATE - INTERVAL '4 days'
              AND  analysis_date <= CURRENT_DATE
              AND  passed_prescreen = true
        )`;

        const res = await query(
            `SELECT
                d.symbol,
                COALESCE(l.ai_score,       d.ai_score)       AS ai_score,
                COALESCE(l.recommendation, d.recommendation)  AS recommendation,
                d.sector, d.setup_family, d.market_cap, d.metadata, d.analysis_date,
                l.live_scored_at
             FROM daily_universe_analysis d
             LEFT JOIN live_score_cache l
               ON l.symbol    = d.symbol
              AND l.scan_date  = d.analysis_date
              AND l.live_scored_at > NOW() - INTERVAL '10 minutes'
             WHERE d.analysis_date = ${LATEST_DATE}
               AND d.ai_score IS NOT NULL
             ORDER BY COALESCE(l.ai_score, d.ai_score) DESC
             LIMIT $1`,
            [limit]
        );

        if (!res.rows.length) return null;

        // ── Sector concentration tracker (penalise >2 picks from same sector) ──────
        const sectorCount = {};

        const mapped = res.rows.map(row => {
            const score   = parseFloat(row.ai_score) || 50;
            const meta    = row.metadata || {};
            const rec     = (row.recommendation || '').toUpperCase();
            const sector  = row.sector || meta.sector || 'Unknown';

            // Map PANTHEON recommendation → weekly prediction signal format
            const signal =
                rec === 'STRONG BUY'  ? 'Strong Buy'  :
                rec === 'BUY'         ? 'Buy'          :
                rec === 'SELL'        ? 'Sell'         :
                rec === 'STRONG SELL' ? 'Strong Sell'  : 'Hold';

            // ── CONFIDENCE (cap at 85% — no model is perfect) ─────────────────────
            // Formula: maps score 50→10%, 70→40%, 85→63%, 100→85%
            // Adds a small uncertainty floor so confidence never reaches 100%.
            const rawConf   = Math.round((score - 50) / 50 * 75 + 10);
            const confidence = Math.min(85, Math.max(10, rawConf));

            // ── RISK SCORE (15 minimum — zero risk is impossible in markets) ───────
            // Base: inverted score. Adjusted by volatility and sector risk premium.
            const stockVol   = parseFloat(meta.volatility || meta.atr || 0);
            const volPremium = stockVol > 3 ? 10 : stockVol > 2 ? 5 : 0; // high-vol stocks are riskier
            const SECTOR_RISK = { Technology: 5, 'Consumer Discretionary': 5, Healthcare: 0, Industrials: 0, 'Real Estate': 5, Financials: 0, 'Communication Services': 5 };
            const sectorPremium = SECTOR_RISK[sector] ?? 3;
            const baseRisk  = Math.round(100 - score);
            const riskScore = Math.min(85, Math.max(15, baseRisk + volPremium + sectorPremium));
            const riskLevel = riskScore < 30 ? 'Low' : riskScore < 55 ? 'Moderate' : 'High';

            // ── EXPECTED MOVE (stock-specific, not fixed 8%) ──────────────────────
            // Base move from setup family, scaled by each stock's actual volatility.
            // Benchmarks against a 2% reference vol so high-beta stocks get larger targets.
            const setupBase = {
                breakout_leader:      score >= 90 ? 8.0 : 5.5,
                quality_continuation: score >= 85 ? 6.0 : 4.0,
                oversold_reversal:    score >= 80 ? 5.0 : 3.0,
            };
            const baseMove    = setupBase[row.setup_family] ?? Math.max(2, (score - 60) / 5);
            const volScale    = stockVol > 0 ? Math.min(1.6, Math.max(0.6, stockVol / 2.0)) : 1.0;
            const scoreFactor = 0.7 + (score / 100) * 0.3; // score 70→0.91×, score 100→1.0×
            const expectedMove = Math.max(1.5, Math.round(baseMove * volScale * scoreFactor * 10) / 10);

            // ── RISK-ADJUSTED SCORE (rank by reward/risk, not raw score) ─────────
            // reward = expectedMove, risk proxy = riskScore/100.
            // Multiplied by confidence so low-confidence picks rank lower.
            const rewardRiskRatio   = expectedMove / Math.max(0.2, riskScore / 100 * 7);
            const riskAdjustedScore = Math.round(score * (confidence / 85) * Math.min(1.2, rewardRiskRatio / 5));

            // ── SECTOR CONCENTRATION PENALTY ─────────────────────────────────────
            sectorCount[sector] = (sectorCount[sector] || 0) + 1;
            const sectorPenalty  = Math.max(0, (sectorCount[sector] - 2) * 6); // -6 pts per stock beyond 2nd in sector
            const adjustedScore  = Math.round(riskAdjustedScore - sectorPenalty);

            const riskFactors = [];
            if (sectorCount[sector] > 2) riskFactors.push(`Sector concentration: ${sectorCount[sector]} ${sector} picks`);
            if (volPremium > 0)          riskFactors.push(`High volatility stock`);
            if (meta.earningsFlag)       riskFactors.push(`Earnings approaching`);

            const currentPrice = parseFloat(meta.price) || 0;

            return {
                symbol:        row.symbol,
                totalScore:    Math.round(score),
                adjustedScore,
                rewardRiskRatio: Math.round(rewardRiskRatio * 10) / 10,
                tier:          score >= 90 ? 'S' : score >= 80 ? 'A' : score >= 70 ? 'B' : 'C',
                sector,
                marketCap:     parseFloat(row.market_cap) || meta.marketCap || null,
                currentPrice:  currentPrice ? currentPrice.toFixed(2) : null,
                priceChange1w: null,
                scanDate:      row.analysis_date,
                liveScoredAt:  row.live_scored_at || null,
                _source:       'nightly_scan',

                componentScores: {
                    ai:          Math.round(score),
                    technical:   Math.round(meta.rsi ? Math.min(100, meta.rsi) : score * 0.9),
                    fundamental: 50,
                    momentum:    Math.round(meta.momentum ? Math.min(100, Math.max(0, (meta.momentum + 5) * 10)) : score * 0.85),
                    sentiment:   Math.round((meta.newsSentiment || 0) * 10 + 50),
                    volume:      Math.round(parseFloat(meta.volumeRatio || 1) * 50),
                    volatility:  Math.round(100 - riskScore),
                },

                prediction: {
                    signal,
                    expectedMove: expectedMove.toFixed(1),
                    confidence,
                    targetPrice: currentPrice ? (currentPrice * (1 + expectedMove / 100)).toFixed(2) : null,
                },

                riskAnalysis: {
                    riskScore,
                    riskLevel,
                    riskFactors,
                },

                rationale: [
                    `PANTHEON score: ${Math.round(score)} — ${row.recommendation}`,
                    `Risk-adjusted rank score: ${adjustedScore} | R/R: ${(Math.round(rewardRiskRatio * 10) / 10)}x`,
                    row.setup_family ? `Setup: ${row.setup_family.replace(/_/g, ' ')}` : null,
                    meta.scoringLog?.length ? meta.scoringLog.slice(0, 3).join('; ') : null,
                ].filter(Boolean).join('. '),

                upcomingEvents:  [],
                technicalSignals: [],
                analystRatings:  null,
            };
        });

        // Re-sort by risk-adjusted score (reward/risk × confidence) not raw AI score
        mapped.sort((a, b) => b.adjustedScore - a.adjustedScore);
        return mapped;
    } catch {
        return null;
    }
}

/**
 * @route GET /api/recommendations
 * @desc Get personalized stock recommendations for the authenticated user
 * @query {string} riskTolerance - conservative, moderate, or aggressive (default: moderate)
 * @query {number} maxRecommendations - Maximum recommendations to return (default: 10)
 * @query {string} universe - Stock universe: MEGA_CAP, TOP_200, or ALL (default: TOP_200)
 * @access Private (requires authentication)
 */
router.get('/', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            riskTolerance = 'moderate',
            maxRecommendations = 10,
            universe = 'TOP_200',
            forceLive = 'false'
        } = req.query;

        let predictions = null;
        let dataSource  = 'nightly_scan';

        // Primary: use pre-scored nightly PANTHEON data — instant, no API calls
        if (forceLive !== 'true') {
            predictions = await loadPredictionsFromNightlyScan(500);
        }

        // Fallback: live analysis (slow — hits Yahoo Finance for every stock)
        if (!predictions) {
            console.log(`[Recommendations] No nightly scan data — falling back to live analysis (universe: ${universe})`);
            dataSource = 'live_analysis';
            const weeklyData = await getWeeklyPredictions({
                limit: 500,
                universe: universe.toUpperCase()
            });
            predictions = weeklyData?.predictions || weeklyData?.topPicks || [];
        }

        if (!predictions || !predictions.length) {
            return res.status(200).json({
                recommendations: [],
                portfolioActions: [],
                message: 'No predictions available. Nightly scan may not have run yet today.',
                dataSource
            });
        }

        console.log(`[Recommendations] ${predictions.length} predictions from ${dataSource} for user ${userId}`);

        const recommendations = await generatePersonalizedRecommendations(
            userId,
            predictions,
            {
                maxRecommendations: parseInt(maxRecommendations),
                riskTolerance: riskTolerance.toLowerCase()
            }
        );

        // Enrich top recommendations with live prices + entry assessment during market hours
        const { isOpen } = getETContext();
        if (isOpen && recommendations.recommendations?.length) {
            await enrichWithMarketHours(recommendations.recommendations);
        }

        res.json({ ...recommendations, dataSource, marketHoursEnriched: isOpen });

    } catch (error) {
        console.error('[Recommendations] Error:', error);
        res.status(500).json({
            error: 'Failed to generate recommendations',
            details: error.message
        });
    }
});

/**
 * @route GET /api/recommendations/quick
 * @desc Get quick recommendations (top 5 stocks only)
 * @query {string} riskTolerance - conservative, moderate, or aggressive
 * @access Private
 */
router.get('/quick', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const { riskTolerance = 'moderate' } = req.query;

        // Try nightly scan first (top 50 by score), then live fallback
        let predictions = await loadPredictionsFromNightlyScan(50);
        if (!predictions) {
            const weeklyData = await getWeeklyPredictions({ limit: 50, universe: 'MEGA_CAP' });
            predictions = weeklyData?.predictions || weeklyData?.topPicks || [];
        }

        const recommendations = await generatePersonalizedRecommendations(
            userId,
            predictions,
            { maxRecommendations: 5, riskTolerance: riskTolerance.toLowerCase() }
        );

        const top5 = recommendations.recommendations.slice(0, 5);

        // Enrich with live data during market hours
        const { isOpen } = getETContext();
        if (isOpen && top5.length) {
            await enrichWithMarketHours(top5);
        }

        res.json({
            recommendations: top5,
            summary: recommendations.summary,
            riskProfile: recommendations.riskProfile,
            marketHoursEnriched: isOpen
        });

    } catch (error) {
        console.error('[Recommendations] Quick error:', error);
        res.status(500).json({ error: 'Failed to generate quick recommendations', details: error.message });
    }
});

/**
 * @route GET /api/recommendations/portfolio-actions
 * @desc Get only portfolio rebalancing actions (no new stocks)
 * @access Private
 */
router.get('/portfolio-actions', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const { universe = 'TOP_200' } = req.query;

        let predictions = await loadPredictionsFromNightlyScan(500);
        if (!predictions) {
            const weeklyData = await getWeeklyPredictions({ limit: 500, universe: universe.toUpperCase() });
            predictions = weeklyData?.predictions || weeklyData?.topPicks || [];
        }

        const recommendations = await generatePersonalizedRecommendations(
            userId,
            predictions,
            { maxRecommendations: 0 }  // portfolio actions only
        );

        res.json({
            portfolioActions: recommendations.portfolioActions,
            portfolioAnalysis: recommendations.portfolioAnalysis,
            summary: recommendations.summary
        });

    } catch (error) {
        console.error('[Recommendations] Portfolio actions error:', error);
        res.status(500).json({ error: 'Failed to generate portfolio actions', details: error.message });
    }
});

module.exports = router;
