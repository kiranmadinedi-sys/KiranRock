const express = require('express');
const router = express.Router();
const { getWeeklyPredictions, analyzeStockForWeek } = require('../services/weeklyPredictionService');
const { protect } = require('../middleware/authMiddleware');

/**
 * GET /api/weekly/predictions
 * Get top weekly stock predictions
 * Query params: limit, minScore, sectors, marketCapMin, volatilityMax
 */
router.get('/predictions', protect, async (req, res) => {
    try {
        const {
            limit = 20,
            minScore = 60,
            sectors,
            marketCapMin,
            volatilityMax
        } = req.query;
        
        const options = {
            limit: parseInt(limit),
            minScore: parseInt(minScore),
            sectors: sectors ? sectors.split(',') : null,
            marketCapMin: marketCapMin ? parseFloat(marketCapMin) : null,
            volatilityMax: volatilityMax ? parseFloat(volatilityMax) : null
        };
        
        const predictions = await getWeeklyPredictions(options);
        res.json(predictions);
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

module.exports = router;
