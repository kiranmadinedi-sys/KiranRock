const express = require('express');
const router = express.Router();
const { getFundamentals } = require('../services/fundamentalsService');

// Middleware to disable caching
const noCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};

/**
 * GET /api/fundamentals/:symbol
 * Fetches fundamental data for a stock
 * No authentication required - public stock data
 */
router.get('/:symbol', noCache, async (req, res) => {
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
