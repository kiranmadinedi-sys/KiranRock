/**
 * Position Reconciliation Service (PANTHEON: ATLAS)
 *
 * Compares KiranRock DB holdings against Alpaca's position list.
 * Alpaca is the source of truth for what is actually held.
 *
 * Three discrepancy classes:
 *   PHANTOM  — DB says we hold shares, Alpaca has 0 / no position
 *   DRIFT    — Both sides show a position but quantities differ
 *   SHADOW   — Alpaca holds shares that are not recorded in DB
 *
 * Every action is written to position_reconciliation_log so you have an
 * immutable audit trail to diagnose recurring drift, bugs, and patterns.
 *
 * If auto-fix fails for any row, `result.ok` is set false and the caller
 * should halt trading until the issue is resolved manually.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { logger } = require('../utils/logger');
const { query }  = require('../config/database');
const tradeIntelligenceService = require('./tradeIntelligenceService');

// ─── Alpaca positions fetch ───────────────────────────────────────────────────

async function _fetchAlpacaPositions(userId) {
    const axios   = require('axios');
    // Use per-user credentials so each user's live/paper account is checked correctly.
    // Falls back to .env if the user has no personal keys stored.
    const userDb  = require('./userDatabaseService');
    const creds   = userId ? await userDb.getUserAlpacaCredentials(userId) : null;
    const isPaper = creds ? creds.isPaper : (process.env.ALPACA_PAPER || 'true').toLowerCase() !== 'false';
    const keyId     = (creds && creds.keyId)     || process.env.ALPACA_KEY_ID     || '';
    const secretKey = (creds && creds.secretKey) || process.env.ALPACA_SECRET_KEY || '';
    const base    = isPaper
        ? 'https://paper-api.alpaca.markets/v2'
        : 'https://api.alpaca.markets/v2';
    if (!keyId || !secretKey) throw new Error('ALPACA_KEY_ID / ALPACA_SECRET_KEY not set');
    const resp = await axios.get(`${base}/positions`, {
        headers: {
            'APCA-API-KEY-ID':     keyId,
            'APCA-API-SECRET-KEY': secretKey,
            'Content-Type':        'application/json'
        },
        timeout: 10000
    });
    return resp.data || [];
}

// ─── Audit log helper ─────────────────────────────────────────────────────────

async function _auditLog(userId, discrepancy, symbol, dbQty, brokerQty, action, details, trigger) {
    try {
        await query(
            `INSERT INTO position_reconciliation_log
             (user_id, discrepancy, symbol, db_qty, broker_qty, action, details, trigger)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [String(userId), discrepancy, symbol, dbQty ?? null, brokerQty ?? null, action, details || null, trigger]
        );
    } catch (err) {
        logger.warn('[Reconcile] audit_log write failed', { userId, symbol, err: err.message });
    }
}

// ─── Core reconciliation logic ────────────────────────────────────────────────

/**
 * Reconcile DB holdings for one user against Alpaca.
 *
 * @param {string|number} userId
 * @param {{ trigger?: 'SCHEDULED' | 'STARTUP' | 'MANUAL' }} opts
 * @returns {Promise<{
 *   ok:       boolean,   // false means an auto-fix failed — halt trading
 *   phantoms: string[],
 *   drifts:   Array<{symbol,dbQty,alpacaQty}>,
 *   shadows:  string[],
 *   fixes:    string[],
 *   errors:   string[]  // unfixable problems
 * }>}
 */
async function reconcilePositions(userId, { trigger = 'SCHEDULED' } = {}) {
    const result = {
        ok:           true,
        networkError: false,  // true = transient network failure, don't halt trading
        phantoms:     [],
        drifts:       [],
        shadows:      [],
        fixes:        [],
        errors:       []
    };

    // Skip when using the simulated broker — no Alpaca to compare against.
    const broker = (process.env.BROKER || 'simulated').toLowerCase();
    if (broker !== 'alpaca') {
        logger.info('[Reconcile] BROKER != alpaca — skipping (simulated mode)');
        return result;
    }

    // ── Step 1: load DB holdings ─────────────────────────────────────────────
    let dbRows;
    try {
        const res = await query(
            `SELECT symbol, quantity, average_price, current_price, sector FROM holdings WHERE user_id = $1 AND quantity > 0`,
            [userId]
        );
        dbRows = res.rows;
    } catch (err) {
        logger.error('[Reconcile] Failed to load DB holdings', { userId, err: err.message });
        result.ok = false;
        result.errors.push(`DB read failed: ${err.message}`);
        return result;
    }

    // ── Step 2: load Alpaca positions ────────────────────────────────────────
    let alpacaPositions;
    try {
        alpacaPositions = await _fetchAlpacaPositions(userId);
    } catch (err) {
        // Distinguish transient network errors (DNS, timeout, 5xx) from real failures.
        // Network errors are self-healing — don't halt trading; just skip this run.
        const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' ||
                             err.code === 'ETIMEDOUT'  || err.code === 'ECONNRESET'  ||
                             (err.response?.status >= 500);
        if (isNetworkErr) {
            logger.warn('[Reconcile] Alpaca unreachable (transient) — skipping reconciliation run', {
                userId, err: err.message, code: err.code
            });
            result.networkError = true;
            return result;   // ok=true, networkError=true — caller must NOT halt trading
        }
        logger.error('[Reconcile] Failed to fetch Alpaca positions', { userId, err: err.message });
        result.ok = false;
        result.errors.push(`Alpaca fetch failed: ${err.message}`);
        return result;
    }

    // Build lookup maps (symbol → quantity, normalised to uppercase).
    // Use parseFloat so fractional share positions (e.g. 0.269 ASML) are preserved.
    // Skip short positions (negative qty) — the bot is long-only; shorts are manual/external.
    const dbMap     = new Map(dbRows.map(r => [r.symbol.toUpperCase(), parseFloat(r.quantity)]));
    const alpacaMap = new Map(
        alpacaPositions
            .filter(p => parseFloat(p.qty) > 0.0001)   // exclude shorts and dust (< 0.0001 shares)
            .map(p => [p.symbol.toUpperCase(), parseFloat(p.qty)])
    );

    // ── Step 3: detect discrepancies ─────────────────────────────────────────

    for (const [symbol, dbQty] of dbMap) {
        const alpacaQty = alpacaMap.get(symbol);
        if (alpacaQty === undefined || alpacaQty < 0.0001) {
            // Alpaca has no meaningful position — DB record is phantom
            result.phantoms.push(symbol);
            logger.warn('[Reconcile] PHANTOM detected', { userId, symbol, dbQty });
        } else {
            // Allow up to 0.5% drift before flagging (covers rounding in fractional fills)
            const pctDiff = Math.abs(alpacaQty - dbQty) / Math.max(alpacaQty, 0.0001);
            if (pctDiff > 0.005 && Math.abs(alpacaQty - dbQty) > 0.0001) {
                result.drifts.push({ symbol, dbQty, alpacaQty });
                logger.warn('[Reconcile] DRIFT detected', { userId, symbol, dbQty, alpacaQty });
            }
        }
    }

    for (const [symbol, alpacaQty] of alpacaMap) {
        if (!dbMap.has(symbol)) {
            result.shadows.push(symbol);
            logger.warn('[Reconcile] SHADOW detected', { userId, symbol, alpacaQty });
        }
    }

    // ── Step 4: auto-fix + write immutable audit row ──────────────────────────

    for (const symbol of result.phantoms) {
        const dbQty    = dbMap.get(symbol);
        const dbRow    = dbRows.find(r => r.symbol.toUpperCase() === symbol) || {};
        const entryPrice = parseFloat(dbRow.average_price || 0);

        // Guard against double-booking: if the app's OWN sell logic (quality-score decay,
        // trailing stop, etc.) already closed this exact position and logged its own SELL —
        // but for whatever reason left the `holdings` row behind — this loop would otherwise
        // see the same stale row as a fresh "phantom" and log a SECOND SELL for it, double-
        // counting the realized loss/gain. Found 2026-08-31: AVGO sold once for real at 13:34
        // (bot's own quality-decay exit, -$39.48), reconciler ran 18 min later, found the
        // still-present holdings row, and logged its own "reconciled" close for the same 6
        // shares (-$40.86) — same class of bug as the CEVA/ALGM double-count from 2026-08-15.
        // A recent same-symbol/same-qty SELL means this is a stale-row artifact, not a real
        // second exit — clean up the row but skip writing a duplicate trade record.
        const recentSell = await query(
            `SELECT id FROM trades
             WHERE user_id = $1 AND UPPER(symbol) = $2 AND action = 'SELL'
               AND ABS(quantity - $3) < 0.0001
               AND trade_date > NOW() - INTERVAL '2 hours'
             ORDER BY trade_date DESC LIMIT 1`,
            [userId, symbol, dbQty]
        );
        if (recentSell.rows.length > 0) {
            await query(`DELETE FROM holdings WHERE user_id = $1 AND UPPER(symbol) = $2`, [userId, symbol]);
            logger.warn('[Reconcile] Phantom matches a recent SELL already on record — cleaning up stale holdings row without double-logging', {
                userId, symbol, dbQty, matchingTradeId: recentSell.rows[0].id
            });
            continue;
        }

        // Prefer actual Alpaca FILL activity price for this symbol (most accurate).
        // Fall back to current_price, then stored stop price (least accurate — stop orders
        // may have been trailed up significantly since the original bracket was placed).
        let exitPrice = parseFloat(dbRow.current_price || 0);
        let priceSource = 'current_price';
        let exitOrderId = null;
        let axiosBase = null, axiosHeaders = null;
        try {
            const userDb = require('./userDatabaseService');
            const creds  = await userDb.getUserAlpacaCredentials(userId);
            const axiosLib = require('axios');
            const base = (creds?.isPaper !== false) ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
            const headers = {
                'APCA-API-KEY-ID':     creds?.keyId || process.env.ALPACA_KEY_ID,
                'APCA-API-SECRET-KEY': creds?.secretKey || process.env.ALPACA_SECRET_KEY
            };
            axiosBase = base; axiosHeaders = headers;
            // Look for the most recent sell FILL for this symbol since the DB entry was created
            const since = dbRow.purchase_date || dbRow.created_at;
            const actRes = await axiosLib.get(`${base}/v2/account/activities`, {
                headers,
                params: { activity_type: 'FILL', after: since ? new Date(since).toISOString() : undefined },
                timeout: 8000
            });
            const fills = (actRes.data || []).filter(
                a => a.symbol === symbol && (a.side === 'sell' || a.side === 'sell_short') && parseFloat(a.price) > 0
            ).sort((a, b) => new Date(b.transaction_time) - new Date(a.transaction_time));
            if (fills.length > 0) {
                exitPrice   = parseFloat(fills[0].price);
                priceSource = `alpaca_fill@${fills[0].transaction_time?.slice(0,10)}`;
                exitOrderId = fills[0].order_id || null;
            }
        } catch (_) {
            // If Alpaca activities call fails, fall through to stored stop price
            try {
                const stopRow = await query(
                    `SELECT metadata FROM order_audit_log
                     WHERE user_id = $1 AND UPPER(symbol) = $2 AND state = 'OPEN_WITH_STOP'
                     ORDER BY created_at DESC LIMIT 1`,
                    [userId, symbol]
                );
                const sp = parseFloat(stopRow.rows[0]?.metadata?.stopPrice || 0);
                if (sp > 0) { exitPrice = sp; priceSource = 'stop_order_estimate'; }
            } catch (_2) {}
        }

        // Classify what actually closed the position (stop / trailing stop / target /
        // partial) instead of lumping every reconciler-caught exit into one generic
        // bucket — the reconciler already has the fill's order_id, one more lookup gets
        // the order's real type. Falls back to the generic label if anything's missing
        // so this can never break the exit-logging path (found via ChatGPT review + our
        // own follow-up, 2026-07-11: "reconciler_detected" was 75% of all closed trades
        // and told analytics nothing about WHY the position closed).
        //
        // order.type alone isn't trustworthy for 'limit': this codebase places stop-loss
        // and take-profit as two SEPARATE standalone GTC orders per position (buyMarket,
        // ~line 504-519), not a linked Alpaca bracket/OCO pair — so a 'limit' order can
        // fill at a LOSS too (e.g. a repriced/defensive exit), and a real take-profit
        // should only be labeled as such if the fill actually beat entry price. This also
        // explains the recurring orphaned-stop-order bug from earlier this week (EXC/CL):
        // with no OCO link, the sibling order doesn't auto-cancel when one leg fills.
        let exitReasonTag = 'reconciler_detected';
        if (exitOrderId && axiosBase) {
            try {
                const axiosLib = require('axios');
                const orderRes = await axiosLib.get(`${axiosBase}/v2/orders/${exitOrderId}`, { headers: axiosHeaders, timeout: 8000 });
                const order = orderRes.data || {};
                const filledQty = parseFloat(order.filled_qty || order.qty || 0);
                const isPartial = filledQty > 0 && dbQty > 0 && filledQty < dbQty * 0.99;
                const beatEntry = entryPrice > 0 && exitPrice > entryPrice;
                if (order.type === 'trailing_stop') {
                    exitReasonTag = 'trailing_stop_reconciled';
                } else if (order.type === 'stop' || order.type === 'stop_limit') {
                    exitReasonTag = 'stop_loss_reconciled';
                } else if (order.type === 'limit') {
                    exitReasonTag = beatEntry ? (isPartial ? 'partial_profit_reconciled' : 'take_profit_reconciled') : 'protective_limit_reconciled';
                } else if (order.type === 'market') {
                    exitReasonTag = 'market_exit_reconciled';
                }
            } catch (orderErr) {
                logger.debug('[Reconcile] Could not classify exit order type — using generic tag', { userId, symbol, exitOrderId, error: orderErr.message });
            }
        }

        try {
            // 1. Delete the phantom holding (Alpaca is source of truth)
            await query(
                `DELETE FROM holdings WHERE user_id = $1 AND UPPER(symbol) = $2`,
                [userId, symbol]
            );

            // 2. Write a SELL to the trades table so transaction history stays complete.
            //    Marks the exit as reconciler-detected so analysts know the price is estimated.
            //    Also propagates ai_score from the matching BUY record so analytics can group by score.
            if (entryPrice > 0 && dbQty > 0) {
                const fillPrice = exitPrice > 0 ? exitPrice : entryPrice;
                const total     = parseFloat((fillPrice * dbQty).toFixed(4));
                const pnl       = parseFloat(((fillPrice - entryPrice) * dbQty).toFixed(4));
                const pnlPct    = parseFloat(((fillPrice - entryPrice) / entryPrice * 100).toFixed(4));

                // Look up ai_score, sector, entry_regime, and buy date from the most recent BUY
                let entryScore = null, entrySector = null, entryRegime = null, holdHours = null;
                try {
                    const buyRow = await query(
                        `SELECT ai_score, sector, entry_regime, trade_date FROM trades
                         WHERE user_id=$1 AND symbol=$2 AND action='BUY'
                         ORDER BY trade_date DESC LIMIT 1`,
                        [userId, symbol]
                    );
                    if (buyRow.rows[0]) {
                        entryScore   = buyRow.rows[0].ai_score;
                        entrySector  = buyRow.rows[0].sector;
                        entryRegime  = buyRow.rows[0].entry_regime;
                        if (buyRow.rows[0].trade_date) {
                            holdHours = parseFloat(
                                ((Date.now() - new Date(buyRow.rows[0].trade_date).getTime()) / 3600000).toFixed(2)
                            );
                        }
                    }
                } catch (_) {}

                await query(
                    `INSERT INTO trades
                         (user_id, symbol, action, quantity, price, total, trade_date,
                          executed_by, notes, pnl, pnl_percent, status,
                          ai_score, sector, entry_regime, hold_hours)
                     VALUES ($1, $2, 'SELL', $3, $4, $5, NOW(),
                             'reconciler', $8, $6, $7, 'CLOSED', $9, $10, $11, $12)`,
                    [userId, symbol, dbQty, fillPrice, total, pnl, pnlPct,
                     `Alpaca stop/exit detected by position reconciler — price source: ${priceSource}, exit type: ${exitReasonTag}`,
                     entryScore, entrySector, entryRegime, holdHours]
                );

                // Also close the matching trade_decision_journal row so this exit shows up in
                // trade_attribution — the view/analytics (win-rate-by-score-bucket, exit-reason
                // breakdown, score calibration) all read from that journal, not from `trades`.
                // Reconciler-detected exits (a stop/target firing between position snapshots)
                // were writing to `trades` only, so every stop-triggered exit was invisible to
                // that analysis — found investigating this week's zero trade_attribution rows
                // despite 6 real exits (2026-07-11). exitReasonTag (above) distinguishes the
                // real mechanism (stop/trailing-stop/target/partial) instead of one generic
                // "reconciler_detected" bucket that told analytics nothing about why the
                // position closed (raised in the same follow-up review).
                try {
                    const _outcome = pnlPct > 0.5 ? 'win' : pnlPct < -0.5 ? 'loss' : 'breakeven';
                    await tradeIntelligenceService.closeLatestOpenExecution(userId, {
                        botType: 'stock', symbol, exitPrice: fillPrice, pnl, pnlPercent: pnlPct,
                        outcome: _outcome,
                        metadata: {
                            reason: `Reconciler-detected exit (${exitReasonTag}) — fill found on Alpaca, DB still showed position open`,
                            exitReason: exitReasonTag,
                            winLossReason: _outcome === 'win' ? `${exitReasonTag}_gain` : _outcome === 'loss' ? `${exitReasonTag}_loss` : `${exitReasonTag}_flat`,
                            priceSource
                        }
                    });
                } catch (journalErr) {
                    logger.debug('[Reconcile] Failed to close trade_decision_journal entry for reconciler exit', { userId, symbol, error: journalErr.message });
                }
            }

            // 3. Close any open stop-order entries in order_audit_log so SENTINEL stays clean.
            await query(
                `INSERT INTO order_audit_log
                     (idempotency_key, symbol, state, user_id, metadata, created_at)
                 SELECT idempotency_key, symbol, 'CLOSED', user_id,
                        jsonb_build_object(
                            'reason',    'Alpaca stop-fill — reconciler-detected',
                            'exitPrice', $3::text
                        ),
                        NOW()
                 FROM order_audit_log
                 WHERE user_id = $1 AND UPPER(symbol) = $2 AND state = 'OPEN_WITH_STOP'
                   AND NOT EXISTS (
                       SELECT 1 FROM order_audit_log t2
                       WHERE t2.idempotency_key = order_audit_log.idempotency_key
                         AND t2.state IN ('STOPPED','CLOSED','CLOSED_MANUAL','CANCELED','REJECTED')
                   )`,
                [userId, symbol, exitPrice?.toFixed(2) || '0']
            );

            await _auditLog(userId, 'PHANTOM', symbol, dbQty, 0, 'DELETED',
                `DB held ${dbQty} shares; Alpaca: none. SELL recorded @ ~$${exitPrice.toFixed(2)}`, trigger);
            result.fixes.push(`PHANTOM fixed: deleted ${symbol} (DB had ${dbQty}, sell logged @ ~$${exitPrice.toFixed(2)})`);
            logger.info('[Reconcile] Fixed PHANTOM — deleted holding, logged SELL', { userId, symbol, dbQty, exitPrice });
        } catch (err) {
            await _auditLog(userId, 'PHANTOM', symbol, dbQty, 0, 'ERROR', err.message, trigger);
            result.errors.push(`Failed to delete phantom ${symbol}: ${err.message}`);
            result.ok = false;
            logger.error('[Reconcile] Failed to fix PHANTOM', { userId, symbol, err: err.message });
        }
    }

    for (const { symbol, dbQty, alpacaQty } of result.drifts) {
        try {
            await query(
                `UPDATE holdings SET quantity = $1, updated_at = NOW()
                 WHERE user_id = $2 AND UPPER(symbol) = $3`,
                [alpacaQty, userId, symbol]
            );
            await _auditLog(userId, 'DRIFT', symbol, dbQty, alpacaQty, 'UPDATED',
                `DB qty ${dbQty} corrected to Alpaca qty ${alpacaQty}`, trigger);
            result.fixes.push(`DRIFT fixed: ${symbol} DB=${dbQty} → ${alpacaQty}`);
            logger.info('[Reconcile] Fixed DRIFT — updated DB qty', { userId, symbol, dbQty, alpacaQty });
        } catch (err) {
            await _auditLog(userId, 'DRIFT', symbol, dbQty, alpacaQty, 'ERROR', err.message, trigger);
            result.errors.push(`Failed to fix drift ${symbol}: ${err.message}`);
            result.ok = false;
            logger.error('[Reconcile] Failed to fix DRIFT', { userId, symbol, err: err.message });
        }
    }

    for (const symbol of result.shadows) {
        const alpacaQty = alpacaMap.get(symbol);
        const alpacaPos = alpacaPositions.find(p => p.symbol.toUpperCase() === symbol);
        const avgPrice  = parseFloat(alpacaPos?.avg_entry_price || 0) ||
                          (alpacaPos?.cost_basis ? parseFloat(alpacaPos.cost_basis) / alpacaQty : 0);
        // Alpaca's position object already carries a live price — use it so a
        // restored row isn't left showing null/stale current_price until the
        // next regular-hours refresh tick picks it up.
        const currentPrice  = parseFloat(alpacaPos?.current_price || 0) || avgPrice;
        const marketValue   = parseFloat(alpacaPos?.market_value || 0) || (currentPrice * alpacaQty);
        const gainLoss       = parseFloat(alpacaPos?.unrealized_pl || 0) || (marketValue - (avgPrice * alpacaQty));
        const gainLossPct    = alpacaPos?.unrealized_plpc != null
            ? parseFloat(alpacaPos.unrealized_plpc) * 100
            : (avgPrice > 0 ? (gainLoss / (avgPrice * alpacaQty)) * 100 : 0);
        try {
            await query(
                `INSERT INTO holdings (user_id, symbol, quantity, average_price, current_price, market_value, gain_loss, gain_loss_percent, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
                 ON CONFLICT (user_id, symbol)
                 DO UPDATE SET quantity = $3, average_price = $4, current_price = $5, market_value = $6, gain_loss = $7, gain_loss_percent = $8, updated_at = NOW()`,
                [userId, symbol, alpacaQty, avgPrice, currentPrice, marketValue, gainLoss, gainLossPct]
            );
            await _auditLog(userId, 'SHADOW', symbol, 0, alpacaQty, 'INSERTED',
                `Alpaca held ${alpacaQty} × ${symbol} @ $${avgPrice.toFixed(2)}; not in DB`, trigger);
            result.fixes.push(`SHADOW fixed: inserted ${symbol} × ${alpacaQty} @ $${avgPrice.toFixed(2)}`);
            logger.info('[Reconcile] Fixed SHADOW — inserted DB holding', { userId, symbol, alpacaQty, avgPrice });
        } catch (err) {
            await _auditLog(userId, 'SHADOW', symbol, 0, alpacaQty, 'ERROR', err.message, trigger);
            result.errors.push(`Failed to insert shadow ${symbol}: ${err.message}`);
            result.ok = false;
            logger.error('[Reconcile] Failed to fix SHADOW', { userId, symbol, err: err.message });
        }
    }

    const totalIssues = result.phantoms.length + result.drifts.length + result.shadows.length;
    if (totalIssues === 0) {
        logger.info('[Reconcile] Clean — no discrepancies', { userId, positions: dbMap.size, trigger });
    } else {
        logger.warn(`[Reconcile] ${totalIssues} discrepancy(s) | ${result.errors.length} error(s)`, {
            userId, trigger,
            phantoms: result.phantoms,
            drifts:   result.drifts.map(d => `${d.symbol}:${d.dbQty}→${d.alpacaQty}`),
            shadows:  result.shadows,
            errors:   result.errors
        });
    }

    return result;
}

/**
 * Run reconciliation for all active AI trading users, write the audit log,
 * send Telegram alerts for discrepancies, and set Redis HALT_ALL if any
 * auto-fix fails (bot should not trade with uncertain position state).
 *
 * @param {Array<{id:string|number, username:string}>} activeUsers
 * @param {{ trigger?: string }} opts
 */
async function runMorningReconciliation(activeUsers, { trigger = 'SCHEDULED' } = {}) {
    logger.info('[Reconcile] Starting reconciliation', { users: activeUsers.length, trigger });

    const alertService = require('./telegramAlertService');
    let totalIssues    = 0;
    let totalErrors    = 0;

    for (const user of activeUsers) {
        try {
            const r       = await reconcilePositions(user.id, { trigger });
            const issues  = r.phantoms.length + r.drifts.length + r.shadows.length;
            totalIssues  += issues;
            totalErrors  += r.errors.length;

            if (issues > 0 || r.errors.length > 0) {
                const date  = new Date().toISOString().slice(0, 10);
                const lines = [
                    `⚖️ *Position Reconciliation — ${date}* _(${trigger})_`,
                    `${issues} discrepancy(s) | ${r.errors.length} error(s) | user: ${user.username}`,
                    ''
                ];
                if (r.phantoms.length)
                    lines.push(`🗑️ *Phantom* (DB only → deleted): ${r.phantoms.join(', ')}`);
                if (r.drifts.length)
                    lines.push(`📐 *Drift* (qty corrected): ${r.drifts.map(d => `${d.symbol} ${d.dbQty}→${d.alpacaQty}`).join(', ')}`);
                if (r.shadows.length)
                    lines.push(`👻 *Shadow* (Alpaca only → inserted): ${r.shadows.join(', ')}`);
                if (r.errors.length) {
                    lines.push('');
                    lines.push(`❌ *Auto-fix FAILED* — trading halted until resolved:`);
                    r.errors.forEach(e => lines.push(`  • ${e}`));
                }
                lines.push('');
                lines.push(r.ok
                    ? '_All discrepancies corrected. Alpaca is source of truth._'
                    : '_⛔ Fix errors manually then clear Redis HALT\\_ALL to resume._'
                );

                try { await alertService.sendMessage(user.id, lines.join('\n')); } catch (_) {}
            }

            // If auto-fix of a real mismatch failed, halt trading until resolved manually.
            // Network errors (r.networkError=true) are transient — never halt for those.
            if (!r.ok && !r.networkError) {
                try {
                    const redisState = require('./redisStateService');
                    const reason = `RECON_FAILURE: position reconciliation errors for user ${user.id} — ${r.errors.join('; ')}`;
                    await redisState.setHaltAll(reason);
                    logger.error('[Reconcile] HALT_ALL set — reconciliation errors, trading suspended', {
                        userId: user.id, errors: r.errors
                    });
                } catch (redisErr) {
                    logger.warn('[Reconcile] Could not set Redis HALT_ALL', { err: redisErr.message });
                }
            }
        } catch (err) {
            logger.error('[Reconcile] Unexpected error for user', { userId: user.id, err: err.message });
            totalErrors++;
        }
    }

    logger.info('[Reconcile] Done', { trigger, totalIssues, totalErrors });
    return { totalIssues, totalErrors };
}

module.exports = {
    reconcilePositions,
    runMorningReconciliation
};
