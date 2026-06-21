/**
 * System Health Monitor Service
 *
 * Runs inside the worker every 5 minutes during market hours (9:30 AM–4 PM ET).
 * Checks: worker heartbeat, HALT_ALL, SENTINEL, bot cycles, missing stops, reconciliation.
 * Auto-fixes: HALT_ALL, missing stops.
 * Sends Telegram alerts for any issues found or fixed — silent when healthy.
 *
 * Alert deduplication: same issue suppressed for 15 min to avoid Telegram spam.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios     = require('axios');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const CHECK_MS        = 5  * 60 * 1000;   // every 5 min
const ALERT_COOLDOWN  = 15 * 60 * 1000;   // suppress duplicate alerts for 15 min

const KMADINED = 'ca632c53-8798-46f4-be94-29be0fede7f2';

let _interval  = null;
const _alerted = new Map(); // key → last-alerted timestamp

// ─── helpers ──────────────────────────────────────────────────────────────────

function etNow() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function isMarketOpen() {
    const d    = etNow();
    const day  = d.getDay();
    const mins = d.getHours() * 60 + d.getMinutes();
    return day >= 1 && day <= 5 && mins >= 9 * 60 + 30 && mins < 16 * 60;
}

function nowCDT() {
    return new Date().toLocaleString('en-US', {
        timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false
    });
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** Deduplicated Telegram send — same key suppressed for ALERT_COOLDOWN ms. */
async function alert(key, message, userId = KMADINED) {
    const last = _alerted.get(key) || 0;
    if (Date.now() - last < ALERT_COOLDOWN) return; // still in cooldown
    _alerted.set(key, Date.now());
    try {
        const tg = require('./telegramAlertService');
        await tg.sendMessage(userId, message);
    } catch (e) {
        logger.error('[HealthMonitor] Telegram send failed', { error: e.message });
    }
}

/** Clear a key so the next occurrence fires immediately (used after auto-fix). */
function clearCooldown(key) { _alerted.delete(key); }

// ─── Alpaca credentials ───────────────────────────────────────────────────────

async function getAlpacaClient(userId) {
    const res = await query(
        'SELECT alpaca_key_id, alpaca_secret_key, alpaca_paper FROM users WHERE id=$1',
        [userId]
    );
    const row = res.rows[0];
    if (!row) throw new Error(`No user record for ${userId}`);
    const base    = row.alpaca_paper === false
        ? 'https://api.alpaca.markets'
        : 'https://paper-api.alpaca.markets';
    const headers = {
        'APCA-API-KEY-ID':     row.alpaca_key_id,
        'APCA-API-SECRET-KEY': row.alpaca_secret_key
    };
    return { base, headers };
}

// ─── Individual checks ────────────────────────────────────────────────────────

async function checkWorkerHeartbeat() {
    const r = await query(
        `SELECT heartbeat_at FROM worker_runtime_status ORDER BY heartbeat_at DESC LIMIT 1`
    );
    if (!r.rows[0]) return 'CRITICAL: worker_runtime_status is empty — worker never started';
    const age = (Date.now() - new Date(r.rows[0].heartbeat_at)) / 60000;
    if (age > 8) return `CRITICAL: Worker heartbeat is ${age.toFixed(1)} min old — process may be stalled`;
    return null;
}

async function checkAndClearHaltAll() {
    const r      = await query(`SELECT halt_all_reason FROM system_controls WHERE id=1`);
    const reason = r.rows[0]?.halt_all_reason;
    if (!reason) return { issue: null, fixed: null };

    // Auto-fix
    try {
        await query(`UPDATE system_controls SET halt_all_reason=NULL, halt_all_set_at=NULL WHERE id=1`);
        try {
            const redisSvc = require('./redisStateService');
            if (redisSvc?.clearHaltAll) await redisSvc.clearHaltAll();
        } catch (_) { /* Redis optional */ }
        return { issue: null, fixed: `HALT_ALL cleared (was: "${reason}")` };
    } catch (e) {
        return { issue: `CRITICAL: HALT_ALL active — "${reason}" (auto-clear failed: ${e.message})`, fixed: null };
    }
}

async function checkSentinel(userId) {
    try {
        const liveReadiness = require('./liveReadinessService');
        const res = await liveReadiness.checkLiveReadiness(userId);
        if (!res.ready) {
            const blockers = (res.blockers || []).join('; ');
            return `CRITICAL: SENTINEL blocked — ${blockers}`;
        }
        return null;
    } catch (e) {
        return null; // liveReadinessService unavailable is not a critical alert
    }
}

async function checkBotCycles(userId) {
    const r = await query(
        `SELECT success, message FROM ai_trading_logs WHERE user_id=$1 ORDER BY timestamp DESC LIMIT 3`,
        [userId]
    );
    if (r.rows.length >= 3 && r.rows.every(row =>
        !row.success && (row.message || '').toLowerCase().includes('timed out')
    )) {
        return 'WARNING: Last 3 bot cycles timed out — bot may be stuck';
    }
    return null;
}

async function checkAndFixStops(userId) {
    const { base, headers } = await getAlpacaClient(userId);
    const [posRes, ordRes] = await Promise.all([
        axios.get(`${base}/v2/positions`, { headers }),
        axios.get(`${base}/v2/orders`,    { headers, params: { status: 'open', limit: 200 } })
    ]);

    const protectedSyms  = new Set(
        ordRes.data
            .filter(o => o.side === 'sell' && (o.type==='stop'||o.type==='stop_limit'||o.type==='trailing_stop'||o.type==='market'))
            .map(o => o.symbol)
    );
    const positions = posRes.data.filter(p => parseFloat(p.qty) > 0);
    const noStop    = positions.filter(p => !protectedSyms.has(p.symbol));

    if (noStop.length === 0) return { issue: null, fixed: null };

    const placed = [], failed = [];
    for (const pos of noStop) {
        const qty     = parseFloat(pos.qty);
        const entry   = parseFloat(pos.avg_entry_price);
        const current = parseFloat(pos.current_price);
        const plPct   = parseFloat(pos.unrealized_plpc);
        const isFrac  = qty !== Math.floor(qty);
        const tif     = isFrac ? 'day' : 'gtc';

        // Smarter stop level: profitable >3% → protect current gain (5% below current)
        //                     otherwise      → standard 7% below entry
        const stop = plPct > 0.03
            ? parseFloat((current * 0.95).toFixed(2))
            : parseFloat((entry   * 0.93).toFixed(2));

        try {
            // Re-verify position still exists before placing stop (prevents accidental shorts
            // when a position closes between the positions list fetch and order placement).
            let posStillOpen = false;
            try {
                const checkRes = await axios.get(`${base}/v2/positions/${pos.symbol}`, { headers });
                posStillOpen = checkRes.data && parseFloat(checkRes.data.qty) > 0;
            } catch (e404) {
                posStillOpen = false; // 404 = position closed
            }
            if (!posStillOpen) {
                logger.info('[HealthMonitor] Skipping stop placement — position already closed', { symbol: pos.symbol });
                continue;
            }
            const orderRes = await axios.post(`${base}/v2/orders`, {
                symbol: pos.symbol, qty: String(qty), side: 'sell',
                type: 'stop', stop_price: String(stop), time_in_force: tif
            }, { headers });
            // Safety: if Alpaca created a short order (position was flat), cancel immediately
            if (orderRes.data?.position_qty < 0 || orderRes.data?.side === 'sell_short') {
                logger.warn('[HealthMonitor] Cancelling accidental short order', { symbol: pos.symbol, orderId: orderRes.data?.id });
                try { await axios.delete(`${base}/v2/orders/${orderRes.data.id}`, { headers }); } catch (_) {}
                failed.push(`${pos.symbol} (position closed before stop could be placed — order cancelled)`);
            } else {
                const label = plPct > 0.03 ? `5% below current` : `7% below entry`;
                placed.push(`${pos.symbol} @ $${stop} [${tif}] (${label})`);
            }
            await sleep(300);
        } catch (e) {
            failed.push(`${pos.symbol} (${e.response?.data?.message || e.message})`);
        }
    }

    const fixedMsg = placed.length > 0 ? `Stops auto-placed: ${placed.join(', ')}` : null;
    const issueMsg = failed.length > 0 ? `Cannot place stops for: ${failed.join(', ')}` : null;
    return { issue: issueMsg, fixed: fixedMsg };
}

/**
 * Check G — Trailing stop upgrade.
 * For integer-share positions that are >5% in profit and have only a fixed stop,
 * cancel the fixed stop and place a native Alpaca trailing_stop (GTC).
 * For fractionals >5% profit, refresh the DAY stop to 5% below current price.
 */
async function upgradeTrailingStops(userId) {
    const { base, headers } = await getAlpacaClient(userId);
    const [posRes, ordRes] = await Promise.all([
        axios.get(`${base}/v2/positions`, { headers }),
        axios.get(`${base}/v2/orders`,    { headers, params: { status: 'open', limit: 200 } })
    ]);

    // Build maps
    const fixedStopOrders   = {};  // symbol → { id, stopPrice }
    const trailStopSyms     = new Set();
    for (const o of ordRes.data) {
        if (o.side !== 'sell') continue;
        if (o.type === 'trailing_stop') trailStopSyms.add(o.symbol);
        if (o.type === 'stop' || o.type === 'stop_limit') {
            fixedStopOrders[o.symbol] = { id: o.id, stopPrice: parseFloat(o.stop_price) };
        }
    }

    const positions = posRes.data.filter(p => parseFloat(p.qty) > 0);
    const upgraded = [], failed = [];

    for (const pos of positions) {
        const qty     = parseFloat(pos.qty);
        const current = parseFloat(pos.current_price);
        const plPct   = parseFloat(pos.unrealized_plpc);
        const isFrac  = qty !== Math.floor(qty);

        // Only upgrade positions that are >5% profitable and not already trailing
        if (plPct <= 0.05 || trailStopSyms.has(pos.symbol)) continue;

        const existingStop = fixedStopOrders[pos.symbol];

        if (!isFrac) {
            // Integer share: upgrade to native trailing_stop GTC
            const trailPct = plPct > 0.10 ? '3.0' : '5.0'; // tighter trail for big winners
            const newFloor = (current * (1 - parseFloat(trailPct) / 100)).toFixed(2);

            // Only upgrade if the trailing floor is above the current fixed stop (better protection)
            if (existingStop && parseFloat(newFloor) <= existingStop.stopPrice) continue;

            try {
                if (existingStop) {
                    await axios.delete(`${base}/v2/orders/${existingStop.id}`, { headers });
                    await sleep(200);
                }
                await axios.post(`${base}/v2/orders`, {
                    symbol: pos.symbol, qty: String(qty), side: 'sell',
                    type: 'trailing_stop', time_in_force: 'gtc',
                    trail_percent: trailPct
                }, { headers });
                upgraded.push(`${pos.symbol} → GTC trailing ${trailPct}% (floor ~$${newFloor}, +${(plPct*100).toFixed(1)}%)`);
                await sleep(300);
            } catch (e) {
                failed.push(`${pos.symbol}: ${e.response?.data?.message || e.message}`);
            }
        } else {
            // Fractional: refresh DAY stop to 5% below current (tighter than 7%-below-entry)
            const newStop = parseFloat((current * 0.95).toFixed(2));
            if (existingStop && existingStop.stopPrice >= newStop) continue; // already tight enough

            try {
                if (existingStop) {
                    await axios.delete(`${base}/v2/orders/${existingStop.id}`, { headers });
                    await sleep(200);
                }
                await axios.post(`${base}/v2/orders`, {
                    symbol: pos.symbol, qty: String(qty), side: 'sell',
                    type: 'stop', time_in_force: 'day',
                    stop_price: String(newStop)
                }, { headers });
                upgraded.push(`${pos.symbol} → DAY stop $${newStop} (5% below current $${current.toFixed(2)}, +${(plPct*100).toFixed(1)}%)`);
                await sleep(300);
            } catch (e) {
                failed.push(`${pos.symbol}: ${e.response?.data?.message || e.message}`);
            }
        }
    }

    if (upgraded.length === 0 && failed.length === 0) return null;
    const parts = [];
    if (upgraded.length > 0) parts.push(`Trailing stops upgraded: ${upgraded.join(', ')}`);
    if (failed.length > 0)   parts.push(`Failed upgrades: ${failed.join(', ')}`);
    return parts.join(' | ');
}

async function checkAndFixReconciliation(userId) {
    try {
        const reconcile = require('./positionReconciliationService');
        if (!reconcile?.reconcilePositions) return null;
        const res = await reconcile.reconcilePositions(userId, { trigger: 'HEALTH_MONITOR' });
        const phantoms = res?.phantoms?.length || 0;
        const shadows  = res?.shadows?.length  || 0;
        if (phantoms > 0 || shadows > 0) {
            return `Reconciliation fixed ${phantoms} phantom(s) + ${shadows} shadow(s)`;
        }
        return null;
    } catch (_) { return null; }
}

// ─── Main cycle ───────────────────────────────────────────────────────────────

async function runHealthCheck() {
    try {
        const issues = [], fixes = [];

        // A — Worker heartbeat (always)
        const heartbeatIssue = await checkWorkerHeartbeat();
        if (heartbeatIssue) issues.push({ key: 'heartbeat', msg: heartbeatIssue });

        // B — HALT_ALL (always, auto-fix)
        const { issue: haltIssue, fixed: haltFixed } = await checkAndClearHaltAll();
        if (haltFixed) fixes.push(haltFixed);
        if (haltIssue) issues.push({ key: 'halt_all', msg: haltIssue });

        // Market-hours-only checks
        if (isMarketOpen()) {
            // C — SENTINEL
            const sentinelIssue = await checkSentinel(KMADINED);
            if (sentinelIssue) issues.push({ key: 'sentinel', msg: sentinelIssue });

            // D — Bot cycles
            const cycleIssue = await checkBotCycles(KMADINED);
            if (cycleIssue) issues.push({ key: 'bot_cycles', msg: cycleIssue });

            // E — Missing stops (auto-fix, smart level)
            const { issue: stopIssue, fixed: stopFixed } = await checkAndFixStops(KMADINED);
            if (stopFixed) fixes.push(stopFixed);
            if (stopIssue) issues.push({ key: 'stops', msg: stopIssue });

            // F — Reconciliation (auto-fix)
            const reconcileFixed = await checkAndFixReconciliation(KMADINED);
            if (reconcileFixed) fixes.push(reconcileFixed);

            // G — Trailing stop upgrades for profitable positions
            const trailFixed = await upgradeTrailingStops(KMADINED);
            if (trailFixed) fixes.push(trailFixed);
        }

        // ── Send Telegram alerts ──────────────────────────────────────────────
        for (const { key, msg } of issues) {
            await alert(key,
                `🚨 *KiranRock Health Alert* [${nowCDT()} CDT]\n\n${msg}\n\n_System is monitoring — manual review may be needed._`
            );
        }

        if (fixes.length > 0) {
            const fixList = fixes.map(f => `• ${f}`).join('\n');
            await alert(`fixes_${fixes.join('|').slice(0, 60)}`,
                `🔧 *KiranRock Auto-Fix* [${nowCDT()} CDT]\n\nIssues detected and resolved:\n${fixList}`
            );
        }

        if (issues.length === 0 && fixes.length === 0) {
            logger.debug('[HealthMonitor] All checks passed — silent');
        }
    } catch (e) {
        logger.error('[HealthMonitor] Cycle error', { error: e.message });
    }
}

// ─── Start / Stop ─────────────────────────────────────────────────────────────

function startSystemHealthMonitor() {
    if (_interval) return;
    logger.info('[HealthMonitor] Started — checking every 5 min');
    setTimeout(runHealthCheck, 15_000); // first run 15 s after startup
    _interval = setInterval(runHealthCheck, CHECK_MS);
}

function stopSystemHealthMonitor() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
        logger.info('[HealthMonitor] Stopped');
    }
}

module.exports = { startSystemHealthMonitor, stopSystemHealthMonitor };
