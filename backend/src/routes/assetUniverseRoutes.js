/**
 * Asset Universe Admin Routes
 *
 * GET  /api/asset-universe/status          — scheduler + DB stats
 * GET  /api/asset-universe/blacklist        — list blacklisted symbols
 * POST /api/asset-universe/blacklist        — add to blacklist
 * DELETE /api/asset-universe/blacklist/:symbol — remove from blacklist
 * GET  /api/asset-universe/halts           — list active halts
 * POST /api/asset-universe/halts/:symbol/resume — mark resumed
 * POST /api/asset-universe/refresh         — trigger manual evening refresh
 * POST /api/asset-universe/premarket       — trigger manual premarket refresh
 */

const express                  = require('express');
const router                   = express.Router();
const assetUniverseService     = require('../services/assetUniverseService');
const assetUniverseScheduler   = require('../services/assetUniverseScheduler');
const precomputedSvc           = require('../services/precomputedUniverseService');
const { protect: authenticateToken } = require('../middleware/authMiddleware');

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/status', authenticateToken, async (req, res) => {
    try {
        const [dbStatus, schedulerStatus] = await Promise.all([
            assetUniverseService.getStatus(),
            assetUniverseScheduler.getSchedulerStatus()
        ]);
        res.json({ success: true, db: dbStatus, scheduler: schedulerStatus });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Blacklist ─────────────────────────────────────────────────────────────────

router.get('/blacklist', authenticateToken, async (req, res) => {
    try {
        const list = await assetUniverseService.getBlacklist();
        res.json({ success: true, blacklist: list });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/blacklist', authenticateToken, async (req, res) => {
    const { symbol, reason, expiresInDays } = req.body;
    if (!symbol || typeof symbol !== 'string') {
        return res.status(400).json({ success: false, error: 'symbol required' });
    }
    try {
        await assetUniverseService.addToBlacklist(
            symbol.toUpperCase().trim(),
            reason || '',
            req.user?.username || 'admin',
            expiresInDays ? Number(expiresInDays) : null
        );
        res.json({ success: true, symbol: symbol.toUpperCase().trim() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.delete('/blacklist/:symbol', authenticateToken, async (req, res) => {
    const symbol = (req.params.symbol || '').toUpperCase().trim();
    try {
        const removed = await assetUniverseService.removeFromBlacklist(symbol);
        res.json({ success: true, symbol, removed });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Halts ─────────────────────────────────────────────────────────────────────

router.get('/halts', authenticateToken, async (req, res) => {
    try {
        const halts = await assetUniverseService.getActiveHalts();
        res.json({ success: true, halts });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/halts/:symbol/resume', authenticateToken, async (req, res) => {
    const symbol = (req.params.symbol || '').toUpperCase().trim();
    try {
        await assetUniverseService.markResumed(symbol);
        res.json({ success: true, symbol });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Manual triggers ───────────────────────────────────────────────────────────

router.post('/refresh', authenticateToken, async (req, res) => {
    res.json({ success: true, message: 'Evening refresh started in background' });
    // Fire-and-forget — don't block the HTTP response
    assetUniverseScheduler.runEveningRefresh().catch(err =>
        console.error('[AssetUniverse] Manual refresh failed:', err.message)
    );
});

router.post('/premarket', authenticateToken, async (req, res) => {
    res.json({ success: true, message: 'Pre-market refresh started in background' });
    assetUniverseScheduler.runPremarketRefresh().catch(err =>
        console.error('[AssetUniverse] Manual premarket failed:', err.message)
    );
});

// ── Nightly Universe Analysis (daily_universe_analysis) ───────────────────────

/**
 * GET /api/asset-universe/why/:symbol?date=YYYY-MM-DD
 * Operator query: why was this ticker included or excluded in the nightly scan?
 */
router.get('/why/:symbol', authenticateToken, async (req, res) => {
    const symbol = (req.params.symbol || '').toUpperCase().trim();
    const date   = req.query.date || undefined;
    try {
        const record = await precomputedSvc.getSymbolScanRecord(symbol, date);
        if (!record) {
            return res.json({
                success: true, found: false, symbol,
                message: 'Symbol not found in nightly scan for this date. It may not be in the universe or the scan has not run yet.'
            });
        }
        res.json({ success: true, found: true, record });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/asset-universe/scan-summary?date=YYYY-MM-DD
 * Returns today's scan stats: total analyzed, passed, avg score + exclusion breakdown.
 */
router.get('/scan-summary', authenticateToken, async (req, res) => {
    const date = req.query.date || undefined;
    try {
        const [summary, exclusions, newTickers] = await Promise.all([
            precomputedSvc.getDailyScanSummary(date),
            precomputedSvc.getExclusionSummary(date),
            precomputedSvc.getNewTickers()
        ]);
        res.json({ success: true, summary, exclusions, newTickers });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * GET /api/asset-universe/drift
 * Returns the 7-day prescreen drift report (conversion + win rate).
 */
router.get('/drift', authenticateToken, async (req, res) => {
    const days = parseInt(req.query.days) || 7;
    try {
        const drift = await precomputedSvc.checkPrescreenDrift(days);
        res.json({ success: true, drift });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/asset-universe/nightly-scan
 * Manually trigger the nightly universe scan (admin only).
 */
router.post('/nightly-scan', authenticateToken, async (req, res) => {
    res.json({ success: true, message: 'Nightly universe scan started in background' });
    try {
        const nightlyScanSvc = require('../services/nightlyUniverseScanService');
        nightlyScanSvc.runNightlyUniverseScan()
            .then(r => r && console.log(`[NightlyScan] Manual run done: ${r.passed} passed / ${r.analyzed} analyzed`))
            .catch(err => console.error('[NightlyScan] Manual run error:', err.message));
    } catch (err) {
        console.error('[NightlyScan] Manual trigger failed:', err.message);
    }
});

module.exports = router;
