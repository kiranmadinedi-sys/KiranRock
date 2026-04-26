const express = require('express');
const router = express.Router();
const enhancedAITradingBot = require('../services/enhancedAITradingBot');
const enhancedAIScheduler = require('../services/enhancedAIScheduler');
const fs = require('fs').promises;
const path = require('path');

const USERS_FILE = path.join(__dirname, '../../users.json');

/**
 * Enable/Disable AI Trading for a user
 */
router.post('/toggle', async (req, res) => {
    try {
        const { userId, enabled } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);

        if (userIndex === -1) {
            return res.status(404).json({ error: 'User not found' });
        }

        users[userIndex].aiTradingEnabled = enabled;
        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));

        res.json({
            success: true,
            aiTradingEnabled: users[userIndex].aiTradingEnabled,
            message: enabled ? 'AI Trading enabled' : 'AI Trading disabled'
        });
    } catch (error) {
        console.error('Error toggling AI trading:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get AI Trading status for a user
 */
router.get('/status/:userId', async (req, res) => {
    try {
        const { userId } = req.params;

        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const riskConfig = await enhancedAITradingBot.getUserRiskConfig(userId);
        const schedulerStatus = enhancedAIScheduler.getStatus();
        const marketOpen = enhancedAITradingBot.isMarketOpen();

        res.json({
            aiTradingEnabled: user.aiTradingEnabled || false,
            riskConfig,
            schedulerStatus,
            marketOpen,
            lastActivity: user.aiTradingLog && user.aiTradingLog.length > 0 
                ? user.aiTradingLog[user.aiTradingLog.length - 1] 
                : null
        });
    } catch (error) {
        console.error('Error getting AI trading status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Update risk configuration for a user
 */
router.post('/config/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const riskConfig = req.body;

        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const userIndex = users.findIndex(u => u.id === userId);

        if (userIndex === -1) {
            return res.status(404).json({ error: 'User not found' });
        }

        users[userIndex].aiRiskConfig = {
            ...users[userIndex].aiRiskConfig,
            ...riskConfig
        };

        await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));

        res.json({
            success: true,
            riskConfig: users[userIndex].aiRiskConfig
        });
    } catch (error) {
        console.error('Error updating risk config:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get trading activity log
 */
router.get('/log/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const { limit = 50 } = req.query;

        const users = JSON.parse(await fs.readFile(USERS_FILE, 'utf8'));
        const user = users.find(u => u.id === userId);

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        const log = user.aiTradingLog || [];
        const limitedLog = log.slice(-parseInt(limit));

        res.json({
            log: limitedLog,
            totalEntries: log.length
        });
    } catch (error) {
        console.error('Error getting trading log:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Scan market for opportunities (manual trigger)
 */
router.post('/scan', async (req, res) => {
    try {
        const { userId, limit = 30 } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const opportunities = await enhancedAITradingBot.scanMarketForOpportunities(userId, limit);

        res.json({
            success: true,
            opportunities,
            count: opportunities.length,
            timestamp: new Date()
        });
    } catch (error) {
        console.error('Error scanning market:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Execute trading manually (for testing)
 */
router.post('/execute', async (req, res) => {
    try {
        const { userId } = req.body;

        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        const result = await enhancedAITradingBot.executeAutonomousTrading(userId);

        res.json(result);
    } catch (error) {
        console.error('Error executing trading:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * Get scheduler status (global)
 */
router.get('/scheduler/status', (req, res) => {
    try {
        const status = enhancedAIScheduler.getStatus();
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
