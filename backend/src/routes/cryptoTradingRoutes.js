/**
 * Crypto Trading — API Routes
 *
 * Mirrors optionsBotRoutes.js's shape (GET /status, POST /enable, PUT
 * /config) but backed by cryptoDatabaseService.js's own auto-create-if-
 * missing getConfig/updateConfig rather than duplicating raw SQL per route.
 */
const express = require('express');
const router = express.Router();
const cryptoDb = require('./../services/cryptoDatabaseService');
const cryptoScheduler = require('./../services/cryptoScheduler');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

/**
 * GET /api/crypto-trading/status
 * Current config, open positions, and today's performance for this user.
 */
router.get('/status', async (req, res) => {
    try {
        const config = await cryptoDb.getConfig(req.userId);
        const positions = await cryptoDb.getPositions(req.userId);
        const todayStats = await cryptoDb.getTodaySummaryStats(req.userId);

        res.json({
            config,
            openPositions: positions,
            todayStats,
            universe: require('./../services/cryptoTradingBot').UNIVERSE
        });
    } catch (error) {
        console.error('[Crypto Trading API] Error getting status:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/crypto-trading/enable
 * Body: { enabled: boolean }
 */
router.post('/enable', async (req, res) => {
    try {
        const { enabled } = req.body;
        const config = await cryptoDb.updateConfig(req.userId, { enabled: !!enabled });
        res.json({ success: true, enabled: config.enabled });
    } catch (error) {
        console.error('[Crypto Trading API] Error enabling:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/crypto-trading/config
 * Body: any subset of allocation_amount, max_position_notional,
 * max_open_positions, max_daily_trades, daily_loss_limit,
 * stop_loss_percent, take_profit_percent, min_score
 */
router.put('/config', async (req, res) => {
    try {
        const config = await cryptoDb.updateConfig(req.userId, req.body || {});
        res.json({ success: true, config });
    } catch (error) {
        console.error('[Crypto Trading API] Error updating config:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/crypto-trading/trades
 * Recent trade history for this user.
 */
router.get('/trades', async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 50;
        const trades = await cryptoDb.getTradeHistory(req.userId, limit);
        res.json({ trades });
    } catch (error) {
        console.error('[Crypto Trading API] Error getting trades:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/crypto-trading/trigger
 * Manual one-off cycle for this user (same as options bot's manual trigger
 * pattern) — useful for testing enrollment without waiting for the next
 * 5-min scheduled tick.
 */
router.post('/trigger', async (req, res) => {
    try {
        const result = await cryptoScheduler.manualTrigger(req.userId);
        res.json({ success: true, result });
    } catch (error) {
        console.error('[Crypto Trading API] Error triggering manual cycle:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
