/**
 * Blitz — Intraday Order Execution
 *
 * A deliberately separate, thinner execution layer from brokerService.js.
 * brokerService's buyBracket/buyFractional/sellMarket all hardcode a write
 * to the shared `holdings`/`trades` tables via tradingServiceDB — reusing
 * them as-is for Blitz would corrupt the exact separation this module
 * exists to guarantee (holdings has UNIQUE(user_id, symbol); a symbol swing
 * already owns could never get a second, independent Blitz lot).
 *
 * Read-only / no-side-effect broker calls (getAccountInfo, getPosition,
 * placeStopOrder, cancelOrder, getOpenOrders) ARE reused directly from
 * brokerService — those don't touch holdings and are already correct
 * (placeStopOrder in particular already has this week's fractional-share
 * TIF fix baked in, no reason to duplicate that logic).
 */

const axios = require('axios');
const userDb = require('./userDatabaseService');
const brokerService = require('./brokerService');
const intradayDb = require('./intradayDatabaseService');
const { logger } = require('../utils/logger');

async function _getAuth(userId) {
    const creds = await userDb.getUserAlpacaCredentials(userId);
    const base = creds.isPaper ? 'https://paper-api.alpaca.markets/v2' : 'https://api.alpaca.markets/v2';
    const headers = { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secretKey };
    return { base, headers };
}

/**
 * Market-buy entry for a Blitz position, then place a resting protective
 * stop (reusing brokerService.placeStopOrder — already fractional-aware).
 * The take-profit is monitored in software by the scheduler's own 1-minute
 * tick rather than a second resting order, keeping this path simple.
 */
async function buyIntraday(userId, symbol, quantity, { stopLossPercent, takeProfitPercent }) {
    // Guard (2026-08-15, same incident as the sellIntraday fix above): scanForUser's
    // heldSymbols check only looks at our own intraday_positions table, which can
    // desync from the real broker state (e.g. after the duplicate-sell-goes-short
    // race). Re-verify no real position of ANY sign already exists on Alpaca before
    // entering what Blitz believes is a flat, fresh symbol -- brokerService's
    // getPosition() deliberately filters to qty>0 only (built for the buy-guard use
    // case elsewhere), so it would silently miss an existing short; use the
    // unfiltered getPositions() list instead so a short is actually caught here.
    const { base, headers } = await _getAuth(userId);
    const existing = (await brokerService.getPositions(userId)).find(p => p.symbol === symbol);
    if (existing && Math.abs(parseFloat(existing.qty)) > 0.001) {
        logger.warn('[Blitz] Skipping entry — a real Alpaca position already exists outside our tracking', {
            userId, symbol, realQty: existing.qty
        });
        return null;
    }

    const order = await axios.post(`${base}/orders`, {
        symbol, qty: String(quantity), side: 'buy', type: 'market', time_in_force: 'day'
    }, { headers });

    // Poll briefly for a fill — intraday market orders on liquid names fill fast.
    let filled = order.data;
    for (let i = 0; i < 5 && filled.status !== 'filled'; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const check = await axios.get(`${base}/orders/${order.data.id}`, { headers });
        filled = check.data;
    }

    if (filled.status !== 'filled') {
        logger.warn('[Blitz] Entry order not filled within poll window', { userId, symbol, status: filled.status });
        return null;
    }

    const fillPrice = parseFloat(filled.filled_avg_price);
    const filledQty = parseFloat(filled.filled_qty);
    const stopLossPrice = parseFloat((fillPrice * (1 - stopLossPercent / 100)).toFixed(2));
    const takeProfitPrice = parseFloat((fillPrice * (1 + takeProfitPercent / 100)).toFixed(2));

    try {
        await brokerService.placeStopOrder(userId, symbol, filledQty, stopLossPrice);
    } catch (stopErr) {
        logger.error('[Blitz] Failed to place protective stop after entry — position is temporarily naked', {
            userId, symbol, err: stopErr.message
        });
    }

    const position = await intradayDb.openPosition(userId, symbol, {
        quantity: filledQty, price: fillPrice, stopLossPrice, takeProfitPrice, brokerOrderId: order.data.id
    });

    logger.info('[Blitz] Entry filled', { userId, symbol, qty: filledQty, fillPrice, stopLossPrice, takeProfitPrice });
    return position;
}

/**
 * Market-sell to close a Blitz position. Cancels any resting stop order
 * first (mirrors brokerService.sellMarket's own pre-sell cleanup, same
 * reasoning: a resting stop still holding the shares causes Alpaca to
 * reject the sell with "insufficient qty available").
 */
async function sellIntraday(userId, symbol, { exitReason, scoreAtEntry }) {
    const position = await intradayDb.getPosition(userId, symbol);
    if (!position) return null;

    // Final broker-side guard immediately before submitting (2026-08-15): re-verify
    // a real long position still exists on Alpaca right now, not just in our own
    // (possibly stale) intraday_positions row. userCycleMutex's lock has a bounded
    // 8s fail-open timeout by design (so one stuck cycle can't wedge every later
    // one) -- under real Alpaca/Yahoo API latency, sellIntraday's own cancel+submit
    // +poll-for-fill sequence below can genuinely exceed that, so a second
    // overlapping call for the same symbol can start believing a position still
    // exists after the first call already closed it. Without this check, that
    // second call submits another real sell that -- finding nothing left on the
    // broker -- opens a naked short instead of erroring out (found investigating
    // an unexplained -20 share INTC short, three separate stacking incidents
    // 2026-08-13, invisible to Blitz's own tracking the whole time).
    const realPosition = await brokerService.getPosition(userId, symbol);
    if (!realPosition || parseFloat(realPosition.qty) <= 0) {
        logger.warn('[Blitz] Skipping sell — no real long position on Alpaca (already closed by a prior call)', {
            userId, symbol, exitReason
        });
        await intradayDb.closePosition(userId, symbol, {
            exitPrice: parseFloat(position.current_price || position.average_price) || 0,
            exitReason: `${exitReason}_stale_skip`, scoreAtEntry
        }).catch(() => {});
        return null;
    }
    const sellQty = Math.min(parseFloat(position.quantity), parseFloat(realPosition.qty));

    const { base, headers } = await _getAuth(userId);

    try {
        const openOrders = await brokerService.getOpenOrders(userId, symbol);
        for (const o of openOrders) {
            if (o.side === 'sell') await brokerService.cancelOrder(userId, o.id).catch(() => {});
        }
        if (openOrders.some(o => o.side === 'sell')) await new Promise(r => setTimeout(r, 1500));
    } catch (cancelErr) {
        logger.warn('[Blitz] Could not cancel resting stop before sell', { userId, symbol, err: cancelErr.message });
    }

    const order = await axios.post(`${base}/orders`, {
        symbol, qty: String(sellQty), side: 'sell', type: 'market', time_in_force: 'day'
    }, { headers });

    let filled = order.data;
    for (let i = 0; i < 5 && filled.status !== 'filled'; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const check = await axios.get(`${base}/orders/${order.data.id}`, { headers });
        filled = check.data;
    }

    const exitPrice = filled.status === 'filled' ? parseFloat(filled.filled_avg_price) : parseFloat(position.current_price || position.average_price);

    const trade = await intradayDb.closePosition(userId, symbol, { exitPrice, exitReason, scoreAtEntry });
    logger.info('[Blitz] Position closed', { userId, symbol, exitPrice, exitReason, pnl: trade?.pnl });
    return trade;
}

module.exports = { buyIntraday, sellIntraday };
