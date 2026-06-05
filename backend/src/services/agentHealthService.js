/**
 * AGENT_HEALTH — Heartbeat tracker (PANTHEON spec Redis key: AGENT_HEALTH)
 *
 * Stores a JSON file at data/sage/agent_health.json.
 * Each agent records a timestamp when it starts/completes a run.
 * FORGE health check reads this to detect stuck or silent agents.
 *
 * In a multi-process AWS deployment this would write to Redis;
 * for single-process Node.js the file store is equivalent.
 */

const fs   = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');

const HEALTH_FILE = path.join(__dirname, '../../data/sage/agent_health.json');

// Agents are considered stale if they haven't reported within these windows (ms)
const STALE_THRESHOLDS = {
    ORACLE:   4  * 60 * 60 * 1000, // 4 h  — fires pre-market only
    VISION:   4  * 60 * 60 * 1000,
    PROPHET:  4  * 60 * 60 * 1000,
    SAGE:     25 * 60 * 60 * 1000, // 25 h — fires once per session end
    COMPASS:  4  * 60 * 60 * 1000,
    SONAR:    25 * 60 * 60 * 1000,
    PULSE:    4  * 60 * 60 * 1000,
    SHIELD:   4  * 60 * 60 * 1000,
    ARROW:    4  * 60 * 60 * 1000,
    FORGE:    25 * 60 * 60 * 1000,
    DEFAULT:  25 * 60 * 60 * 1000,
};

function _load() {
    try {
        if (fs.existsSync(HEALTH_FILE)) {
            return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
        }
    } catch { /* ignore */ }
    return {};
}

function _save(state) {
    try {
        const dir = path.dirname(HEALTH_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(HEALTH_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        logger.warn('[AGENT_HEALTH] Could not write health file', { err: e.message });
    }
}

/**
 * Record a heartbeat for an agent.
 * @param {string} agentName  — e.g. 'ORACLE', 'SAGE', 'VISION'
 * @param {string} [status]   — 'START' | 'OK' | 'ERROR' (default 'OK')
 * @param {object} [meta]     — any extra context to persist
 */
function recordHeartbeat(agentName, status = 'OK', meta = {}) {
    try {
        const state = _load();
        state[agentName] = {
            lastSeen:  new Date().toISOString(),
            status,
            ...meta
        };
        _save(state);
    } catch (e) {
        // Health tracking must never block trading
        logger.warn('[AGENT_HEALTH] recordHeartbeat failed', { agentName, err: e.message });
    }
}

/**
 * Return full health snapshot.
 * @returns {{ [agentName]: { lastSeen, status, stale: bool } }}
 */
function getAgentHealth() {
    const state = _load();
    const now   = Date.now();
    const result = {};

    for (const [name, info] of Object.entries(state)) {
        const threshold = STALE_THRESHOLDS[name] || STALE_THRESHOLDS.DEFAULT;
        const age       = info.lastSeen ? now - new Date(info.lastSeen).getTime() : Infinity;
        result[name] = { ...info, stale: age > threshold, ageMs: age };
    }
    return result;
}

/**
 * Returns a list of agent names that are stale (haven't reported within threshold).
 */
function getStaleAgents() {
    const health = getAgentHealth();
    return Object.entries(health)
        .filter(([, v]) => v.stale)
        .map(([name, v]) => ({ name, lastSeen: v.lastSeen, status: v.status }));
}

module.exports = { recordHeartbeat, getAgentHealth, getStaleAgents };
