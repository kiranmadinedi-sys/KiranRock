const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const userProfileService = require('../services/userProfileService');
const userDb = require('../services/userDatabaseService');
const telegramLinkService = require('../services/telegramLinkService');
const { query } = require('../config/database');

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
        console.log('[Profile] AI Trading toggle request:', { userId: req.userId, body: req.body });
        
        const { enabled } = req.body;
        
        if (typeof enabled !== 'boolean') {
            console.error('[Profile] Invalid enabled value:', enabled);
            return res.status(400).json({ error: 'enabled must be a boolean value' });
        }
        
        console.log('[Profile] Calling toggleAITrading with userId:', req.userId, 'enabled:', enabled);
        const result = await userProfileService.toggleAITrading(req.userId, enabled);
        
        console.log('[Profile] Toggle successful:', result);
        res.json({
            message: enabled ? 'AI Trading enabled successfully' : 'AI Trading disabled successfully',
            ...result
        });
    } catch (error) {
        console.error('[Profile] Error toggling AI trading:', error);
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

/**
 * GET /api/profile/broker
 * Returns the user's Alpaca credential status (never returns the secret key).
 */
router.get('/broker', async (req, res) => {
    try {
        const creds = await userDb.getUserAlpacaCredentials(req.userId);
        res.json({
            configured:  creds.source === 'user',
            source:      creds.source,
            keyId:       creds.keyId ? creds.keyId.slice(0, 4) + '****' + creds.keyId.slice(-4) : null,
            isPaper:     creds.isPaper,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/profile/broker
 * Save per-user Alpaca credentials.
 * Send secretKey only when changing it; omit to keep existing.
 */
router.put('/broker', async (req, res) => {
    try {
        const { keyId, secretKey, isPaper } = req.body;
        if (!keyId) {
            return res.status(400).json({ error: 'alpaca_key_id is required' });
        }

        // Basic key format sanity check (Alpaca keys start with PK or AK)
        if (!/^[A-Z0-9]{20,}$/i.test(keyId)) {
            return res.status(400).json({ error: 'Key ID looks invalid — check you copied it correctly' });
        }

        await userDb.saveUserAlpacaCredentials(req.userId, { keyId, secretKey, isPaper });

        // Quick connection test using the provided credentials
        let testResult = { ok: false, message: 'Credentials saved (connection test skipped)' };
        if (secretKey) {
            try {
                const Alpaca = require('@alpacahq/alpaca-trade-api');
                const baseUrl = isPaper === false
                    ? 'https://api.alpaca.markets'
                    : 'https://paper-api.alpaca.markets';
                const client = new Alpaca({ keyId, secretKey, baseUrl, usePolygon: false });
                const acct = await client.getAccount();
                testResult = {
                    ok: true,
                    message: `Connected — Account ${acct.account_number}, buying power $${parseFloat(acct.buying_power || 0).toFixed(2)}`
                };
            } catch (testErr) {
                testResult = { ok: false, message: `Saved, but connection failed: ${testErr.message}` };
            }
        }

        res.json({ saved: true, ...testResult });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/profile/broker
 * Remove per-user credentials — reverts to shared .env keys.
 */
router.delete('/broker', async (req, res) => {
    try {
        await userDb.clearUserAlpacaCredentials(req.userId);
        res.json({ cleared: true, message: 'Reverted to shared account credentials' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/profile/telegram
 * Connection status — never returns the raw chat ID.
 */
router.get('/telegram', async (req, res) => {
    try {
        const result = await query('SELECT telegram_chat_id FROM users WHERE id = $1', [req.userId]);
        res.json({ connected: !!result.rows[0]?.telegram_chat_id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/profile/telegram/link
 * Generates a one-time deep link (t.me/<bot>?start=<code>) — visiting it and
 * hitting Start on the bot binds that chat to this account.
 */
router.post('/telegram/link', async (req, res) => {
    try {
        const { code, deepLink, expiresAt } = await telegramLinkService.generateLinkCode(req.userId);
        res.json({ code, deepLink, expiresAt });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/profile/telegram
 * Unlinks this account's Telegram chat.
 */
router.delete('/telegram', async (req, res) => {
    try {
        await query('UPDATE users SET telegram_chat_id = NULL WHERE id = $1', [req.userId]);
        res.json({ cleared: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
