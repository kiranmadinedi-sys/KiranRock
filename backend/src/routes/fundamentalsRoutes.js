const express = require('express');
const router = express.Router();
const { getFundamentals } = require('../services/fundamentalsService');
const { protect } = require('../middleware/authMiddleware');

/**
 * GET /api/fundamentals/:symbol
 * Fetches fundamental data for a stock
 */
router.get('/:symbol', protect, async (req, res) => {
    try {
        const { symbol } = req.params;
        const fundamentals = await getFundamentals(symbol);
        res.json(fundamentals);
    } catch (error) {
        console.error('Error in fundamentals route:', error);
        res.status(500).json({ error: 'Failed to fetch fundamental data' });
    }
});

module.exports = router;
