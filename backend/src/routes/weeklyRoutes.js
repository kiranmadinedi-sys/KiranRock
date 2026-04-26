const express = require('express');
const router = express.Router();
const { getWeeklyPredictions, analyzeStockForWeek } = require('../services/weeklyPredictionService');
const { protect } = require('../middleware/authMiddleware');
const { 
    saveWeeklyPredictions, 
    getPerformanceStats, 
    getRecentOutcomes,
    updateActualResults 
} = require('../services/weeklyPerformanceTracker');

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
        const {
            limit = 20,
            minScore = 60,
            sectors,
            marketCapMin,
            volatilityMax,
            universe = 'TOP_200'  // NEW PARAMETER
        } = req.query;
        
        const options = {
            limit: parseInt(limit),
            minScore: parseInt(minScore),
            sectors: sectors ? sectors.split(',') : null,
            marketCapMin: marketCapMin ? parseFloat(marketCapMin) : null,
            volatilityMax: volatilityMax ? parseFloat(volatilityMax) : null,
            universe: universe.toUpperCase()  // Pass universe selection
        };
        
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
