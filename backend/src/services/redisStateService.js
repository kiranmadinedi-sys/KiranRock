/**
 * PANTHEON Redis State Service
 * =============================
 * Centralises all Redis key reads/writes for multi-process AWS coordination.
 *
 * PANTHEON spec keys implemented:
 *   HALT_ALL              — global kill-switch (set = halt all bots)
 *   POSITIONS_OPEN:{uid}  — JSON array of open position symbols per user
 *   ORACLE_WATCHLIST      — JSON array of symbols queued for ORACLE review
 *   REGIME:usa            — current USA market regime string
 *   DATA_STALE:atlas      — flag set when ATLAS data fetch is overdue
 *   AGENT_HEALTH:{agent}  — last heartbeat ISO string per agent
 *   PIPELINE_LOCK:{uid}   — IST pipeline mutex (prevents double-run)
 *   IST_STAGE:{uid}       — current pipeline stage name for a user session
 *
 * Design:
 *   - All methods are safe to call when Redis is unavailable — they log a
 *     warning and return sensible defaults so trading is never blocked.
 *   - Connection is lazy: the client connects on first use, not on import.
 *   - Environment variable REDIS_URL controls connection (default: localhost).
 */

const { createClient } = require('redis');
const { logger } = require('../utils/logger');
const { query }  = require('../config/database');

const REDIS_URL  = process.env.REDIS_URL || 'redis://localhost:6379';
const KEY_PREFIX = 'pantheon:';

// TTLs (seconds)
const TTL = {
    HALT_ALL:         0,          // persistent until manually cleared
    POSITIONS_OPEN:   600,        // 10 min — refreshed every cycle
    ORACLE_WATCHLIST: 3600,       // 1 h
    REGIME:           900,        // 15 min
    DATA_STALE:       300,        // 5 min flag life
    AGENT_HEALTH:     300,        // agent considered dead if stale > 5 min
    PIPELINE_LOCK:    1800,       // 30 min safety — avoids zombie locks
    IST_STAGE:        3600,       // 1 h
};

let _client = null;
let _connected = false;
let _connectAttempted = false;

/**
 * Lazily connect to Redis.
 * Returns the client on success, null on failure.
 */
async function getClient() {
    if (_connected && _client) return _client;
    if (_connectAttempted) return null; // already tried and failed — don't retry on every call

    _connectAttempted = true;
    try {
        _client = createClient({ url: REDIS_URL });
        _client.on('error', err => {
            if (_connected) {
                logger.warn('[Redis] Connection error — state keys will fall back to no-op', { err: err.message });
                _connected = false;
            }
        });
        _client.on('reconnecting', () => {
            logger.info('[Redis] Reconnecting...');
        });
        _client.on('ready', () => {
            logger.info('[Redis] Connected and ready');
            _connected = true;
            _connectAttempted = false; // allow re-attempt after a successful reconnect cycle
        });

        await _client.connect();
        _connected = true;
        logger.info('[Redis] Initial connection established', { url: REDIS_URL });
        return _client;
    } catch (err) {
        logger.warn('[Redis] Could not connect — all state key ops will no-op', { err: err.message, url: REDIS_URL });
        _client = null;
        _connected = false;
        return null;
    }
}

function k(key) { return KEY_PREFIX + key; }

// ─── HALT_ALL ─────────────────────────────────────────────────────────────────
// HALT_ALL is written to BOTH Redis (fast multi-node broadcast) AND the DB
// (durable fallback).  If Redis is unavailable when getHaltAll() is called,
// the DB copy is consulted so a Redis outage cannot bypass an active halt.

async function _dbSetHaltAll(reason) {
    try {
        await query(
            `UPDATE system_controls SET halt_all_reason=$1, halt_all_set_at=NOW(), updated_at=NOW() WHERE id=1`,
            [reason]
        );
    } catch (err) {
        logger.warn('[Redis/DB] Could not persist HALT_ALL to DB', { err: err.message });
    }
}

async function _dbClearHaltAll() {
    try {
        await query(
            `UPDATE system_controls SET halt_all_reason=NULL, halt_all_set_at=NULL, updated_at=NOW() WHERE id=1`
        );
    } catch (err) {
        logger.warn('[Redis/DB] Could not clear HALT_ALL from DB', { err: err.message });
    }
}

async function _dbGetHaltAll() {
    try {
        const res = await query(
            `SELECT halt_all_reason FROM system_controls WHERE id=1 LIMIT 1`
        );
        return res.rows[0]?.halt_all_reason || null;
    } catch {
        return null;
    }
}

/** Set HALT_ALL flag — stops all bots on any EC2 node */
async function setHaltAll(reason = 'manual') {
    // Write to DB first — durable even if Redis is unavailable
    await _dbSetHaltAll(reason);
    const c = await getClient();
    if (c) {
        await c.set(k('HALT_ALL'), reason).catch(e => logger.warn('[Redis] setHaltAll failed', { e: e.message }));
    }
    logger.warn('[Redis] HALT_ALL set', { reason });
}

/** Clear HALT_ALL — re-enables all bots */
async function clearHaltAll() {
    await _dbClearHaltAll();
    const c = await getClient();
    if (c) {
        await c.del(k('HALT_ALL')).catch(e => logger.warn('[Redis] clearHaltAll failed', { e: e.message }));
    }
    logger.info('[Redis] HALT_ALL cleared — bots re-enabled');
}

/**
 * Returns halt reason string, or null if not halted.
 *
 * Read order:
 *   1. Redis (fast)
 *   2. DB fallback when Redis is unavailable
 *
 * If Redis was configured but is currently unreachable and the DB has an
 * active halt, the halt is enforced.  This prevents the scenario where:
 *   reconciliation failure → HALT_ALL written → Redis dies → halt bypassed.
 */
async function getHaltAll() {
    const c = await getClient();
    if (c) {
        try {
            const redisVal = await c.get(k('HALT_ALL'));
            if (redisVal) return redisVal;
            // Redis connected but no halt — still check DB in case it was set
            // before this process started (Redis TTL = persistent, but belt+suspenders)
            return await _dbGetHaltAll();
        } catch {
            // Redis connected but read errored — fall through to DB
        }
    }

    // Redis unavailable: use DB copy
    const dbVal = await _dbGetHaltAll();
    if (dbVal) {
        logger.warn('[Redis] HALT_ALL read from DB fallback (Redis unavailable)', { reason: dbVal });
    } else if (_connectAttempted && !_connected) {
        // Redis was configured and tried to connect but failed; no halt in DB either.
        // Log a warning so the operator knows Redis is down — don't block trading
        // because DB circuit breakers (daily loss, drawdown) still provide protection.
        logger.warn('[Redis] Cannot reach Redis and no DB halt set — proceeding with caution');
    }
    return dbVal;
}

// ─── POSITIONS_OPEN ──────────────────────────────────────────────────────────

/** Store the list of open position symbols for a user */
async function setOpenPositions(userId, symbols = []) {
    const c = await getClient();
    if (!c) return;
    try {
        await c.set(k(`POSITIONS_OPEN:${userId}`), JSON.stringify(symbols), { EX: TTL.POSITIONS_OPEN });
    } catch (e) {
        logger.warn('[Redis] setOpenPositions failed', { userId, e: e.message });
    }
}

/** Get open position symbols for a user. Returns [] on failure */
async function getOpenPositions(userId) {
    const c = await getClient();
    if (!c) return [];
    try {
        const raw = await c.get(k(`POSITIONS_OPEN:${userId}`));
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

// ─── ORACLE_WATCHLIST ────────────────────────────────────────────────────────

/** Add a symbol to the ORACLE watchlist queue */
async function addToOracleWatchlist(symbol) {
    const c = await getClient();
    if (!c) return;
    try {
        const raw = await c.get(k('ORACLE_WATCHLIST'));
        const list = raw ? JSON.parse(raw) : [];
        if (!list.includes(symbol)) {
            list.push(symbol);
            await c.set(k('ORACLE_WATCHLIST'), JSON.stringify(list), { EX: TTL.ORACLE_WATCHLIST });
        }
    } catch (e) {
        logger.warn('[Redis] addToOracleWatchlist failed', { symbol, e: e.message });
    }
}

/** Get current ORACLE watchlist. Returns [] on failure */
async function getOracleWatchlist() {
    const c = await getClient();
    if (!c) return [];
    try {
        const raw = await c.get(k('ORACLE_WATCHLIST'));
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

/** Clear the ORACLE watchlist */
async function clearOracleWatchlist() {
    const c = await getClient();
    if (!c) return;
    await c.del(k('ORACLE_WATCHLIST')).catch(() => {});
}

// ─── REGIME ──────────────────────────────────────────────────────────────────

/** Set current market regime ('bullish', 'bearish', 'neutral', etc.) for a market */
async function setRegime(market = 'usa', regime) {
    const c = await getClient();
    if (!c) return;
    try {
        await c.set(k(`REGIME:${market}`), regime, { EX: TTL.REGIME });
        logger.info(`[Redis] REGIME:${market} = ${regime}`);
    } catch (e) {
        logger.warn('[Redis] setRegime failed', { market, e: e.message });
    }
}

/** Get current regime for a market. Returns null on miss/failure */
async function getRegime(market = 'usa') {
    const c = await getClient();
    if (!c) return null;
    try {
        return await c.get(k(`REGIME:${market}`));
    } catch {
        return null;
    }
}

// ─── DATA_STALE ──────────────────────────────────────────────────────────────

/** Mark a data pipeline as stale (e.g. 'atlas') */
async function setDataStale(pipeline = 'atlas') {
    const c = await getClient();
    if (!c) return;
    try {
        await c.set(k(`DATA_STALE:${pipeline}`), '1', { EX: TTL.DATA_STALE });
        logger.warn(`[Redis] DATA_STALE:${pipeline} flagged`);
    } catch (e) {
        logger.warn('[Redis] setDataStale failed', { pipeline, e: e.message });
    }
}

/** Returns true if a pipeline is flagged stale */
async function isDataStale(pipeline = 'atlas') {
    const c = await getClient();
    if (!c) return false;
    try {
        return !!(await c.get(k(`DATA_STALE:${pipeline}`)));
    } catch {
        return false;
    }
}

/** Clear the stale flag for a pipeline once data has been refreshed */
async function clearDataStale(pipeline = 'atlas') {
    const c = await getClient();
    if (!c) return;
    await c.del(k(`DATA_STALE:${pipeline}`)).catch(() => {});
}

// ─── AGENT_HEALTH ────────────────────────────────────────────────────────────

/**
 * Record an agent heartbeat.
 * @param {string} agentName  e.g. 'ORACLE', 'COMPASS', 'SHIELD'
 */
async function pingAgentHealth(agentName) {
    const c = await getClient();
    if (!c) return;
    try {
        await c.set(k(`AGENT_HEALTH:${agentName}`), new Date().toISOString(), { EX: TTL.AGENT_HEALTH });
    } catch (e) {
        logger.warn('[Redis] pingAgentHealth failed', { agentName, e: e.message });
    }
}

/**
 * Get last heartbeat ISO string for an agent.
 * Returns null if agent never pinged or key expired (i.e. agent is dead).
 */
async function getAgentHealth(agentName) {
    const c = await getClient();
    if (!c) return null;
    try {
        return await c.get(k(`AGENT_HEALTH:${agentName}`));
    } catch {
        return null;
    }
}

/** Returns true if agent heartbeat is fresh (key exists) */
async function isAgentAlive(agentName) {
    const h = await getAgentHealth(agentName);
    return h !== null;
}

// ─── PIPELINE_LOCK ────────────────────────────────────────────────────────────

/**
 * Acquire a pipeline lock for a user session (prevents double-run across EC2s).
 * Uses SET NX (set if not exists) for atomic lock acquisition.
 * Returns true if lock acquired, false if already locked by another process.
 */
async function acquirePipelineLock(userId) {
    const c = await getClient();
    if (!c) return true; // fail open — don't block when Redis unavailable
    try {
        const result = await c.set(
            k(`PIPELINE_LOCK:${userId}`),
            process.pid.toString(),
            { NX: true, EX: TTL.PIPELINE_LOCK }
        );
        return result === 'OK';
    } catch {
        return true; // fail open
    }
}

/** Release pipeline lock for a user */
async function releasePipelineLock(userId) {
    const c = await getClient();
    if (!c) return;
    await c.del(k(`PIPELINE_LOCK:${userId}`)).catch(() => {});
}

// ─── IST_STAGE ────────────────────────────────────────────────────────────────

/** Record the currently executing IST pipeline stage for a user session */
async function setIstStage(userId, stageName) {
    const c = await getClient();
    if (!c) return;
    try {
        await c.set(k(`IST_STAGE:${userId}`), stageName, { EX: TTL.IST_STAGE });
        logger.info(`[Redis] IST_STAGE:${userId} = ${stageName}`);
    } catch (e) {
        logger.warn('[Redis] setIstStage failed', { userId, stageName, e: e.message });
    }
}

/** Get current IST stage for a user. Returns null if not set */
async function getIstStage(userId) {
    const c = await getClient();
    if (!c) return null;
    try {
        return await c.get(k(`IST_STAGE:${userId}`));
    } catch {
        return null;
    }
}

/** Disconnect the Redis client — call on graceful shutdown */
async function disconnect() {
    if (_client && _connected) {
        try {
            await _client.quit();
            _connected = false;
            logger.info('[Redis] Disconnected');
        } catch { /* ignore */ }
    }
}

module.exports = {
    // Connection
    getClient,
    disconnect,

    // HALT_ALL
    setHaltAll,
    clearHaltAll,
    getHaltAll,

    // POSITIONS_OPEN
    setOpenPositions,
    getOpenPositions,

    // ORACLE_WATCHLIST
    addToOracleWatchlist,
    getOracleWatchlist,
    clearOracleWatchlist,

    // REGIME
    setRegime,
    getRegime,

    // DATA_STALE
    setDataStale,
    isDataStale,
    clearDataStale,

    // AGENT_HEALTH
    pingAgentHealth,
    getAgentHealth,
    isAgentAlive,

    // PIPELINE_LOCK
    acquirePipelineLock,
    releasePipelineLock,

    // IST_STAGE
    setIstStage,
    getIstStage,
};
