/**
 * In-process "a stop change is in progress" marker, keyed by user + symbol.
 *
 * 2026-10-12: the bot's StopRepair raises a stop by cancel → wait ~20s for Alpaca to
 * release the shares → place. The health monitor's checkAndFixStops runs on its own
 * 5-min timer in the same worker process; when the two lined up (both tick at ~:x4:2x)
 * it saw the position mid-swap with no stop and placed its own 7%-below-entry stop.
 * That stop grabbed the shares, so StopRepair's raise AND restore both hit 403 and it
 * logged a false "CRITICAL — no stop", while the position actually sat on a LOWER stop
 * than before (2026-10-09: GME 24.07→23.78, kmadined BUG 46.52→44.98).
 *
 * StopRepair holds the marker for the whole cancel→place window; the health monitor
 * skips any symbol that is marked. The TTL is a safety net so a crash mid-swap can
 * never leave a symbol permanently skipped.
 */
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const _inFlight = new Map(); // `${userId}:${symbol}` → expiresAt (ms)

function _key(userId, symbol) {
    return `${userId}:${symbol}`;
}

function markStopChange(userId, symbol, ttlMs = DEFAULT_TTL_MS) {
    _inFlight.set(_key(userId, symbol), Date.now() + ttlMs);
}

function clearStopChange(userId, symbol) {
    _inFlight.delete(_key(userId, symbol));
}

function isStopChangeInProgress(userId, symbol) {
    const k = _key(userId, symbol);
    const expiresAt = _inFlight.get(k);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
        _inFlight.delete(k);
        return false;
    }
    return true;
}

module.exports = { markStopChange, clearStopChange, isStopChangeInProgress };
