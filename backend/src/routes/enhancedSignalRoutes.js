const express = require('express');
const router = express.Router();
const { getEnhancedSignals, getMultiTimeframeAnalysis } = require('../services/enhancedSignalService');

// Middleware to disable caching
const noCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};

/**
 * GET /api/enhanced-signals/:symbol
 * Get enhanced signals with multi-indicator confluence
 */
router.get('/:symbol', noCache, async (req, res) => {
    console.log(`[${new Date().toISOString()}] GET /api/enhanced-signals/${req.params.symbol}`);
    const { symbol } = req.params;
    const { 
        interval = '1d', 
        shortPeriod = 5, 
        longPeriod = 15,
        includePatterns = 'true',
        includeDivergence = 'true',
        minConfluence = 3
    } = req.query;
    
    try {
        const options = {
            shortPeriod: parseInt(shortPeriod),
            longPeriod: parseInt(longPeriod),
            includePatterns: includePatterns === 'true',
            includeDivergence: includeDivergence === 'true',
            minConfluence: parseInt(minConfluence)
        };
        
        const result = await getEnhancedSignals(symbol.toUpperCase(), interval, options);
        console.log(`[${new Date().toISOString()}] Enhanced signals for ${symbol}: ${result.signals.length} signals, avg confidence: ${result.metadata.avgConfidence}%`);
        res.json(result);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in enhanced signals for ${symbol}:`, error);
        res.status(500).json({ error: 'Server error while fetching enhanced signals' });
    }
});

/**
 * GET /api/enhanced-signals/:symbol/mtf
 * Get multi-timeframe analysis
 */
router.get('/:symbol/mtf', noCache, async (req, res) => {
    console.log(`[${new Date().toISOString()}] GET /api/enhanced-signals/${req.params.symbol}/mtf`);
    const { symbol } = req.params;
    
    try {
        const result = await getMultiTimeframeAnalysis(symbol.toUpperCase());
        console.log(`[${new Date().toISOString()}] MTF analysis for ${symbol}: ${result.alignment} (${result.alignmentStrength}%)`);
        res.json(result);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Error in MTF analysis for ${symbol}:`, error);
        res.status(500).json({ error: 'Server error while fetching MTF analysis' });
    }
});

module.exports = router;
