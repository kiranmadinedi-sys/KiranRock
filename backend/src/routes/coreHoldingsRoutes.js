/**
 * Core Holdings — API Routes (Settings screen, 2026-10-17)
 *
 * Same shape as cryptoTradingRoutes.js (GET /status, POST /enable, PUT /config), backed by
 * coreHoldingsService. Each user only ever sees and changes their own account.
 */
const express = require('express');
const router = express.Router();
const core = require('./../services/coreHoldingsService');
const { protect } = require('../middleware/authMiddleware');

router.use(protect);

/** GET /api/core-holdings/status — settings, core list with live values, account equity. */
router.get('/status', async (req, res) => {
    try {
        res.json(await core.getStatus(req.userId));
    } catch (error) {
        console.error('[Core Holdings API] Error getting status:', error);
        res.status(500).json({ error: error.message });
    }
});

/** POST /api/core-holdings/enable — Body: { enabled: boolean }. Off = stop buying only. */
router.post('/enable', async (req, res) => {
    try {
        const settings = await core.setEnabled(req.userId, !!req.body?.enabled);
        res.json({ success: true, enabled: settings.enabled });
    } catch (error) {
        console.error('[Core Holdings API] Error enabling:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * PUT /api/core-holdings/config
 * Body: { cashReservePct?, holdings: [{ symbol, targetPct }], releaseSymbols?: [] }
 */
router.put('/config', async (req, res) => {
    try {
        const { cashReservePct, holdings, releaseSymbols } = req.body || {};
        const result = await core.saveConfig(req.userId, {
            cashReservePct: cashReservePct != null ? Number(cashReservePct) : undefined,
            holdings: Array.isArray(holdings) ? holdings : [],
            releaseSymbols: Array.isArray(releaseSymbols) ? releaseSymbols : [],
        });
        res.json({ success: true, ...result });
    } catch (error) {
        if (error.status === 400) return res.status(400).json({ error: error.message, errors: error.errors });
        console.error('[Core Holdings API] Error saving config:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
