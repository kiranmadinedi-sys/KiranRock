const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const enhancedAITradingBot = require('../services/enhancedAITradingBot');
const enhancedAIScheduler = require('../services/enhancedAIScheduler');
const userProfileService = require('../services/userProfileService');
const { upsertRiskConfig, getRecentTradingLogs, getUserTradingControls, getGlobalTradingControl } = require('../services/tradingControlService');

router.use(protect);

function resolveAuthorizedUserId(req) {
    const requestedUserId = req.params.userId || req.body.userId;
    if (requestedUserId && requestedUserId !== req.userId) {
        const error = new Error('Forbidden: you can only manage your own AI trading settings');
        error.status = 403;
        throw error;
    }
    return req.userId;
}

/**
 * Enable/Disable AI Trading for a user
 */
router.post('/toggle', async (req, res) => {
    try {
        const userId = resolveAuthorizedUserId(req);
        const { enabled } = req.body;
        const result = await userProfileService.toggleAITrading(userId, enabled === true);

        res.json({
            success: true,
            aiTradingEnabled: result.aiTradingEnabled,
            toggledAt: result.toggledAt,
            message: enabled ? 'AI Trading enabled' : 'AI Trading disabled'
        });
    } catch (error) {
        const status = error.status || 500;
        console.error('Error toggling AI trading:', error);
        res.status(status).json({ error: error.message });
    }
});

/**
 * Get AI Trading status for a user
 */
router.get('/status/:userId?', async (req, res) => {
    try {
        const userId = resolveAuthorizedUserId(req);

        const riskConfig = await enhancedAITradingBot.getUserRiskConfig(userId);
        const schedulerStatus = await enhancedAIScheduler.getStatus();
        const marketOpen = enhancedAITradingBot.isMarketOpen();
        const userControls = await getUserTradingControls(userId);
        const globalControl = await getGlobalTradingControl();
        const lastActivity = (await getRecentTradingLogs(userId, 1))[0] || null;

        res.json({
            aiTradingEnabled: userControls.aiTradingEnabled,
            emergencyStopEnabled: userControls.emergencyStopEnabled,
            globalTradingEnabled: globalControl.globalTradingEnabled,
            killSwitchReason: globalControl.killSwitchReason,
            riskConfig,
            schedulerStatus,
            marketOpen,
            lastActivity
        });
    } catch (error) {
        const status = error.status || 500;
        console.error('Error getting AI trading status:', error);
        res.status(status).json({ error: error.message });
    }
});

/**
 * Update risk configuration for a user
 */
router.post('/config/:userId?', async (req, res) => {
    try {
        const userId = resolveAuthorizedUserId(req);
        const riskConfig = await upsertRiskConfig(userId, req.body || {});

        res.json({
            success: true,
            riskConfig
        });
    } catch (error) {
        const status = error.status || 500;
        console.error('Error updating risk config:', error);
        res.status(status).json({ error: error.message });
    }
});

/**
 * Get trading activity log
 */
router.get('/log/:userId?', async (req, res) => {
    try {
        const userId = resolveAuthorizedUserId(req);
        const { limit = 50 } = req.query;
        const log = await getRecentTradingLogs(userId, limit);

        res.json({
            log,
            totalEntries: log.length
        });
    } catch (error) {
        const status = error.status || 500;
        console.error('Error getting trading log:', error);
        res.status(status).json({ error: error.message });
    }
});

/**
 * Scan market for opportunities (manual trigger)
 */
router.post('/scan', async (req, res) => {
    try {
        const userId = resolveAuthorizedUserId(req);
        const { limit = 30 } = req.body || {};

        const opportunities = await enhancedAITradingBot.scanMarketForOpportunities(userId, limit);

        res.json({
            success: true,
            opportunities,
            count: opportunities.length,
            timestamp: new Date()
        });
    } catch (error) {
        const status = error.status || 500;
        console.error('Error scanning market:', error);
        res.status(status).json({ error: error.message });
    }
});

/**
 * Execute trading manually (for testing)
 */
router.post('/execute', async (req, res) => {
    try {
        const userId = resolveAuthorizedUserId(req);

        const result = await enhancedAITradingBot.executeAutonomousTrading(userId);

        res.json(result);
    } catch (error) {
        const status = error.status || 500;
        console.error('Error executing trading:', error);
        res.status(status).json({ error: error.message });
    }
});

/**
 * Get scheduler status (global)
 */
router.get('/scheduler/status', async (req, res) => {
    try {
        const status = await enhancedAIScheduler.getStatus();
        res.json(status);
    } catch (error) {
        console.error('Error getting scheduler status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Check if market is open
 */
router.get('/market/status', (req, res) => {
    try {
        const isOpen = enhancedAITradingBot.isMarketOpen();
        res.json({
            marketOpen: isOpen,
            timestamp: new Date()
        });
    } catch (error) {
        console.error('Error checking market status:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
