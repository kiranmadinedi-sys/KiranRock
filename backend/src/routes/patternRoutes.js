const express = require('express');
const router = express.Router();
const { detectPatterns } = require('../services/patternDetectionService');
const { protect } = require('../middleware/authMiddleware');

/**
 * GET /api/patterns/:symbol
 * Detects technical chart patterns
 */
router.get('/:symbol', protect, async (req, res) => {
    try {
        const { symbol } = req.params;
        const { interval = '1d' } = req.query;
        const patterns = await detectPatterns(symbol, interval);
        res.json(patterns);
    } catch (error) {
        console.error('Error in pattern detection route:', error);
        res.status(500).json({ error: 'Failed to detect patterns' });
    }
});

module.exports = router;
