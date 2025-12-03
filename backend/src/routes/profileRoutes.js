const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const userProfileService = require('../services/userProfileService');

// All routes require authentication
router.use(protect);

/**
 * GET /api/profile
 * Get user profile information
 */
router.get('/', async (req, res) => {
    try {
        const profile = await userProfileService.getUserProfile(req.userId);
        res.json(profile);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/profile
 * Update user profile information
 */
router.put('/', async (req, res) => {
    try {
        const { firstName, lastName, email, phone } = req.body;
        const profile = await userProfileService.updateUserProfile(req.userId, {
            firstName,
            lastName,
            email,
            phone
        });
        res.json(profile);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/profile/change-password
 * Change user password
 */
router.post('/change-password', async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Current password and new password are required' });
        }
        
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters' });
        }
        
        const result = await userProfileService.changePassword(req.userId, currentPassword, newPassword);
        res.json(result);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

/**
 * POST /api/profile/ai-trading/toggle
 * Enable/disable AI trading
 */
router.post('/ai-trading/toggle', async (req, res) => {
    try {
        const { enabled } = req.body;
        
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'enabled must be a boolean value' });
        }
        
        const result = await userProfileService.toggleAITrading(req.userId, enabled);
        res.json({
            message: enabled ? 'AI Trading enabled successfully' : 'AI Trading disabled successfully',
            ...result
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/profile/ai-trading/decisions
 * Get AI trading decision log
 */
router.get('/ai-trading/decisions', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;
        const decisions = await userProfileService.getAIDecisions(req.userId, limit);
        res.json({ decisions });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
