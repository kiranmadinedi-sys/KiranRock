/**
 * Forward Return Calculator
 * ================================================
 * Shared math for "what happened to the price after this moment" — used by
 * BOTH shadowTradeService (rejected candidates) and tradeForwardTrackingService
 * (actually executed BUYs). Extracted 2026-09-08 building the Gate Alpha
 * Attribution report: that report's entire point is comparing the two side by
 * side, so the two computations MUST use identical logic — a report comparing
 * "Actual BUY" against "Rejected — sector_count_cap" is meaningless if each
 * side quietly computes its numbers a different way.
 */

'use strict';

const RETURN_CHECKPOINTS = [5, 10, 20];
const TRACK_TRADING_DAYS = 20; // how long to keep watching before closing tracking out

/**
 * @param {Array<{high:number, low:number, close:number}>} barsSince - daily bars
 *   strictly AFTER the anchor timestamp (entry or rejection moment), oldest first.
 * @param {number} entryPrice - the reference price to measure movement from.
 * @returns {{mfePct:number, maePct:number, return5dPct:number|null,
 *            return10dPct:number|null, return20dPct:number|null,
 *            tradingDaysTracked:number, shouldClose:boolean}|null}
 *   null when there's nothing to compute from yet (no bars since anchor).
 */
function computeForwardMetrics(barsSince, entryPrice) {
    if (!barsSince || barsSince.length === 0 || !entryPrice || entryPrice <= 0) return null;

    const highs = barsSince.map(b => b.high);
    const lows  = barsSince.map(b => b.low);
    const mfePct = ((Math.max(...highs) - entryPrice) / entryPrice) * 100;
    const maePct = ((Math.min(...lows)  - entryPrice) / entryPrice) * 100;

    const returns = {};
    for (const n of RETURN_CHECKPOINTS) {
        if (barsSince.length >= n) {
            returns[n] = ((barsSince[n - 1].close - entryPrice) / entryPrice) * 100;
        }
    }

    return {
        mfePct,
        maePct,
        return5dPct:  returns[5]  ?? null,
        return10dPct: returns[10] ?? null,
        return20dPct: returns[20] ?? null,
        tradingDaysTracked: barsSince.length,
        shouldClose: barsSince.length >= TRACK_TRADING_DAYS
    };
}

/**
 * Filters a raw bar list down to only bars strictly after `anchorMs`, matching
 * both trackers' "only what happened AFTER this moment" semantics.
 */
function barsAfter(bars, anchorMs) {
    return (bars || []).filter(b => new Date(b.time || b.date).getTime() > anchorMs);
}

module.exports = {
    computeForwardMetrics,
    barsAfter,
    RETURN_CHECKPOINTS,
    TRACK_TRADING_DAYS
};
