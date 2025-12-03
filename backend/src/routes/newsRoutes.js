const express = require('express');
const router = express.Router();
const { getNewsSentiment } = require('../services/newsSentimentService');
const { protect } = require('../middleware/authMiddleware');

/**
 * GET /api/news/:symbol
 * Fetches news and sentiment analysis for a stock
 */
router.get('/:symbol', protect, async (req, res) => {
    try {
        const { symbol } = req.params;
        const newsSentiment = await getNewsSentiment(symbol);
        res.json(newsSentiment);
    } catch (error) {
        console.error('Error in news sentiment route:', error);
        res.status(500).json({ error: 'Failed to fetch news sentiment data' });
    }
});

module.exports = router;
