/**
 * VIX Spike Monitor Service
 *
 * Runs every 5 minutes (piggybacked on the AI scheduler tick) during market hours.
 * Detects two types of danger:
 *   1. Fast moves  — VIX up ≥20% in a single 5-min interval
 *   2. Level breaks — VIX crosses key thresholds (25, 30, 35, 40) from below
 *
 * When a spike is detected:
 *   • Sets an in-process spike state (getSpikeState / isSpikeActive)
 *   • Invalidates the market-regime cache so the next trade decision re-evaluates
 *   • Invalidates the ATLAS global sentiment cache
 *   • Fires a Telegram alert to every active trading user
 *
 * Auto-clear: spike clears after 2 consecutive readings below the trigger threshold
 * (hysteresis prevents oscillation around a boundary).
 */

const dataProvider        = require('./dataProvider');
const { logger }          = require('../utils/logger');

// Lazy-loaded to avoid circular-dependency issues at startup
let _regimeService   = null;
let _sentimentService = null;
let _alertService    = null;
let _userDb          = null;

function _regime()    { return _regimeService    || (_regimeService    = require('./marketRegimeService')); }
function _sentiment() { return _sentimentService || (_sentimentService = require('./globalSentimentService')); }
function _alert()     { return _alertService     || (_alertService     = require('./telegramAlertService')); }
function _users()     { return _userDb           || (_userDb           = require('./userDatabaseService')); }

// ── Spike levels ──────────────────────────────────────────────────────────────
const LEVELS = {
    PANIC:    { threshold: 40, clearBelow: 35, emoji: '🚨', label: 'PANIC'    },
    EXTREME:  { threshold: 30, clearBelow: 28, emoji: '🔴', label: 'EXTREME'  },
    HIGH:     { threshold: 25, clearBelow: 23, emoji: '🟠', label: 'HIGH'     },
    ELEVATED: { threshold: 20, clearBelow: 18, emoji: '🟡', label: 'ELEVATED' },
};

// A fast intraday move this large is a spike regardless of absolute level
const FAST_MOVE_PCT = 20;

// ── In-process state ──────────────────────────────────────────────────────────
let _state = {
    spikeActive:              false,
    level:                    null,   // 'ELEVATED' | 'HIGH' | 'EXTREME' | 'PANIC'
    vixAtSpike:               null,
    prevVix:                  null,
    pctChange:                null,
    detectedAt:               null,
    consecutiveClearReadings: 0,
};

// Rolling history — last 3 readings so we can compute % change
let _history = [];   // [ { vix: number, ts: Date }, … ]

// ── Public helpers ────────────────────────────────────────────────────────────
function getSpikeState() { return { ..._state }; }
function isSpikeActive()  { return _state.spikeActive; }

/**
 * Determine the spike level name for a given absolute VIX.
 * Returns the worst-applicable level or null.
 */
function _levelFor(vix) {
    if (vix >= LEVELS.PANIC.threshold)    return 'PANIC';
    if (vix >= LEVELS.EXTREME.threshold)  return 'EXTREME';
    if (vix >= LEVELS.HIGH.threshold)     return 'HIGH';
    if (vix >= LEVELS.ELEVATED.threshold) return 'ELEVATED';
    return null;
}

/**
 * Check whether the active spike has naturally cleared.
 * Uses per-level hysteresis so a spike at 25.1 doesn't clear the moment VIX hits 24.9.
 */
function _isClear(currentVix) {
    if (!_state.spikeActive || !_state.level) return true;
    const clearBelow = LEVELS[_state.level]?.clearBelow ?? 18;
    return currentVix < clearBelow;
}

// ── Cache invalidation ────────────────────────────────────────────────────────
function _invalidateCaches() {
    try { _regime().invalidateCache();    } catch (_) {}
    try { _sentiment().invalidateCache(); } catch (_) {}
    logger.info('[VIXMonitor] Market regime + ATLAS caches invalidated');
}

// ── Telegram broadcast ────────────────────────────────────────────────────────
async function _broadcast(vix, prevVix, pctChange, levelName) {
    try {
        const users = await _users().getUsersWithAITradingEnabled();
        if (!users?.length) return;

        const { emoji, label } = LEVELS[levelName] || { emoji: '⚠️', label: levelName };
        const direction = pctChange > 0 ? '▲' : '▼';
        const msg = [
            `${emoji} *VIX SPIKE — ${label}*`,
            '',
            `Current VIX : *${vix.toFixed(2)}*`,
            `Previous    : ${prevVix?.toFixed(2) ?? '—'}`,
            `Move        : ${direction}${Math.abs(pctChange).toFixed(1)}%`,
            '',
            levelName === 'PANIC'
                ? '🚨 *PANIC level — all new entries halted, exits only*'
                : levelName === 'EXTREME'
                ? '🔴 *EXTREME — new purchases suspended until VIX calms*'
                : levelName === 'HIGH'
                ? '🟠 *HIGH — position sizing reduced, elevated caution*'
                : '🟡 *ELEVATED — scores penalised, monitor closely*',
            '',
            '_Market regime + ATLAS recalculating now._',
        ].join('\n');

        await _alert().broadcastToUsers(users.map(u => u.id), msg);
        logger.info('[VIXMonitor] Broadcast sent', { levelName, vix, users: users.length });
    } catch (err) {
        logger.warn('[VIXMonitor] Broadcast failed', { error: err.message });
    }
}

// ── Main check — called every 5 min by the AI scheduler ──────────────────────
async function checkVix() {
    let vix;
    try {
        const raw = await dataProvider.getQuote('^VIX');
        vix = raw?.price ?? raw?.regularMarketPrice;
        if (!vix || typeof vix !== 'number') return;
    } catch (err) {
        logger.warn('[VIXMonitor] VIX fetch failed', { error: err.message });
        return;
    }

    const now   = new Date();
    const prev  = _history.length > 0 ? _history[_history.length - 1] : null;
    const prevVix   = prev?.vix ?? null;
    const pctChange = prevVix ? ((vix - prevVix) / prevVix) * 100 : 0;

    // Keep only last 3 readings
    _history.push({ vix, ts: now });
    if (_history.length > 3) _history.shift();

    const absoluteLevel = _levelFor(vix);
    const isFastMove    = Math.abs(pctChange) >= FAST_MOVE_PCT && prevVix !== null;

    // ── Spike detection ───────────────────────────────────────────────────────
    if (!_state.spikeActive) {
        // Level break: VIX crossed into a new dangerous zone
        const levelBreak = absoluteLevel !== null &&
            prevVix !== null &&
            prevVix < LEVELS[absoluteLevel].threshold;

        // Fast move spike
        const fastSpike = isFastMove && pctChange > 0;

        if (levelBreak || fastSpike) {
            const levelName = absoluteLevel ?? (vix >= 20 ? 'ELEVATED' : 'ELEVATED');
            _state = {
                spikeActive:              true,
                level:                    levelName,
                vixAtSpike:               vix,
                prevVix,
                pctChange,
                detectedAt:               now,
                consecutiveClearReadings: 0,
            };

            logger.warn('[VIXMonitor] SPIKE DETECTED', {
                levelName, vix, prevVix, pctChange: pctChange.toFixed(1),
                trigger: levelBreak ? 'level_break' : 'fast_move',
            });

            _invalidateCaches();
            _broadcast(vix, prevVix, pctChange, levelName).catch(() => {});
        }

    } else {
        // ── Auto-clear logic ──────────────────────────────────────────────────
        // Upgrade level if VIX has worsened beyond current classification
        if (absoluteLevel && absoluteLevel !== _state.level) {
            const order = ['ELEVATED', 'HIGH', 'EXTREME', 'PANIC'];
            if (order.indexOf(absoluteLevel) > order.indexOf(_state.level)) {
                logger.warn('[VIXMonitor] Spike level UPGRADED', {
                    from: _state.level, to: absoluteLevel, vix
                });
                _state.level = absoluteLevel;
                _state.vixAtSpike = vix;
                _invalidateCaches();
                _broadcast(vix, prevVix, pctChange, absoluteLevel).catch(() => {});
            }
        }

        if (_isClear(vix)) {
            _state.consecutiveClearReadings += 1;
            if (_state.consecutiveClearReadings >= 2) {
                logger.info('[VIXMonitor] Spike cleared', {
                    clearedLevel: _state.level, currentVix: vix
                });
                _state = {
                    spikeActive: false, level: null,
                    vixAtSpike: null, prevVix: null, pctChange: null,
                    detectedAt: null, consecutiveClearReadings: 0,
                };
                _invalidateCaches(); // refresh caches now that fear is subsiding
            }
        } else {
            _state.consecutiveClearReadings = 0; // reset counter if still elevated
        }
    }

    logger.debug('[VIXMonitor] Tick', {
        vix, prevVix, pctChange: pctChange.toFixed(1),
        spikeActive: _state.spikeActive, level: _state.level,
    });
}

module.exports = { checkVix, getSpikeState, isSpikeActive };
