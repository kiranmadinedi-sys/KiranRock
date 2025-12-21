const express = require('express');
const router = express.Router();
const {
    getAggregatedNews,
    getNewsByCategory,
    getNewsByTicker,
    getHighImpactNews
} = require('../services/newsAggregationService');

/**
 * GET /api/news/aggregate
 * Get aggregated news from all sources
 * Query params:
 *   - tickers: comma-separated list of tickers (optional)
 *   - refresh: force refresh cache (optional)
 */
router.get('/aggregate', async (req, res) => {
    try {
        const { tickers, refresh } = req.query;
        
        const tickerArray = tickers ? tickers.split(',').map(t => t.trim().toUpperCase()) : null;
        const forceRefresh = refresh === 'true';

        const news = await getAggregatedNews(tickerArray, forceRefresh);

        res.json({
            success: true,
            count: news.length,
            news,
            cached: !forceRefresh,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error in /api/news/aggregate:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/news/category/:category
 * Get news filtered by category
 * Categories: all, macro, company, market, rates, geopolitics
 */
router.get('/category/:category', async (req, res) => {
    try {
        const { category } = req.params;
        const news = await getNewsByCategory(category);

        res.json({
            success: true,
            category,
            count: news.length,
            news,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error(`Error in /api/news/category/${req.params.category}:`, error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/news/ticker/:ticker
 * Get news for a specific ticker
 */
router.get('/ticker/:ticker', async (req, res) => {
    try {
        const { ticker } = req.params;
        const news = await getNewsByTicker(ticker);

        res.json({
            success: true,
            ticker: ticker.toUpperCase(),
            count: news.length,
            news,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error(`Error in /api/news/ticker/${req.params.ticker}:`, error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /api/news/high-impact
 * Get only high-impact market-moving news
 */
router.get('/high-impact', async (req, res) => {
    try {
        const news = await getHighImpactNews();

        res.json({
            success: true,
            count: news.length,
            news,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error in /api/news/high-impact:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
