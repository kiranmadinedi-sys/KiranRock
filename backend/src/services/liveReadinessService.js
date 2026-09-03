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
                // BLOCKER: duplicate submissions (same idem-key submitted > once, not acknowledged)
                query(`
                    SELECT COUNT(*) AS cnt FROM (
                        SELECT idempotency_key FROM order_audit_log
                        WHERE state = 'SUBMITTED'
                          AND ($1::text IS NULL OR user_id = $1)
                          AND created_at >= ${bInterval}
                          AND idempotency_key NOT IN (
                              SELECT idempotency_key FROM sentinel_order_acknowledgements
                          )
                        GROUP BY idempotency_key HAVING COUNT(*) > 1
                    ) t
                `, [userId]),

                // BLOCKER: order storms (>5 SUBMITTED for same symbol on same day, not all acknowledged)
                query(`
                    SELECT COUNT(*) AS cnt FROM (
                        SELECT symbol, created_at::date AS day FROM order_audit_log
                        WHERE state = 'SUBMITTED'
                          AND ($1::text IS NULL OR user_id = $1)
                          AND created_at >= ${bInterval}
                          AND idempotency_key NOT IN (
                              SELECT idempotency_key FROM sentinel_order_acknowledgements
                          )
                        GROUP BY symbol, day HAVING COUNT(*) > 5
                    ) t
                `, [userId]),

                // BLOCKER: stop-loss failures (OPEN_WITH_STOP with no terminal state after 1 day,
                // but ONLY if the position is no longer held — swing trades stay OPEN_WITH_STOP
                // for many days/weeks while the position is active, which is correct behaviour).
                //
                // brokerService.sellMarket() always mints a fresh idempotency_key for every sell
                // (`SYMBOL:date:sell:reason`) — it never reuses the original buy order's key. That
                // means a perfectly successful trailing-stop/stop-loss exit can NEVER satisfy a
                // same-idempotency_key terminal-state check, so the first NOT EXISTS below (kept
                // for legacy same-key closes/bracket cancels) is supplemented with a second check
                // that matches by symbol+user instead, requiring no new buy-fill in between so a
                // later, unrelated round-trip's close can't mask a genuinely unresolved incident.
                query(`
                    SELECT COUNT(*) AS cnt FROM (
                        SELECT DISTINCT o.idempotency_key FROM order_audit_log o
                        WHERE o.state = 'OPEN_WITH_STOP'
                          AND ($1::text IS NULL OR o.user_id = $1)
                          AND o.created_at >= ${bInterval}
                          AND o.created_at < NOW() - INTERVAL '1 day'
                          AND o.idempotency_key NOT IN (
                              SELECT idempotency_key FROM sentinel_order_acknowledgements
                          )
                          AND NOT EXISTS (
                              SELECT 1 FROM order_audit_log t
                              WHERE t.idempotency_key LIKE o.idempotency_key || '%'
                                AND t.state IN ('STOPPED','CLOSED','CLOSED_MANUAL','CANCELED','REJECTED')
                          )
                          AND NOT EXISTS (
                              SELECT 1 FROM order_audit_log t
                              WHERE t.symbol = o.symbol
                                AND t.user_id = o.user_id
                                AND t.state IN ('STOPPED','CLOSED','CLOSED_MANUAL')
                                AND t.created_at > o.created_at
                                AND NOT EXISTS (
                                    SELECT 1 FROM order_audit_log b
                                    WHERE b.symbol = o.symbol
                                      AND b.user_id = o.user_id
                                      AND b.state = 'FILLED'
                                      AND b.created_at > o.created_at
                                      AND b.created_at < t.created_at
                                )
                          )
                          AND NOT EXISTS (
                              SELECT 1 FROM holdings h
                              WHERE h.symbol = o.symbol
                                AND ($1::text IS NULL OR h.user_id = $1)
                                AND h.quantity > 0
                          )
                    ) t
                `, [userId]),

                // BLOCKER: reconciliation errors (auto-fix failed, not acknowledged)
                query(`
                    SELECT COUNT(*) AS cnt FROM position_reconciliation_log
                    WHERE ($1::text IS NULL OR user_id = $1)
                      AND reconciled_at >= ${bInterval}
                      AND action = 'ERROR'
                      AND acknowledged IS NOT TRUE
                `, [userId]),

                // BLOCKER: orders still open after 24h (should never happen with day orders).
                // Traced precisely 2026-09-03: IGV and MDLZ both sitting here were trailing-
                // stop exits whose PARTIALLY_FILLED row's own metadata already says
                // `"exitState":"CLOSED"` — the position closed successfully same-day. What
                // actually resolves the leftover unfilled remainder is an end-of-day cleanup
                // pass (ARROW EOD / IST-ARROW EOD) that cancels it — but that cleanup writes
                // its CANCELED row under a CHILD idempotency_key with a suffix appended
                // (base key + ":arrow_eod" or ":eod_cleanup"), never the exact original key.
                // An exact-match check (`t2.idempotency_key = o.idempotency_key`) can NEVER
                // see that as resolving the original order, no matter how long it waits — the
                // keys are related but literally different strings. Switched to a prefix
                // match so a resolving child key is correctly recognized. Also added the
                // symbol+user cross-check and live holdings check already used by
                // stopLossFailures just above, as defense-in-depth for the case a resolution
                // arrives under a completely unrelated key shape.
                query(`
                    SELECT COUNT(*) AS cnt FROM (
                        SELECT DISTINCT idempotency_key FROM order_audit_log o
                        WHERE state IN ('SUBMITTED','PENDING_FILL','PARTIALLY_FILLED')
                          AND ($1::text IS NULL OR user_id = $1)
                          AND created_at < NOW() - INTERVAL '24 hours'
                          AND idempotency_key NOT IN (
                              SELECT idempotency_key FROM sentinel_order_acknowledgements
                          )
                          AND NOT EXISTS (
                              SELECT 1 FROM order_audit_log t2
                              WHERE t2.idempotency_key LIKE o.idempotency_key || '%'
                                AND t2.state IN ('FILLED','CANCELED','REJECTED','STOPPED','CLOSED','CLOSED_MANUAL')
                          )
                          AND NOT EXISTS (
                              SELECT 1 FROM order_audit_log t
                              WHERE t.symbol = o.symbol
                                AND t.user_id = o.user_id
                                AND t.state IN ('STOPPED','CLOSED','CLOSED_MANUAL')
                                AND t.created_at > o.created_at
                                AND NOT EXISTS (
                                    SELECT 1 FROM order_audit_log b
                                    WHERE b.symbol = o.symbol
                                      AND b.user_id = o.user_id
                                      AND b.state = 'FILLED'
                                      AND b.created_at > o.created_at
                                      AND b.created_at < t.created_at
                                )
                          )
                          AND NOT EXISTS (
                              SELECT 1 FROM holdings h
                              WHERE h.symbol = o.symbol
                                AND ($1::text IS NULL OR h.user_id = $1)
                                AND h.quantity > 0
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

/**
 * Acknowledge all current SENTINEL blockers for a user.
 * Marks position_reconciliation_log ERROR entries as acknowledged and inserts
 * sentinel_order_acknowledgements rows for duplicate/storm order keys.
 * This is the operational procedure after confirming incidents were caused by
 * a known bug that is now fixed — it does not delete any audit records.
 *
 * @param {string} userId
 * @param {string} reason   — human-readable reason (e.g. "brokerService crash fixed 2026-06-04")
 */
async function acknowledgeBlockers(userId, reason = 'Acknowledged by operator') {
    const nowTs = 'NOW()';

    // 1. Acknowledge all recon ERROR entries for this user
    const reconResult = await query(`
        UPDATE position_reconciliation_log
        SET acknowledged        = TRUE,
            acknowledged_at     = NOW(),
            acknowledged_reason = $2
        WHERE user_id = $1
          AND action  = 'ERROR'
          AND acknowledged IS NOT TRUE
    `, [userId, reason]);

    // 2. Gather all duplicate idempotency keys (submitted > once, globally — matches SENTINEL scope)
    const dupeKeys = await query(`
        SELECT DISTINCT idempotency_key FROM order_audit_log
        WHERE state = 'SUBMITTED'
          AND idempotency_key NOT IN (
              SELECT idempotency_key FROM sentinel_order_acknowledgements
          )
        GROUP BY idempotency_key HAVING COUNT(*) > 1
    `);

    // 3. Gather all storm keys (> 5 submitted on same symbol/day, globally)
    const stormKeys = await query(`
        SELECT DISTINCT idempotency_key FROM order_audit_log
        WHERE state = 'SUBMITTED'
          AND idempotency_key NOT IN (
              SELECT idempotency_key FROM sentinel_order_acknowledgements
          )
          AND (symbol, created_at::date) IN (
              SELECT symbol, created_at::date FROM order_audit_log
              WHERE state = 'SUBMITTED'
              GROUP BY symbol, created_at::date HAVING COUNT(*) > 5
          )
    `);

    // 4. Gather stuck-open orders > 24h (globally)
    const stuckKeys = await query(`
        SELECT DISTINCT idempotency_key FROM order_audit_log
        WHERE state IN ('SUBMITTED','PENDING_FILL','PARTIALLY_FILLED')
          AND created_at  < NOW() - INTERVAL '24 hours'
          AND idempotency_key NOT IN (
              SELECT idempotency_key FROM sentinel_order_acknowledgements
          )
          AND NOT EXISTS (
              SELECT 1 FROM order_audit_log t2
              WHERE t2.idempotency_key = order_audit_log.idempotency_key
                AND t2.state IN ('FILLED','CANCELED','REJECTED','STOPPED','CLOSED')
          )
    `);

    // 5. Gather stop-loss failures: OPEN_WITH_STOP with no terminal state, position no longer held
    // (mirrors the symbol+user fallback match in checkLiveReadiness — see comment there)
    const stopFailKeys = await query(`
        SELECT DISTINCT o.idempotency_key FROM order_audit_log o
        WHERE o.state = 'OPEN_WITH_STOP'
          AND ($1::text IS NULL OR o.user_id = $1)
          AND o.created_at >= NOW() - INTERVAL '${Math.max(1, BLOCKER_DAYS)} days'
          AND o.created_at < NOW() - INTERVAL '1 day'
          AND o.idempotency_key NOT IN (
              SELECT idempotency_key FROM sentinel_order_acknowledgements
          )
          AND NOT EXISTS (
              SELECT 1 FROM order_audit_log t
              WHERE t.idempotency_key = o.idempotency_key
                AND t.state IN ('STOPPED','CLOSED','CLOSED_MANUAL','CANCELED','REJECTED')
          )
          AND NOT EXISTS (
              SELECT 1 FROM order_audit_log t
              WHERE t.symbol = o.symbol
                AND t.user_id = o.user_id
                AND t.state IN ('STOPPED','CLOSED','CLOSED_MANUAL')
                AND t.created_at > o.created_at
                AND NOT EXISTS (
                    SELECT 1 FROM order_audit_log b
                    WHERE b.symbol = o.symbol
                      AND b.user_id = o.user_id
                      AND b.state = 'FILLED'
                      AND b.created_at > o.created_at
                      AND b.created_at < t.created_at
                )
          )
          AND NOT EXISTS (
              SELECT 1 FROM holdings h
              WHERE h.symbol = o.symbol
                AND ($1::text IS NULL OR h.user_id = $1)
                AND h.quantity > 0
          )
    `, [userId]);

    const allOrderKeys = [
        ...dupeKeys.rows.map(r => r.idempotency_key),
        ...stormKeys.rows.map(r => r.idempotency_key),
        ...stuckKeys.rows.map(r => r.idempotency_key),
        ...stopFailKeys.rows.map(r => r.idempotency_key),
    ];
    const uniqueKeys = [...new Set(allOrderKeys)];

    let orderAcknowledged = 0;
    for (const key of uniqueKeys) {
        try {
            await query(`
                INSERT INTO sentinel_order_acknowledgements
                    (idempotency_key, acknowledged_at, acknowledged_by, reason)
                VALUES ($1, NOW(), $2, $3)
                ON CONFLICT (idempotency_key) DO NOTHING
            `, [key, userId, reason]);
            orderAcknowledged++;
        } catch (_) {}
    }

    logger.info('[SENTINEL] Blockers acknowledged', {
        userId, reason,
        reconErrorsAcknowledged:  reconResult.rowCount,
        orderKeysAcknowledged:    orderAcknowledged,
        stopFailuresAcknowledged: stopFailKeys.rows.length,
    });

    return {
        reconErrorsAcknowledged:  reconResult.rowCount,
        orderKeysAcknowledged:    orderAcknowledged,
        stopFailuresAcknowledged: stopFailKeys.rows.length,
    };
}

module.exports = { checkLiveReadiness, acknowledgeBlockers };
