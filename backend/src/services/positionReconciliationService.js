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
        ok:       true,
        phantoms: [],
        drifts:   [],
        shadows:  [],
        fixes:    [],
        errors:   []
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
            `SELECT symbol, quantity FROM holdings WHERE user_id = $1 AND quantity > 0`,
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
        logger.error('[Reconcile] Failed to fetch Alpaca positions', { userId, err: err.message });
        result.ok = false;
        result.errors.push(`Alpaca fetch failed: ${err.message}`);
        return result;
    }

    // Build lookup maps (symbol → quantity, normalised to uppercase)
    const dbMap     = new Map(dbRows.map(r => [r.symbol.toUpperCase(), parseInt(r.quantity)]));
    const alpacaMap = new Map(
        alpacaPositions.map(p => [p.symbol.toUpperCase(), parseInt(p.qty)])
    );

    // ── Step 3: detect discrepancies ─────────────────────────────────────────

    for (const [symbol, dbQty] of dbMap) {
        const alpacaQty = alpacaMap.get(symbol);
        if (alpacaQty === undefined || alpacaQty === 0) {
            result.phantoms.push(symbol);
            logger.warn('[Reconcile] PHANTOM detected', { userId, symbol, dbQty });
        } else if (alpacaQty !== dbQty) {
            result.drifts.push({ symbol, dbQty, alpacaQty });
            logger.warn('[Reconcile] DRIFT detected', { userId, symbol, dbQty, alpacaQty });
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
        const dbQty = dbMap.get(symbol);
        try {
            await query(
                `DELETE FROM holdings WHERE user_id = $1 AND UPPER(symbol) = $2`,
                [userId, symbol]
            );
            await _auditLog(userId, 'PHANTOM', symbol, dbQty, 0, 'DELETED',
                `DB held ${dbQty} shares; Alpaca: none`, trigger);
            result.fixes.push(`PHANTOM fixed: deleted ${symbol} (DB had ${dbQty})`);
            logger.info('[Reconcile] Fixed PHANTOM — deleted DB holding', { userId, symbol, dbQty });
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
        try {
            await query(
                `INSERT INTO holdings (user_id, symbol, quantity, average_price, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, NOW(), NOW())
                 ON CONFLICT (user_id, symbol)
                 DO UPDATE SET quantity = $3, average_price = $4, updated_at = NOW()`,
                [userId, symbol, alpacaQty, avgPrice]
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

            // If auto-fix failed, set Redis HALT_ALL so the bot won't trade
            // with an uncertain position picture.
            if (!r.ok) {
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
