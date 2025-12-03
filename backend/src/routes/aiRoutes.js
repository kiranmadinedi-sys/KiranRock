const express = require('express');
const router = express.Router();
const { getAIPrediction } = require('../services/aiPredictionService');
const { getMultiModelPrediction } = require('../services/multiModelAIService');
const { protect } = require('../middleware/authMiddleware');

/**
 * GET /api/ai/prediction/:symbol
 * Gets AI-based stock prediction with sentiment and technical analysis (single model)
 */
router.get('/prediction/:symbol', protect, async (req, res) => {
    try {
        const { symbol } = req.params;
        const prediction = await getAIPrediction(symbol);
        res.json(prediction);
    } catch (error) {
        console.error('Error in AI prediction route:', error);
        res.status(500).json({ error: 'Failed to generate AI prediction' });
    }
});

/**
 * GET /api/ai/ensemble/:symbol
 * Gets multi-model ensemble prediction (FinBERT + DistilBERT + Technical + Momentum agents)
 * Similar to Trade Ideas Holly AI with multiple AI models working together
 */
router.get('/ensemble/:symbol', protect, async (req, res) => {
    try {
        const { symbol } = req.params;
        const prediction = await getMultiModelPrediction(symbol);
        res.json(prediction);
    } catch (error) {
        console.error('Error in multi-model prediction route:', error);
        res.status(500).json({ error: 'Failed to generate ensemble prediction' });
    }
});

module.exports = router;
