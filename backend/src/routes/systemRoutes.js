const express = require('express');
const router  = express.Router();
const { triggerDataIngestion, triggerMonthlyReport } = require('../controllers/systemController');
const { protect } = require('../middleware/authMiddleware');
const { query }   = require('../config/database');
const { checkLiveReadiness } = require('../services/liveReadinessService');

router.post('/ingest-history',      protect, triggerDataIngestion);
router.post('/send-monthly-report', protect, triggerMonthlyReport);

/**
 * GET /api/system/health-dashboard
 *
 * Daily execution-quality dashboard for the 7 metrics that matter before
 * going live.  All counters are for "today" (calendar day in ET).
 *
 * Response shape:
 * {
 *   date: "2026-06-05",
 *   metrics: {
 *     duplicateOrders:     0,   // same idem-key submitted > once today
 *     ghostPositions:      0,   // DB holdings with no matching Alpaca position (from recon log)
 *     openOrderStorms:     0,   // symbols with > 3 SUBMITTED states in order_audit_log today
 *     holdingsMismatches:  0,   // drift + phantom + shadow from recon log today
 *     orphanSells:         0,   // sell orders for symbols with 0 DB holding at time of sell
 *     partialFillWarnings: 0,   // PARTIALLY_FILLED states today
 *     stopLossFailures:    0,   // OPEN_WITH_STOP entries with no STOPPED/CLOSED follow-up > 1 day old
 *   },
 *   status: "GREEN" | "YELLOW" | "RED"
 * }
 */
router.get('/health-dashboard', protect, async (req, res) => {
    try {
        const userId = req.user?.id;

        const [dupes, storms, partials, stopFailures, reconFixes, pendingOld] = await Promise.all([
            // Duplicate submissions: idem-key appears in SUBMITTED state more than once today
            query(`
                SELECT COUNT(*) AS cnt
                FROM (
                    SELECT idempotency_key
                    FROM order_audit_log
                    WHERE state = 'SUBMITTED'
                      AND ($1::text IS NULL OR user_id = $1)
                      AND created_at >= CURRENT_DATE
                    GROUP BY idempotency_key
                    HAVING COUNT(*) > 1
                ) t
            `, [userId || null]),

            // Order storms: symbol with > 3 SUBMITTED entries in audit log today
            query(`
                SELECT COUNT(*) AS cnt
                FROM (
                    SELECT symbol
                    FROM order_audit_log
                    WHERE state = 'SUBMITTED'
                      AND ($1::text IS NULL OR user_id = $1)
                      AND created_at >= CURRENT_DATE
                    GROUP BY symbol
                    HAVING COUNT(*) > 3
                ) t
            `, [userId || null]),

            // Partial fills today
            query(`
                SELECT COUNT(*) AS cnt
                FROM order_audit_log
                WHERE state = 'PARTIALLY_FILLED'
                  AND ($1::text IS NULL OR user_id = $1)
                  AND created_at >= CURRENT_DATE
            `, [userId || null]),

            // Stop-loss failures: OPEN_WITH_STOP entries older than 1 day with no terminal follow-up
            query(`
                SELECT COUNT(*) AS cnt
                FROM (
                    SELECT DISTINCT o.idempotency_key
                    FROM order_audit_log o
                    WHERE o.state = 'OPEN_WITH_STOP'
                      AND ($1::text IS NULL OR o.user_id = $1)
                      AND o.created_at < NOW() - INTERVAL '1 day'
                      AND NOT EXISTS (
                          SELECT 1 FROM order_audit_log t
                          WHERE t.idempotency_key = o.idempotency_key
                            AND t.state IN ('STOPPED', 'CLOSED', 'CLOSED_MANUAL', 'CANCELED', 'REJECTED')
                      )
                ) t
            `, [userId || null]),

            // Reconciliation fixes today — from immutable audit trail
            query(`
                SELECT COUNT(*) AS cnt
                FROM position_reconciliation_log
                WHERE ($1::text IS NULL OR user_id = $1)
                  AND reconciled_at >= CURRENT_DATE
                  AND action != 'ERROR'
            `, [userId || null]),

            // Pending orders older than 24h — indicates orders that never filled or canceled
            query(`
                SELECT COUNT(*) AS cnt
                FROM (
                    SELECT DISTINCT idempotency_key
                    FROM order_audit_log
                    WHERE state IN ('SUBMITTED', 'PENDING_FILL', 'PARTIALLY_FILLED')
                      AND ($1::text IS NULL OR user_id = $1)
                      AND created_at < NOW() - INTERVAL '24 hours'
                      AND NOT EXISTS (
                          SELECT 1 FROM order_audit_log t2
                          WHERE t2.idempotency_key = order_audit_log.idempotency_key
                            AND t2.state IN ('FILLED', 'CANCELED', 'REJECTED', 'STOPPED', 'CLOSED')
                      )
                ) t
            `, [userId || null]),
        ]);

        const metrics = {
            duplicateOrders:         parseInt(dupes.rows[0]?.cnt)        || 0,
            openOrderStorms:         parseInt(storms.rows[0]?.cnt)        || 0,
            partialFillWarnings:     parseInt(partials.rows[0]?.cnt)      || 0,
            stopLossFailures:        parseInt(stopFailures.rows[0]?.cnt)  || 0,
            reconciliationFixes:     parseInt(reconFixes.rows[0]?.cnt)    || 0,
            pendingOrdersOver24h:    parseInt(pendingOld.rows[0]?.cnt)    || 0,
        };

        const critical = metrics.duplicateOrders + metrics.openOrderStorms +
                         metrics.stopLossFailures + metrics.pendingOrdersOver24h;
        const warnings  = metrics.partialFillWarnings + metrics.reconciliationFixes;
        const status    = critical > 0 ? 'RED' : warnings > 0 ? 'YELLOW' : 'GREEN';

        const etDate = new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York' });

        res.json({ date: etDate, metrics, status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/system/live-readiness
 *
 * Aggregates all safety metrics over the configured look-back window
 * (default 7 days, overridable with ?days=N) and returns a single
 * go/no-go decision for deploying live capital.
 *
 * Criteria that block live trading (any non-zero → liveReady: false):
 *   duplicateOrders       — idempotency bypassed
 *   orderStorms           — runaway submission loop
 *   stopLossFailures      — bracket exits didn't fire
 *   reconciliationErrors  — auto-fix failed, positions uncertain
 *   pendingOrdersOver24h  — order stuck; capital locked, state unknown
 *
 * Advisory (non-blocking, shown for transparency):
 *   partialFills          — broker partially filled; tracking correct?
 *   reconFixes            — drift existed but was auto-corrected
 *
 * Response:
 * {
 *   window: "7 days",
 *   checkedAt: "2026-06-05T15:45:00Z",
 *   blockers: { duplicateOrders:0, orderStorms:0, stopLossFailures:0,
 *               reconciliationErrors:0, pendingOrdersOver24h:0 },
 *   advisory: { partialFills:0, reconFixes:0 },
 *   liveReady: true,
 *   reason: "All safety checks passed"          // or first blocking reason
 * }
 */
router.get('/live-readiness', protect, async (req, res) => {
    try {
        const userId       = req.user?.id;
        const blockerDays  = Math.min(Math.max(parseInt(req.query.blockerDays  || req.query.days || '30'), 1), 90);
        const advisoryDays = Math.min(Math.max(parseInt(req.query.advisoryDays || '7'), 1), 30);
        const result = await checkLiveReadiness(userId || null, { blockerDays, advisoryDays });
        res.json({
            blockerWindow:  `${result.blockerDays} days`,
            advisoryWindow: `${result.advisoryDays} days`,
            checkedAt:      new Date().toISOString(),
            blockers:       result.blockers,
            advisory:       result.advisory,
            liveReady:      result.ready,
            reason:         result.reason
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/system/trade-attribution
 *
 * Returns win-rate and average P&L broken down by score bucket, sector,
 * and holding period — the three most actionable strategy diagnostics.
 * Defaults to last 90 days; override with ?days=N.
 */
router.get('/trade-attribution', protect, async (req, res) => {
    try {
        const userId = req.user?.id;
        const days   = Math.min(Math.max(parseInt(req.query.days) || 90, 7), 365);

        const [byScore, bySector, byHold, byExit] = await Promise.all([
            // Win rate + avg P&L by AI score bucket
            query(`
                SELECT
                    CASE
                        WHEN score >= 90 THEN '90-100'
                        WHEN score >= 80 THEN '80-89'
                        WHEN score >= 70 THEN '70-79'
                        ELSE '<70'
                    END AS score_bucket,
                    COUNT(*)                                                                      AS trades,
                    ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / NULLIF(COUNT(*), 0), 1)     AS win_rate,
                    ROUND(AVG(pnl_percent)::numeric, 2)                                           AS avg_pnl_pct,
                    ROUND(SUM(pnl)::numeric, 2)                                                   AS total_pnl
                FROM trade_decision_journal
                WHERE ($1::text IS NULL OR user_id = $1)
                  AND decision_phase = 'CLOSED'
                  AND pnl IS NOT NULL
                  AND created_at >= NOW() - INTERVAL '${days} days'
                GROUP BY 1 ORDER BY MIN(score) DESC
            `, [userId || null]),

            // Win rate + avg P&L by sector (stored in metadata)
            query(`
                SELECT
                    COALESCE(metadata->>'sector', 'Unknown') AS sector,
                    COUNT(*)                                                                      AS trades,
                    ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / NULLIF(COUNT(*), 0), 1)     AS win_rate,
                    ROUND(AVG(pnl_percent)::numeric, 2)                                           AS avg_pnl_pct,
                    ROUND(SUM(pnl)::numeric, 2)                                                   AS total_pnl
                FROM trade_decision_journal
                WHERE ($1::text IS NULL OR user_id = $1)
                  AND decision_phase = 'CLOSED'
                  AND pnl IS NOT NULL
                  AND created_at >= NOW() - INTERVAL '${days} days'
                GROUP BY 1 HAVING COUNT(*) >= 3
                ORDER BY avg_pnl_pct DESC
            `, [userId || null]),

            // Win rate + avg P&L by holding period bucket
            query(`
                SELECT
                    CASE
                        WHEN EXTRACT(EPOCH FROM (closed_at - opened_at)) / 86400 < 1  THEN '< 1 day'
                        WHEN EXTRACT(EPOCH FROM (closed_at - opened_at)) / 86400 < 4  THEN '1-3 days'
                        WHEN EXTRACT(EPOCH FROM (closed_at - opened_at)) / 86400 < 8  THEN '4-7 days'
                        WHEN EXTRACT(EPOCH FROM (closed_at - opened_at)) / 86400 < 15 THEN '8-14 days'
                        ELSE '15+ days'
                    END AS hold_bucket,
                    COUNT(*)                                                                      AS trades,
                    ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / NULLIF(COUNT(*), 0), 1)     AS win_rate,
                    ROUND(AVG(pnl_percent)::numeric, 2)                                           AS avg_pnl_pct,
                    ROUND(SUM(pnl)::numeric, 2)                                                   AS total_pnl
                FROM trade_decision_journal
                WHERE ($1::text IS NULL OR user_id = $1)
                  AND decision_phase = 'CLOSED'
                  AND pnl IS NOT NULL
                  AND opened_at IS NOT NULL AND closed_at IS NOT NULL
                  AND created_at >= NOW() - INTERVAL '${days} days'
                GROUP BY 1 ORDER BY MIN(EXTRACT(EPOCH FROM (closed_at - opened_at)))
            `, [userId || null]),

            // Win rate by exit reason
            query(`
                SELECT
                    COALESCE(metadata->>'exitReason', metadata->>'reason', 'unknown') AS exit_reason,
                    COUNT(*)                                                                      AS trades,
                    ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / NULLIF(COUNT(*), 0), 1)     AS win_rate,
                    ROUND(AVG(pnl_percent)::numeric, 2)                                           AS avg_pnl_pct
                FROM trade_decision_journal
                WHERE ($1::text IS NULL OR user_id = $1)
                  AND decision_phase = 'CLOSED'
                  AND pnl IS NOT NULL
                  AND created_at >= NOW() - INTERVAL '${days} days'
                GROUP BY 1 HAVING COUNT(*) >= 2
                ORDER BY total_pnl DESC
            `, [userId || null]),
        ]);

        res.json({
            window:      `${days} days`,
            byScore:     byScore.rows,
            bySector:    bySector.rows,
            byHoldPeriod: byHold.rows,
            byExitReason: byExit.rows,
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
