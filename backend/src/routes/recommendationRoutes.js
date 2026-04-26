const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const { generatePersonalizedRecommendations } = require('../services/recommendationService');
const { getWeeklyPredictions } = require('../services/weeklyPredictionService');

/**
 * @route GET /api/recommendations
 * @desc Get personalized stock recommendations for the authenticated user
 * @query {string} riskTolerance - conservative, moderate, or aggressive (default: moderate)
 * @query {number} maxRecommendations - Maximum recommendations to return (default: 10)
 * @query {string} universe - Stock universe: MEGA_CAP, TOP_200, or ALL (default: TOP_200)
 * @access Private (requires authentication)
 */
router.get('/', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const { 
            riskTolerance = 'moderate',
            maxRecommendations = 10,
            universe = 'TOP_200'
        } = req.query;
        
        console.log(`[Recommendations] Generating for user ${userId}, risk: ${riskTolerance}, universe: ${universe}`);
        
        // Get weekly predictions first
        const weeklyData = await getWeeklyPredictions({
            limit: 500,
            universe: universe.toUpperCase()
        });
        
        if (!weeklyData.predictions || weeklyData.predictions.length === 0) {
            return res.status(200).json({
                recommendations: [],
                portfolioActions: [],
                message: 'No predictions available to generate recommendations'
            });
        }
        
        // Generate personalized recommendations
        const recommendations = await generatePersonalizedRecommendations(
            userId,
            weeklyData.predictions,
            {
                maxRecommendations: parseInt(maxRecommendations),
                riskTolerance: riskTolerance.toLowerCase()
            }
        );
        
        res.json(recommendations);
        
    } catch (error) {
        console.error('[Recommendations] Error:', error);
        res.status(500).json({ 
            error: 'Failed to generate recommendations',
            details: error.message 
        });
    }
});

/**
 * @route GET /api/recommendations/quick
 * @desc Get quick recommendations (top 5 stocks only)
 * @query {string} riskTolerance - conservative, moderate, or aggressive
 * @access Private
 */
router.get('/quick', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const { riskTolerance = 'moderate' } = req.query;
        
        // Use MEGA_CAP for faster results
        const weeklyData = await getWeeklyPredictions({
            limit: 50,
            universe: 'MEGA_CAP'
        });
        
        const recommendations = await generatePersonalizedRecommendations(
            userId,
            weeklyData.predictions,
            {
                maxRecommendations: 5,
                riskTolerance: riskTolerance.toLowerCase()
            }
        );
        
        // Return only top 5 recommendations
        res.json({
            recommendations: recommendations.recommendations.slice(0, 5),
            summary: recommendations.summary,
            riskProfile: recommendations.riskProfile
        });
        
    } catch (error) {
        console.error('[Recommendations] Quick error:', error);
        res.status(500).json({ 
            error: 'Failed to generate quick recommendations',
            details: error.message 
        });
    }
});

/**
 * @route GET /api/recommendations/portfolio-actions
 * @desc Get only portfolio rebalancing actions (no new stocks)
 * @access Private
 */
router.get('/portfolio-actions', protect, async (req, res) => {
    try {
        const userId = req.user.id;
        const { universe = 'TOP_200' } = req.query;
        
        const weeklyData = await getWeeklyPredictions({
            limit: 500,
            universe: universe.toUpperCase()
        });
        
        const recommendations = await generatePersonalizedRecommendations(
            userId,
            weeklyData.predictions,
            { maxRecommendations: 0 } // Only get portfolio actions
        );
        
        res.json({
            portfolioActions: recommendations.portfolioActions,
            portfolioAnalysis: recommendations.portfolioAnalysis,
            summary: recommendations.summary
        });
        
    } catch (error) {
        console.error('[Recommendations] Portfolio actions error:', error);
        res.status(500).json({ 
            error: 'Failed to generate portfolio actions',
            details: error.message 
        });
    }
});

module.exports = router;
