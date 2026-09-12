/**
 * Crypto Trading — Order Execution
 *
 * Mirrors intradayBrokerService.js (Blitz) closely, but crypto orders on
 * Alpaca have real, different constraints from equities that make reusing
 * brokerService.placeStopOrder unsafe here:
 *
 *   - time_in_force: crypto does NOT support 'day' at all (there's no single
 *     trading session to bound it to) -- every crypto order here uses 'gtc'
 *     unconditionally, unlike the equity path's isFractional ? 'day' : 'gtc'
 *     branch. Reusing that function as-is would send an invalid TIF and
 *     fail every single crypto stop order.
 *   - Quantities are fractional by default (buying 0.0031 BTC is the normal
 *     case, not an edge case), so this never floors to whole units the way
 *     equity position sizing does.
 *
 * Same separate-execution-layer reasoning as Blitz: writes to
 * crypto_positions/crypto_trades, never the shared holdings/trades tables.
 *
 * The stop-placement retry+alert pattern here is built in from day one --
 * added to Blitz's equity path on 2026-08-27 only after auditing found 44%
 * of its historical trades had silently fallen back to a software-only
 * backstop. No reason to ship this feature without that lesson already
 * applied.
 */
const axios = require('axios');
const userDb = require('./userDatabaseService');
const brokerService = require('./brokerService');
const cryptoDb = require('./cryptoDatabaseService');
const { logger } = require('../utils/logger');

// Alpaca's crypto endpoints are inconsistent about symbol format: orders and
// bars want the pair format ("BTC/USD"), but positions/getPositions return
// (and require, for a single-position lookup) the concatenated format
// ("BTCUSD") -- confirmed live 2026-08-28, this file's own pre-entry and
// pre-exit safety guards were silently comparing "BTC/USD" against
// brokerService's real position data (always "BTCUSD"), so they could never
// match -- meaning a real position could never be detected as "already
// exists" on entry, and worse, sellCrypto's exit guard would always believe
// no real position existed and skip the actual sell, closing only our own
// tracking row while the real Alpaca position sat unmanaged. Caught before
// this ever ran unattended.
function _toPositionSymbol(pairSymbol) {
    return pairSymbol.replace('/', '');
}

async function _getAuth(userId) {
    const creds = await userDb.getUserAlpacaCredentials(userId);
    const base = creds.isPaper ? 'https://paper-api.alpaca.markets/v2' : 'https://api.alpaca.markets/v2';
    const headers = { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secretKey };
    return { base, headers };
}

/**
 * Crypto-specific stop order — always 'gtc', never 'day'. Kept separate from
 * brokerService.placeStopOrder rather than adding a crypto branch there,
 * since that function is shared by every equity caller (swing, Blitz,
 * StopRepair) and this file's whole purpose is to keep crypto fully isolated.
 *
 * type: 'stop_limit', not 'stop' — verified live 2026-08-28: Alpaca rejects
 * a plain 'stop' crypto order with "invalid order type for crypto order"
 * (caught by this file's own retry+alert mechanism working exactly as
 * designed on its first real test). Crypto stop orders require BOTH a
 * stop_price (trigger) and a limit_price (execution floor). Limit set 0.5%
 * below the stop as a slippage buffer — tight enough to fill promptly once
 * triggered on a liquid pair, loose enough not to miss the fill entirely
 * during a fast move.
 *
 * precision: found 2026-09-08 — stopPrice/limitPrice were previously
 * stringified straight from chained float math (fillPrice * (1-pct/100),
 * then that result * 0.995), which routinely produces 15+ decimal IEEE754
 * noise (e.g. 6.873719999999999). Alpaca crypto enforces a max decimal
 * precision per pair and rejected every retry identically since the 3
 * attempts never changed the price. toFixed() up front avoids the noise for
 * the common case; the caller still adapts `precision` down further if a
 * pair's real ceiling is stricter than the default.
 */
async function _placeCryptoStopOrder(userId, symbol, qty, stopPrice, precision = 8) {
    const { base, headers } = await _getAuth(userId);
    const roundedStop = Number(stopPrice).toFixed(precision);
    const limitPrice  = (parseFloat(roundedStop) * 0.995).toFixed(precision);
    return axios.post(`${base}/orders`, {
        symbol, qty: String(qty), side: 'sell',
        type: 'stop_limit', time_in_force: 'gtc',
        stop_price: roundedStop,
        limit_price: limitPrice
    }, { headers });
}

/**
 * Market-buy entry for a crypto position, then place a resting protective
 * stop. See file docstring for why this isn't brokerService.placeStopOrder.
 */
async function buyCrypto(userId, symbol, quantity, { stopLossPercent, takeProfitPercent }) {
    // Same pre-entry guard as Blitz (2026-08-15 incident): re-verify no real
    // position of any sign already exists on Alpaca before entering what this
    // bot believes is a flat, fresh symbol. Less likely to collide for crypto
    // specifically (no other feature in this app trades it), but a user could
    // hold a crypto position manually via Alpaca outside this app, and the
    // check is cheap insurance either way.
    const { base, headers } = await _getAuth(userId);
    const positionSymbol = _toPositionSymbol(symbol);
    const existing = (await brokerService.getPositions(userId)).find(p => p.symbol === positionSymbol);
    if (existing && Math.abs(parseFloat(existing.qty)) > 0.00000001) {
        logger.warn('[CryptoBot] Skipping entry — a real Alpaca position already exists outside our tracking', {
            userId, symbol, realQty: existing.qty
        });
        return null;
    }

    const order = await axios.post(`${base}/orders`, {
        symbol, qty: String(quantity), side: 'buy', type: 'market', time_in_force: 'gtc'
    }, { headers });

    // Poll briefly for a fill — crypto market orders on liquid pairs fill fast,
    // same pattern as Blitz's equity polling.
    let filled = order.data;
    for (let i = 0; i < 5 && filled.status !== 'filled'; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const check = await axios.get(`${base}/orders/${order.data.id}`, { headers });
        filled = check.data;
    }

    if (filled.status !== 'filled') {
        logger.warn('[CryptoBot] Entry order not filled within poll window', { userId, symbol, status: filled.status });
        return null;
    }

    const fillPrice = parseFloat(filled.filled_avg_price);
    const filledQty = parseFloat(filled.filled_qty);
    const stopLossPrice = fillPrice * (1 - stopLossPercent / 100);
    const takeProfitPrice = fillPrice * (1 + takeProfitPercent / 100);

    // Retry + loud alert on failure — see file docstring. 3 attempts, 1.5s backoff,
    // matching the fix just applied to Blitz's equity path the same night.
    let stopPlaced = false;
    let precision = 8; // typical Alpaca crypto price-precision ceiling; narrowed below
                        // if a pair's real limit turns out to be stricter than that.
    // Alpaca crypto buys silently short the received base-asset qty vs.
    // filled_qty (found 2026-09-08: order said 71.382173 UNI filled, real
    // position was 71.203717567 — a clean 0.25% fee taken out of the asset,
    // not billed separately). sellCrypto already guards this with
    // Math.min(dbQty, realQty); buyCrypto didn't, so the stop order requested
    // more than the account actually held and failed every retry identically.
    // Adapt down to whatever Alpaca reports as actually available.
    let stopQty = filledQty;
    const STOP_RETRY_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= STOP_RETRY_ATTEMPTS && !stopPlaced; attempt++) {
        try {
            await _placeCryptoStopOrder(userId, symbol, stopQty, stopLossPrice, precision);
            stopPlaced = true;
            if (attempt > 1) logger.info('[CryptoBot] Protective stop placed on retry', { userId, symbol, attempt, precision, stopQty });
        } catch (stopErr) {
            const msg = stopErr.response?.data?.message || stopErr.message;
            // Same deterministic failure would otherwise repeat identically across
            // every retry (found 2026-09-08, all 3 attempts failed on the exact
            // same over-precise price / over-stated qty) — narrow to whatever
            // Alpaca reports as the real ceiling.
            const precisionMatch = /maximum precision of (\d+) decimal places/i.exec(msg);
            if (precisionMatch) precision = Math.min(precision, parseInt(precisionMatch[1], 10));
            const balanceMatch = /insufficient balance for \S+ \(requested: [\d.]+, available: ([\d.]+)\)/i.exec(msg);
            if (balanceMatch) stopQty = Math.min(stopQty, parseFloat(balanceMatch[1]));

            if (attempt < STOP_RETRY_ATTEMPTS) {
                logger.warn(`[CryptoBot] Stop placement attempt ${attempt}/${STOP_RETRY_ATTEMPTS} failed, retrying`, {
                    userId, symbol, err: msg, nextPrecision: precision, nextStopQty: stopQty
                });
                await new Promise(r => setTimeout(r, 1500));
            } else {
                logger.error('[CryptoBot] Failed to place protective stop after entry, all retries exhausted — position relies on software backstop only', {
                    userId, symbol, err: msg
                });
                try {
                    const tg = require('./telegramAlertService');
                    await tg.sendMessage(userId,
                        `⚠️ *Crypto Stop-Loss Warning*\n\n` +
                        `Bought ${filledQty} ${symbol} @ $${fillPrice.toFixed(2)}, but the protective stop order failed ` +
                        `${STOP_RETRY_ATTEMPTS}x in a row: ${msg}\n\n` +
                        `This position is running on the software-only backstop (checked every ~5min) instead of a ` +
                        `real broker-side stop until the next scan cycle. Consider checking it manually — crypto trades ` +
                        `24/7, this can't wait for market open.`
                    );
                } catch (_alertErr) { /* best-effort — never block the entry on alert failure */ }
            }
        }
    }

    // Record whatever quantity Alpaca actually confirmed as available (stopQty
    // only ever moves down from filledQty, and only on real broker feedback),
    // not the pre-fee filled_qty, so a later sellCrypto isn't sizing off a
    // number the account never really held.
    const position = await cryptoDb.openPosition(userId, symbol, {
        quantity: stopQty, price: fillPrice, stopLossPrice, takeProfitPrice, brokerOrderId: order.data.id
    });

    logger.info('[CryptoBot] Entry filled', { userId, symbol, qty: stopQty, fillPrice, stopLossPrice, takeProfitPrice });
    return position;
}

/**
 * Market-sell to close a crypto position. Same duplicate-close guard as
 * Blitz's sellIntraday (2026-08-15 incident that produced a naked short) --
 * re-verify a real position still exists on Alpaca immediately before
 * submitting, since userCycleMutex's lock has a bounded fail-open timeout
 * that a slow cancel+submit+poll sequence can exceed.
 */
async function sellCrypto(userId, symbol, { exitReason, scoreAtEntry }) {
    const position = await cryptoDb.getPosition(userId, symbol);
    if (!position) return null;

    const realPosition = await brokerService.getPosition(userId, _toPositionSymbol(symbol));
    if (!realPosition || parseFloat(realPosition.qty) <= 0) {
        logger.warn('[CryptoBot] Skipping sell — no real position on Alpaca (already closed by a prior call)', {
            userId, symbol, exitReason
        });

        // The position already really closed at Alpaca (almost always the real
        // resting stop order triggering) — look up that actual fill instead of
        // guessing from position.current_price, which can have drifted well away
        // from where the real order filled. Found 2026-09-12: two of these
        // stale_skip closures were off by $0.11-$0.11/unit (~$8-$26 of recorded
        // P&L) purely from using a stale cached price as a stand-in for a real
        // number that was one API call away the whole time.
        let exitPrice = parseFloat(position.current_price || position.average_price) || 0;
        let exitTime = null;
        try {
            const { base, headers } = await _getAuth(userId);
            const closedOrders = await axios.get(`${base}/orders`, {
                headers, params: { status: 'closed', symbols: symbol, direction: 'desc', limit: 5 }
            });
            const realFill = closedOrders.data.find(o => o.side === 'sell' && o.status === 'filled' && o.filled_avg_price);
            if (realFill) {
                exitPrice = parseFloat(realFill.filled_avg_price);
                exitTime = realFill.filled_at;
            }
        } catch (lookupErr) {
            logger.debug('[CryptoBot] Could not fetch real closing fill, using cached price estimate', {
                userId, symbol, error: lookupErr.message
            });
        }

        await cryptoDb.closePosition(userId, symbol, {
            exitPrice, exitTime, exitReason: `${exitReason}_stale_skip`, scoreAtEntry
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
        logger.warn('[CryptoBot] Could not cancel resting stop before sell', { userId, symbol, err: cancelErr.message });
    }

    const order = await axios.post(`${base}/orders`, {
        symbol, qty: String(sellQty), side: 'sell', type: 'market', time_in_force: 'gtc'
    }, { headers });

    let filled = order.data;
    for (let i = 0; i < 5 && filled.status !== 'filled'; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const check = await axios.get(`${base}/orders/${order.data.id}`, { headers });
        filled = check.data;
    }

    const exitPrice = filled.status === 'filled' ? parseFloat(filled.filled_avg_price) : parseFloat(position.current_price || position.average_price);

    const trade = await cryptoDb.closePosition(userId, symbol, { exitPrice, exitReason, scoreAtEntry });
    logger.info('[CryptoBot] Position closed', { userId, symbol, exitPrice, exitReason, pnl: trade?.pnl });
    return trade;
}

module.exports = { buyCrypto, sellCrypto };
