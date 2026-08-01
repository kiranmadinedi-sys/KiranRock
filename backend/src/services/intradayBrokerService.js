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
    const { base, headers } = await _getAuth(userId);

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
        symbol, qty: String(position.quantity), side: 'sell', type: 'market', time_in_force: 'day'
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
