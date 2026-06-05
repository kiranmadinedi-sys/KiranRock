/**
 * Live-Readiness Gate (PANTHEON: SENTINEL)
 *
 * Single source of truth for the go/no-go decision that guards each
 * trading session.  Powers both the human-facing API endpoint and the
 * per-cycle bot gate.
 *
 * Two look-back windows:
 *
 *   HARD BLOCKERS — 30-day window (any non-zero → ready: false)
 *     duplicateOrders       — idempotency bypassed
 *     orderStorms           — >5 SUBMITTED per symbol per day
 *     stopLossFailures      — OPEN_WITH_STOP with no terminal state after 24h
 *     reconciliationErrors  — auto-fix failed; position state uncertain
 *     pendingOrdersOver24h  — order stuck in open state
 *
 *   SOFT INDICATORS — 7-day window (advisory only, never block)
 *     partialFills          — tracking works but fill patterns worth monitoring
 *     reconFixes            — drift existed but was auto-corrected
 *
 * Rationale: even one duplicate-order or stop-loss-failure incident in the
 * last month deserves a human look before deploying capital.  Partial fills
 * and recon fixes are normal operational events in live trading and only
 * need attention if they trend upward.
 */

const { query } = require('../config/database');
const { logger } = require('../utils/logger');

// Configurable via env — override for more aggressive paper-trading checks
const BLOCKER_DAYS  = parseInt(process.env.SENTINEL_BLOCKER_DAYS  || '30', 10);
const ADVISORY_DAYS = parseInt(process.env.SENTINEL_ADVISORY_DAYS || '7',  10);

/**
 * @param {string|null} userId   — scope to one user, or null for all users
 * @param {object}      opts
 * @param {number}      [opts.blockerDays=30]  — look-back for hard blockers
 * @param {number}      [opts.advisoryDays=7]  — look-back for soft indicators
 * @returns {Promise<{
 *   ready:         boolean,
 *   reason:        string,
 *   blockers:      Record<string, number>,
 *   advisory:      Record<string, number>,
 *   blockerDays:   number,
 *   advisoryDays:  number
 * }>}
 */
async function checkLiveReadiness(userId = null, {
    blockerDays  = BLOCKER_DAYS,
    advisoryDays = ADVISORY_DAYS
} = {}) {
    try {
        const bInterval = `NOW() - INTERVAL '${Math.max(1, blockerDays)} days'`;
        const aInterval = `NOW() - INTERVAL '${Math.max(1, advisoryDays)} days'`;

        const [dupes, storms, stopFail, reconErr, pendingOld, partials, reconFixes] =
            await Promise.all([
                // BLOCKER: duplicate submissions (same idem-key submitted > once)
                query(`
                    SELECT COUNT(*) AS cnt FROM (
                        SELECT idempotency_key FROM order_audit_log
                        WHERE state = 'SUBMITTED'
                          AND ($1::text IS NULL OR user_id = $1)
                          AND created_at >= ${bInterval}
                        GROUP BY idempotency_key HAVING COUNT(*) > 1
                    ) t
                `, [userId]),

                // BLOCKER: order storms (>5 SUBMITTED for same symbol on same day)
                query(`
                    SELECT COUNT(*) AS cnt FROM (
                        SELECT symbol, created_at::date AS day FROM order_audit_log
                        WHERE state = 'SUBMITTED'
                          AND ($1::text IS NULL OR user_id = $1)
                          AND created_at >= ${bInterval}
                        GROUP BY symbol, day HAVING COUNT(*) > 5
                    ) t
                `, [userId]),

                // BLOCKER: stop-loss failures (OPEN_WITH_STOP with no terminal state after 1 day)
                query(`
                    SELECT COUNT(*) AS cnt FROM (
                        SELECT DISTINCT o.idempotency_key FROM order_audit_log o
                        WHERE o.state = 'OPEN_WITH_STOP'
                          AND ($1::text IS NULL OR o.user_id = $1)
                          AND o.created_at >= ${bInterval}
                          AND o.created_at < NOW() - INTERVAL '1 day'
                          AND NOT EXISTS (
                              SELECT 1 FROM order_audit_log t
                              WHERE t.idempotency_key = o.idempotency_key
                                AND t.state IN ('STOPPED','CLOSED','CLOSED_MANUAL','CANCELED','REJECTED')
                          )
                    ) t
                `, [userId]),

                // BLOCKER: reconciliation errors (auto-fix failed)
                query(`
                    SELECT COUNT(*) AS cnt FROM position_reconciliation_log
                    WHERE ($1::text IS NULL OR user_id = $1)
                      AND reconciled_at >= ${bInterval}
                      AND action = 'ERROR'
                `, [userId]),

                // BLOCKER: orders still open after 24h (should never happen with day orders)
                query(`
                    SELECT COUNT(*) AS cnt FROM (
                        SELECT DISTINCT idempotency_key FROM order_audit_log
                        WHERE state IN ('SUBMITTED','PENDING_FILL','PARTIALLY_FILLED')
                          AND ($1::text IS NULL OR user_id = $1)
                          AND created_at < NOW() - INTERVAL '24 hours'
                          AND NOT EXISTS (
                              SELECT 1 FROM order_audit_log t2
                              WHERE t2.idempotency_key = order_audit_log.idempotency_key
                                AND t2.state IN ('FILLED','CANCELED','REJECTED','STOPPED','CLOSED')
                          )
                    ) t
                `, [userId]),

                // ADVISORY: partial fills (informational)
                query(`
                    SELECT COUNT(*) AS cnt FROM order_audit_log
                    WHERE state = 'PARTIALLY_FILLED'
                      AND ($1::text IS NULL OR user_id = $1)
                      AND created_at >= ${aInterval}
                `, [userId]),

                // ADVISORY: recon fixes (drift corrected automatically)
                query(`
                    SELECT COUNT(*) AS cnt FROM position_reconciliation_log
                    WHERE ($1::text IS NULL OR user_id = $1)
                      AND reconciled_at >= ${aInterval}
                      AND action != 'ERROR'
                `, [userId]),
            ]);

        const blockers = {
            duplicateOrders:      parseInt(dupes.rows[0]?.cnt)     || 0,
            orderStorms:          parseInt(storms.rows[0]?.cnt)    || 0,
            stopLossFailures:     parseInt(stopFail.rows[0]?.cnt)  || 0,
            reconciliationErrors: parseInt(reconErr.rows[0]?.cnt)  || 0,
            pendingOrdersOver24h: parseInt(pendingOld.rows[0]?.cnt) || 0,
        };
        const advisory = {
            partialFills: parseInt(partials.rows[0]?.cnt)   || 0,
            reconFixes:   parseInt(reconFixes.rows[0]?.cnt) || 0,
        };

        const blockingEntry = Object.entries(blockers).find(([, v]) => v > 0);
        const ready  = !blockingEntry;
        const reason = ready
            ? 'All safety checks passed'
            : `${blockingEntry[0]}: ${blockingEntry[1]} in last ${blockerDays}d`;

        return { ready, reason, blockers, advisory, blockerDays, advisoryDays };
    } catch (err) {
        logger.error('[SENTINEL] readiness check failed', { err: err.message });
        // Fail-open so a transient DB error doesn't freeze the bot — DB circuit breakers
        // (daily loss, drawdown, consecutive losses) still run independently.
        return {
            ready:        true,
            reason:       `readiness check error (fail-open): ${err.message}`,
            blockers:     {},
            advisory:     {},
            blockerDays,
            advisoryDays
        };
    }
}

module.exports = { checkLiveReadiness };
