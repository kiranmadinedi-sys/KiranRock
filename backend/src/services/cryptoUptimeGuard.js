/**
 * Crypto uptime guard — added 2026-09-20.
 *
 * Crypto trades 24/7 but this app's take-profit exits only run while the crypto process is
 * up, and its downside protection is a resting stop_limit at Alpaca (which a fast gap can
 * skip past). So a stretch of downtime while holding crypto is a real exposure — before
 * going live with real money (planned to run 24/7 then) the operator needs to KNOW when it
 * happened. Two cheap layers:
 *
 *  1. checkStartupGap() — runs when the crypto scheduler starts. If the previous heartbeat
 *     is older than the threshold, every user holding open crypto positions is told how
 *     long the bot was down and what was open. (Covers the whole machine being off — a
 *     dead machine can't alert about itself, so this is necessarily after-the-fact.)
 *  2. runLiveWatchdog() — called from ANOTHER process (the worker) on its own tick. If the
 *     crypto process stops writing its heartbeat while positions are open, alert once per
 *     outage (covers a crashed/hung crypto process while the rest of the platform is up).
 *
 * The heartbeat is its own single-writer file rather than agentHealthService's shared JSON,
 * which is read-modify-write across processes and would lose updates.
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

const HEARTBEAT_FILE = process.env.CRYPTO_HEARTBEAT_FILE || path.join(__dirname, '../../data/crypto_heartbeat.json');
const GAP_ALERT_MIN = parseFloat(process.env.CRYPTO_GAP_ALERT_MIN || '15');       // startup: down longer than this
const STALE_ALERT_MIN = parseFloat(process.env.CRYPTO_STALE_ALERT_MIN || '20');   // live: no heartbeat for this long

function writeHeartbeat(now = new Date()) {
    try {
        fs.mkdirSync(path.dirname(HEARTBEAT_FILE), { recursive: true });
        const tmp = `${HEARTBEAT_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ lastSeen: now.toISOString(), pid: process.pid }));
        fs.renameSync(tmp, HEARTBEAT_FILE); // atomic swap: a reader never sees a half-written file
    } catch (err) {
        logger.warn('[CryptoUptime] Could not write heartbeat', { err: err.message });
    }
}

function readHeartbeat() {
    try {
        const t = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8')).lastSeen;
        const d = new Date(t);
        return Number.isNaN(d.getTime()) ? null : d;
    } catch (_) { return null; }
}

/** Whole minutes between two instants, or null if no prior heartbeat. */
function minutesSince(lastSeen, now = new Date()) {
    return lastSeen ? Math.floor((now.getTime() - lastSeen.getTime()) / 60000) : null;
}

function _duration(min) {
    if (min < 90) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return h < 48 ? `${h}h ${m}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function _positionLines(positions) {
    return positions.map(p => {
        const px = parseFloat(p.current_price), stop = parseFloat(p.stop_loss_price), tp = parseFloat(p.take_profit_price);
        const flag = px && stop && px <= stop ? ' ⚠️ at/below stop' : (px && tp && px >= tp ? ' ✅ at/above take-profit' : '');
        return `  • ${p.symbol}: last ${px || '?'} (stop ${stop || '?'} / TP ${tp || '?'})${flag}`;
    });
}

function buildStartupGapMessage(gapMin, positions) {
    return [
        '⚠️ *Crypto bot was offline while you held positions*',
        '',
        `It was silent for *${_duration(gapMin)}* before this restart. Take-profits and software stop-checks did not run in that time; only the stop orders resting at Alpaca were protecting these:`,
        ..._positionLines(positions),
        '',
        '_The bot resumes checking them on its next cycle (≤5 min). A stop-limit can be skipped in a fast gap, so please glance at Alpaca._'
    ].join('\n');
}

function buildStaleMessage(ageMin, positions) {
    return [
        '🚨 *Crypto bot stopped responding while you hold positions*',
        '',
        `No heartbeat from the crypto process for *${_duration(ageMin)}*. Take-profits are not running; only the resting Alpaca stops are protecting:`,
        ..._positionLines(positions),
        '',
        '_Check that `kiranrock-crypto` is running (pm2 status) and restart it if not._'
    ].join('\n');
}

async function _usersWithPositions(deps) {
    const cryptoDb = deps.cryptoDb || require('./cryptoDatabaseService');
    const users = await cryptoDb.getActiveUsers();
    const out = [];
    for (const u of users) {
        const positions = await cryptoDb.getPositions(u.id);
        if (positions && positions.length > 0) out.push({ userId: u.id, positions });
    }
    return out;
}

/** Call once when the crypto scheduler starts. Always refreshes the heartbeat afterwards. */
async function checkStartupGap({ now = new Date(), deps = {} } = {}) {
    const alertService = deps.alertService || require('./telegramAlertService');
    const last = (deps.readHeartbeat || readHeartbeat)();
    const gapMin = minutesSince(last, now);
    let alerted = 0;
    try {
        if (gapMin !== null && gapMin >= GAP_ALERT_MIN) {
            for (const { userId, positions } of await _usersWithPositions(deps)) {
                await alertService.sendMessage(userId, buildStartupGapMessage(gapMin, positions));
                alerted++;
            }
            logger.warn('[CryptoUptime] Startup gap detected', { gapMin, alerted });
        }
    } catch (err) {
        logger.warn('[CryptoUptime] Startup gap check failed (non-fatal)', { err: err.message });
    } finally {
        (deps.writeHeartbeat || writeHeartbeat)(now);
    }
    return { gapMin, alerted };
}

// One alert per outage: remember which heartbeat we already alerted about.
let _alertedForHeartbeat = null;

/** Call periodically from a DIFFERENT process than the crypto scheduler. */
async function runLiveWatchdog({ now = new Date(), deps = {} } = {}) {
    const alertService = deps.alertService || require('./telegramAlertService');
    const last = (deps.readHeartbeat || readHeartbeat)();
    if (!last) return { alerted: 0, reason: 'no-heartbeat-yet' };   // crypto never started here
    const ageMin = minutesSince(last, now);
    if (ageMin < STALE_ALERT_MIN) { _alertedForHeartbeat = null; return { alerted: 0, ageMin }; }
    if (_alertedForHeartbeat === last.getTime()) return { alerted: 0, reason: 'already-alerted', ageMin };

    let alerted = 0;
    try {
        for (const { userId, positions } of await _usersWithPositions(deps)) {
            await alertService.sendMessage(userId, buildStaleMessage(ageMin, positions));
            alerted++;
        }
        _alertedForHeartbeat = last.getTime();
        if (alerted) logger.warn('[CryptoUptime] Crypto process stale with open positions', { ageMin, alerted });
    } catch (err) {
        logger.warn('[CryptoUptime] Watchdog failed (non-fatal)', { err: err.message });
    }
    return { alerted, ageMin };
}

function _resetForTests() { _alertedForHeartbeat = null; }

module.exports = {
    writeHeartbeat, readHeartbeat, minutesSince, checkStartupGap, runLiveWatchdog,
    buildStartupGapMessage, buildStaleMessage, _resetForTests, GAP_ALERT_MIN, STALE_ALERT_MIN
};
