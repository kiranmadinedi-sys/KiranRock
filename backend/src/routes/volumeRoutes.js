const express = require('express');
const router = express.Router();
const { analyzeVolume } = require('../services/volumeAnalysisService');
const { protect } = require('../middleware/authMiddleware');

/**
 * GET /api/volume/:symbol
 * Analyzes volume trends and price-volume relationships
 */
router.get('/:symbol', protect, async (req, res) => {
    try {
        const { symbol } = req.params;
        const { interval = '1d' } = req.query;
        const volumeAnalysis = await analyzeVolume(symbol, interval);
        res.json(volumeAnalysis);
    } catch (error) {
        console.error('Error in volume analysis route:', error);
        res.status(500).json({ error: 'Failed to analyze volume data' });
    }
});

module.exports = router;
