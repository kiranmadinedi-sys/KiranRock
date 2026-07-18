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

/**
 * GET /api/asset-universe/nightly-scan/failed-count?date=YYYY-MM-DD
 * How many symbols came back with no score (ai_score IS NULL) for a given
 * scan date — defaults to the most recent date that has any scan data.
 */
router.get('/nightly-scan/failed-count', authenticateToken, async (req, res) => {
    try {
        const { query } = require('../config/database');
        let date = req.query.date;
        if (!date) {
            const latest = await query(`SELECT MAX(analysis_date) as d FROM daily_universe_analysis`);
            date = latest.rows[0]?.d;
        }
        if (!date) return res.json({ date: null, failed: 0, total: 0 });

        const r = await query(
            `SELECT COUNT(*) FILTER (WHERE ai_score IS NULL) as failed, COUNT(*) as total
             FROM daily_universe_analysis WHERE analysis_date = $1::date`,
            [date]
        );
        res.json({
            date,
            failed: parseInt(r.rows[0].failed, 10),
            total:  parseInt(r.rows[0].total, 10)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/asset-universe/nightly-scan/rescan-missing
 * Retries ONLY the symbols that failed (ai_score IS NULL) for a given date
 * — defaults to the most recent scan date. Runs in background, same
 * one-at-a-time / 10s-apart pacing as the real scan to avoid re-triggering
 * the rate-limit cascade that likely caused the original failures.
 * Body: { date?: 'YYYY-MM-DD' }
 */
router.post('/nightly-scan/rescan-missing', authenticateToken, async (req, res) => {
    try {
        const { query } = require('../config/database');
        let date = req.body?.date;
        if (!date) {
            const latest = await query(`SELECT MAX(analysis_date) as d FROM daily_universe_analysis`);
            date = latest.rows[0]?.d;
        }
        if (!date) {
            return res.status(400).json({ success: false, error: 'No scan data found for any date' });
        }

        const failedRes = await query(
            `SELECT symbol FROM daily_universe_analysis
             WHERE analysis_date = $1::date AND ai_score IS NULL
             ORDER BY symbol`,
            [date]
        );
        const symbols = failedRes.rows.map(row => row.symbol);

        if (symbols.length === 0) {
            return res.json({ success: true, message: `No failed symbols for ${date} — nothing to rescan`, count: 0, date });
        }

        res.json({
            success: true,
            message: `Rescanning ${symbols.length} failed symbols for ${date} in background (~10s/symbol)`,
            count: symbols.length,
            date
        });

        const nightlyScanSvc = require('../services/nightlyUniverseScanService');
        nightlyScanSvc.rescanFailedSymbols(date, symbols)
            .then(r => console.log(`[NightlyScan] Manual rescan-missing done: ${r.analyzed} analyzed, ${r.passed} passed, ${r.stillFailed} still failed`))
            .catch(err => console.error('[NightlyScan] Manual rescan-missing error:', err.message));
    } catch (err) {
        console.error('[NightlyScan] Manual rescan-missing failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
