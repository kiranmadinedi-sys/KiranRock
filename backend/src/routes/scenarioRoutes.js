const express = require('express');
const router = express.Router();
const scenarioModelingService = require('../services/scenarioModelingService');
const { protect } = require('../middleware/authMiddleware');

// All routes require authentication
router.use(protect);

/**
 * POST /api/scenarios/price-change
 * Model option Greeks changes with price movements
 */
router.post('/price-change', async (req, res) => {
    try {
        const { option, priceChange } = req.body;
        
        if (!option || priceChange === undefined) {
            return res.status(400).json({ error: 'option and priceChange required' });
        }
        
        const scenario = scenarioModelingService.modelPriceChange(option, priceChange);
        res.json(scenario);
    } catch (error) {
        console.error('[Scenario API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/scenarios/theta-decay
 * Model theta decay over multiple days
 */
router.post('/theta-decay', async (req, res) => {
    try {
        const { option, days } = req.body;
        
        if (!option || !days) {
            return res.status(400).json({ error: 'option and days required' });
        }
        
        const scenarios = scenarioModelingService.modelThetaDecay(option, days);
        res.json({ scenarios });
    } catch (error) {
        console.error('[Scenario API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/scenarios/matrix
 * Generate comprehensive scenario matrix
 */
router.post('/matrix', async (req, res) => {
    try {
        const { option } = req.body;
        
        if (!option) {
            return res.status(400).json({ error: 'option data required' });
        }
        
        const matrix = scenarioModelingService.generateScenarioMatrix(option);
        res.json(matrix);
    } catch (error) {
        console.error('[Scenario API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/scenarios/risk-metrics
 * Calculate risk metrics for an option
 */
router.post('/risk-metrics', async (req, res) => {
    try {
        const { option } = req.body;
        
        if (!option) {
            return res.status(400).json({ error: 'option data required' });
        }
        
        const priceScenarios = [-10, -5, -2, 0, 2, 5, 10].map(change => 
            scenarioModelingService.modelPriceChange(option, change)
        );
        
        const metrics = scenarioModelingService.calculateRiskMetrics(option, priceScenarios);
        res.json(metrics);
    } catch (error) {
        console.error('[Scenario API] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
