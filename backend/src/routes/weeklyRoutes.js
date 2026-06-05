const express = require('express');
const router = express.Router();
const { getWeeklyPredictions, analyzeStockForWeek } = require('../services/weeklyPredictionService');
const { TOTAL_COUNT } = require('../services/stockUniverse');
const { buildWeeklyPredictionsCsv } = require('../services/weeklyReportExportService');
const {
    getWeeklyPredictionSnapshotStatus
} = require('../services/weeklyPredictionSnapshotService');
const {
    REPORT_PREDICTION_CONFIG,
    buildPredictionRequestPlan,
    buildReportPredictionOptions
} = require('../sendWeeklyReportToTelegram');
const { protect } = require('../middleware/authMiddleware');
const { 
    saveWeeklyPredictions, 
    getPerformanceStats, 
    getRecentOutcomes,
    updateActualResults 
} = require('../services/weeklyPerformanceTracker');

function parseWeeklyPredictionOptions(query, defaults = {}) {
    const {
        limit = defaults.limit || 20,
        minScore = defaults.minScore || 60,
        sectors,
        marketCapMin,
        volatilityMax,
        universe = defaults.universe || 'TOP_200'
    } = query;

    return {
        limit: parseInt(limit, 10),
        minScore: parseInt(minScore, 10),
        sectors: sectors ? sectors.split(',') : null,
        marketCapMin: marketCapMin ? parseFloat(marketCapMin) : null,
        volatilityMax: volatilityMax ? parseFloat(volatilityMax) : null,
        universe: universe.toUpperCase()
    };
}

function getSnapshotStatusForUniverse(universe) {
    const options = buildReportPredictionOptions(universe);
    const cacheKey = require('../services/weeklyPredictionService').buildWeeklyPredictionCacheKey(options);
    return {
        universe: options.universe,
        ...getWeeklyPredictionSnapshotStatus(cacheKey, REPORT_PREDICTION_CONFIG.snapshotMaxAgeMs)
    };
}

/**
 * GET /api/weekly/predictions
 * Get top weekly stock predictions
 * Query params: 
 *   - limit: number of results (default: 20)
 *   - minScore: minimum score threshold (default: 60)
 *   - sectors: comma-separated sector names
 *   - marketCapMin: minimum market cap
 *   - volatilityMax: maximum volatility
 *   - universe: MEGA_CAP | TOP_200 | ALL (default: TOP_200)
 */
router.get('/predictions', protect, async (req, res) => {
    try {
        const options = parseWeeklyPredictionOptions(req.query, {
            limit: 20,
            minScore: 60,
            universe: 'TOP_200'
        });
        
        const predictions = await getWeeklyPredictions(options);
        
        // Save predictions for performance tracking
        if (predictions.topPicks && predictions.topPicks.length > 0) {
            saveWeeklyPredictions(predictions.topPicks).catch(err => 
                console.error('Error saving predictions:', err)
            );
        }
        
        // Get performance stats
        const performanceStats = await getPerformanceStats(4).catch(() => null);
        
        // Add performance data to response
        const response = {
            ...predictions,
            performance: performanceStats
        };
        
        res.json(response);
    } catch (error) {
        console.error('Error in weekly predictions route:', error);
        res.status(500).json({ error: 'Failed to generate weekly predictions' });
    }
});

/**
 * GET /api/weekly/ranked
 * Get the full ranked weekly list with ALL universe by default.
 */
router.get('/ranked', protect, async (req, res) => {
    try {
        const options = parseWeeklyPredictionOptions(req.query, {
            limit: TOTAL_COUNT,
            minScore: 0,
            universe: 'ALL'
        });

        const predictions = await getWeeklyPredictions(options);
        const performanceStats = await getPerformanceStats(4).catch(() => null);
        const ranked = predictions.allAnalyzed || predictions.topPicks || [];

        res.json({
            ranked,
            topPicks: predictions.topPicks || [],
            marketContext: predictions.marketContext || null,
            performance: performanceStats,
            analysisDate: predictions.analysisDate,
            totalAnalyzed: predictions.totalAnalyzed || ranked.length,
            universeSize: predictions.universeSize || ranked.length,
            universeType: predictions.universeType || options.universe,
            filters: predictions.filters || options,
            fromCache: Boolean(predictions.fromCache)
        });
    } catch (error) {
        console.error('Error in ranked weekly predictions route:', error);
        res.status(500).json({ error: 'Failed to generate ranked weekly predictions' });
    }
});

/**
 * GET /api/weekly/snapshot-status
 * Report snapshot freshness for the primary and fallback report universes.
 */
router.get('/snapshot-status', protect, async (req, res) => {
    try {
        const universes = buildPredictionRequestPlan();
        res.json({
            primaryUniverse: REPORT_PREDICTION_CONFIG.primaryUniverse,
            snapshotMaxAgeMs: REPORT_PREDICTION_CONFIG.snapshotMaxAgeMs,
            snapshots: universes.map(getSnapshotStatusForUniverse)
        });
    } catch (error) {
        console.error('Error getting weekly snapshot status:', error);
        res.status(500).json({ error: 'Failed to get weekly snapshot status' });
    }
});

/**
 * GET /api/weekly/export
 * Export the ranked weekly list as CSV. Defaults to ALL universe.
 */
router.get('/export', protect, async (req, res) => {
    try {
        const options = parseWeeklyPredictionOptions(req.query, {
            limit: TOTAL_COUNT,
            minScore: 0,
            universe: 'ALL'
        });

        const predictions = await getWeeklyPredictions(options);
        const ranked = predictions.allAnalyzed || predictions.topPicks || [];
        const csv = buildWeeklyPredictionsCsv(ranked);
        const stamp = new Date().toISOString().slice(0, 10);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="weekly-ranked-${options.universe.toLowerCase()}-${stamp}.csv"`);
        res.send(csv);
    } catch (error) {
        console.error('Error exporting weekly predictions:', error);
        res.status(500).json({ error: 'Failed to export weekly predictions' });
    }
});

/**
 * GET /api/weekly/analyze/:symbol
 * Analyze a specific stock for the week
 */
router.get('/analyze/:symbol', protect, async (req, res) => {
    try {
        const { symbol } = req.params;
        const analysis = await analyzeStockForWeek(symbol);
        
        if (!analysis) {
            return res.status(404).json({ error: 'Stock analysis not available' });
        }
        
        res.json(analysis);
    } catch (error) {
        console.error('Error in weekly analysis route:', error);
        res.status(500).json({ error: 'Failed to analyze stock' });
    }
});

/**
 * GET /api/weekly/performance
 * Get historical performance stats
 */
router.get('/performance', protect, async (req, res) => {
    try {
        const { weeks = 4 } = req.query;
        const stats = await getPerformanceStats(parseInt(weeks));
        
        if (!stats) {
            return res.status(404).json({ error: 'No performance data available' });
        }
        
        const recentOutcomes = await getRecentOutcomes(10);
        
        res.json({
            ...stats,
            recentOutcomes
        });
    } catch (error) {
        console.error('Error getting performance stats:', error);
        res.status(500).json({ error: 'Failed to get performance stats' });
    }
});

/**
 * POST /api/weekly/update-results
 * Manually trigger update of last week's results (admin only)
 */
router.post('/update-results', protect, async (req, res) => {
    try {
        await updateActualResults();
        res.json({ success: true, message: 'Results updated successfully' });
    } catch (error) {
        console.error('Error updating results:', error);
        res.status(500).json({ error: 'Failed to update results' });
    }
});

module.exports = router;
