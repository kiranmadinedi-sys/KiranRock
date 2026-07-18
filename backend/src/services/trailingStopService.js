/**
 * Trailing Stop Service
 *
 * Runs every 5 minutes during market hours.
 * For each open position that has gained enough, raises the stop-loss
 * order on Alpaca so profits are locked in as the stock climbs.
 *
 * Trail schedule (locks in profits faster as gains grow):
 *   gain ≥  2% → stop at break-even (0%)
 *   gain ≥  5% → stop at gain − 2%  (+3%)
 *   gain ≥  8% → stop at gain − 3%  (+5%)
 *   gain ≥ 12% → stop at gain − 4%  (+8%)
 *   gain ≥ 15% → stop at gain − 4%  (+11%)
 *
 * Stops are only ever raised, never lowered.
 * All adjustments are logged; Telegram alert sent per adjustment.
 *
 * Bracket detection: uses Alpaca's parent_id field (set on bracket legs).
 * Standalone take-profit limit orders from fractional buys have no parent_id
 * and are treated as unprotected positions — a new stop is created and an
 * alert is fired if the original stop went missing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const axios      = require('axios');
const { logger } = require('../utils/logger');
const { query }  = require('../config/database');
const { isMarketOpen } = require('./enhancedAITradingBot');

const MIN_GAIN_TO_ACT    = 2;   // don't touch stop unless position is up at least this %

let _interval = null;
let _running  = false;

// ─── Alpaca helpers ───────────────────────────────────────────────────────────

async function _getCredsAndBase(userId) {
    const userDb = require('./userDatabaseService');
    const creds  = await userDb.getUserAlpacaCredentials(userId);
    const base   = creds.isPaper
        ? 'https://paper-api.alpaca.markets/v2'
        : 'https://api.alpaca.markets/v2';
    return { keyId: creds.keyId, secretKey: creds.secretKey, base };
}

function _headers(keyId, secretKey) {
    return {
        'APCA-API-KEY-ID':     keyId,
        'APCA-API-SECRET-KEY': secretKey,
        'Content-Type':        'application/json'
    };
}

async function _getOpenOrders(keyId, secretKey, base) {
    const resp = await axios.get(`${base}/orders`, {
        params:  { status: 'open', limit: 200 },
        headers: _headers(keyId, secretKey),
        timeout: 10000
    });
    return resp.data || [];
}

async function _replaceOrder(keyId, secretKey, base, orderId, newStopPrice) {
    await axios.patch(
        `${base}/orders/${orderId}`,
        { stop_price: String(parseFloat(newStopPrice.toFixed(2))) },
        { headers: _headers(keyId, secretKey), timeout: 10000 }
    );
}

async function _cancelOrder(keyId, secretKey, base, orderId) {
    await axios.delete(`${base}/orders/${orderId}`, {
        headers: _headers(keyId, secretKey),
        timeout: 10000
    });
}

async function _getPosition(keyId, secretKey, base, symbol) {
    try {
        const resp = await axios.get(`${base}/positions/${symbol}`, {
            headers: _headers(keyId, secretKey),
            timeout: 10000
        });
        return resp.data;
    } catch (err) {
        if (err.response?.status === 404) return null; // no position — the normal "already closed" case
        throw err;
    }
}

async function _createStopOrder(keyId, secretKey, base, symbol, qty, stopPrice) {
    // Alpaca does not support GTC stop orders for fractional quantities — use 'day' instead.
    // The trailing stop service re-places day stops on every cycle so fractional positions
    // stay protected throughout the trading session.
    const isFractional = qty !== Math.floor(qty);
    const tif = isFractional ? 'day' : 'gtc';
    const resp = await axios.post(`${base}/orders`, {
        symbol,
        qty:           String(qty),
        side:          'sell',
        type:          'stop',
        time_in_force: tif,
        stop_price:    String(parseFloat(stopPrice.toFixed(2)))
    }, { headers: _headers(keyId, secretKey), timeout: 10000 });
    return resp.data;
}

// ─── Trailing stop math ───────────────────────────────────────────────────────

/**
 * Given a % gain, return the stop target as a % above entry.
 * Locks in profits faster as the gain grows.
 * Returns null if the gain is not yet enough to warrant action.
 */
function targetStopPct(gainPct) {
    if (gainPct < MIN_GAIN_TO_ACT) return null;
    if (gainPct >= 15) return gainPct - 4;  // +15% gain → stop at +11%
    if (gainPct >= 12) return gainPct - 4;  // +12% gain → stop at +8%
    if (gainPct >=  8) return gainPct - 3;  // +8%  gain → stop at +5%
    if (gainPct >=  5) return gainPct - 2;  // +5%  gain → stop at +3%
    return 0;                               // +2%  gain → break-even
}

// ─── Core: adjust stops for one user ─────────────────────────────────────────

async function adjustForUser(userId) {
    // Load open holdings from DB
    const holdingsRes = await query(
        `SELECT symbol, quantity, average_price FROM holdings
         WHERE user_id = $1 AND quantity > 0`,
        [userId]
    );
    if (!holdingsRes.rows.length) return;

    let keyId, secretKey, base;
    try {
        ({ keyId, secretKey, base } = await _getCredsAndBase(userId));
    } catch (err) {
        logger.warn('[TrailingStop] Could not get Alpaca credentials', { userId, err: err.message });
        return;
    }
    if (!keyId || !secretKey) return;

    // Fetch current prices and open orders in parallel
    const dataProvider = require('./dataProvider');
    const openOrders   = await _getOpenOrders(keyId, secretKey, base).catch(() => []);

    for (const row of holdingsRes.rows) {
        const symbol    = row.symbol.toUpperCase();
        const entryPrice = parseFloat(row.average_price);
        if (!entryPrice || entryPrice <= 0) continue;

        // Current price
        let currentPrice;
        try {
            const q  = await dataProvider.getQuote(symbol);
            currentPrice = q.price || q.ask || 0;
        } catch {
            continue;
        }
        if (!currentPrice || currentPrice <= 0) continue;

        // Live position guard (2026-07-06 EAT incident): `holdingsRes` is a DB snapshot taken at
        // the top of this function. If the position's own stop fired in the moments between that
        // snapshot and this cycle reaching it, every "no stop found → place one" branch below would
        // treat a now-closed position as unprotected and place a fresh stop — which then sells into
        // shares the account no longer owns, opening a naked short. Confirm the position is still
        // actually live at the broker before any create-stop logic runs for this symbol.
        let livePositionQty = null;
        try {
            const livePosition = await _getPosition(keyId, secretKey, base, symbol);
            livePositionQty = livePosition ? parseFloat(livePosition.qty) : 0;
        } catch (err) {
            logger.debug('[TrailingStop] Live position check failed — proceeding with DB snapshot', { userId, symbol, err: err.message });
        }
        if (livePositionQty === 0) {
            logger.warn('[TrailingStop] Skipping — DB shows a holding but broker position is already closed', { userId, symbol });
            // The position closed since our DB snapshot — one of its exit orders (stop-loss
            // or, for fractional buys, a standalone take-profit with no OCO link) just
            // filled. Fractional positions place stop and take-profit as two INDEPENDENT
            // GTC orders (see buyFractional in brokerService.js — Alpaca's bracket order
            // class doesn't support notional/fractional orders), so there's no native OCO
            // to auto-cancel the sibling. Left alone, it sits open and can later fire
            // against zero shares, opening a naked short — exactly how EAT and the EXC/CL
            // orphans happened. Cancel any sell orders still open for this symbol right
            // here, on the very next polling cycle, rather than waiting on the separate
            // reconciler to catch it after the fact (raised via review, 2026-07-11).
            const leftoverOrders = openOrders.filter(o => o.symbol === symbol && o.side === 'sell');
            for (const leftover of leftoverOrders) {
                try {
                    await _cancelOrder(keyId, secretKey, base, leftover.id);
                    logger.info('[TrailingStop] Cancelled orphaned sibling order after position closed', {
                        userId, symbol, orderId: leftover.id, type: leftover.type
                    });
                    // Alpaca's cancel is async and can land in 'pending_cancel' without ever
                    // resolving (observed with EXC/CL) — verify and retry once if it didn't take.
                    await new Promise(r => setTimeout(r, 1500));
                    const afterCancel = await _getOpenOrders(keyId, secretKey, base).catch(() => []);
                    const stillThere = afterCancel.find(o => o.id === leftover.id);
                    if (stillThere && stillThere.status !== 'canceled') {
                        logger.warn('[TrailingStop] Sibling cancel did not resolve — retrying once', {
                            userId, symbol, orderId: leftover.id, status: stillThere.status
                        });
                        await _cancelOrder(keyId, secretKey, base, leftover.id).catch(() => {});
                    }
                } catch (err) {
                    logger.warn('[TrailingStop] Failed to cancel orphaned sibling order — reconciler is the fallback', {
                        userId, symbol, orderId: leftover.id, err: err.message
                    });
                }
            }
            continue;
        }

        const gainPct    = ((currentPrice - entryPrice) / entryPrice) * 100;
        const isFractional = parseFloat(row.quantity) !== Math.floor(parseFloat(row.quantity));

        // Find ALL open sell orders for this symbol (stop legs + bracket/standalone take-profit legs)
        const allSellOrders = openOrders.filter(o => o.symbol === symbol && o.side === 'sell');
        const stopOrders    = allSellOrders.filter(o => o.type === 'stop' || o.type === 'stop_limit');

        // DAY-TIF exit legs expire at market close and take their OCO sibling stop down with
        // them — true for fractional standalone stops, AND, it turns out, whole-share bracket
        // legs too (Alpaca brackets default to "day", not GTC, despite buyBracket()'s comments
        // assuming otherwise). This used to run only for fractional positions, and only after
        // the gain >= MIN_GAIN_TO_ACT gate below — so a flat/red whole-share position whose
        // bracket expired overnight had no path back to protection until it moved 2%+ in its
        // favor. Confirmed 2026-07-18 via live Alpaca order history: ROP/TOST/TMUS brackets all
        // expired together ~20:05 UTC the day they were bought, leaving real live-account
        // positions naked with no alert. Runs for every open position, unconditional on gain.
        if (stopOrders.length === 0) {
            // A bracket take-profit leg still open (parent_id set) means the bracket is still
            // active and its stop leg may simply not have propagated to this listing yet —
            // don't race it with a redundant standalone stop.
            const bracketLegs = allSellOrders.filter(o => o.type === 'limit' && o.parent_id);
            if (bracketLegs.length === 0) {
                // 5%, matching the bot's current hard-stop default (enhancedAITradingBot.js's
                // riskConfig.stopLoss — tightened from 7% to 5% on 2026-07-02). This fallback
                // predates that tightening and was still using the old 7% until now.
                const renewStop = parseFloat((entryPrice * (1 - 0.05)).toFixed(2));
                const safeStop  = renewStop >= currentPrice ? parseFloat((currentPrice * 0.97).toFixed(2)) : renewStop;
                logger.warn('[TrailingStop] No active stop for open position — placing protective stop', {
                    userId, symbol, isFractional, safeStop
                });
                try {
                    await _createStopOrder(keyId, secretKey, base, symbol, parseFloat(row.quantity), safeStop);
                    await _sendAlert(userId, symbol, null, safeStop, gainPct, currentPrice, 'PLACED');
                } catch (err) {
                    logger.warn('[TrailingStop] Failed to place protective stop', { userId, symbol, err: err.message });
                }
                continue; // fresh stop placed this cycle — next cycle can consider trailing it further
            }
        } else {
            // Explicit confirmation, not just silence — Monday's first post-restart cycle is the
            // validation run for the GTC bracket fix, and "nothing happened because everything's
            // fine" needs to look different in the logs than "nothing happened because the cycle
            // never ran." Debug-level since this fires every symbol, every 5 minutes.
            logger.debug('[TrailingStop] Existing stop confirmed — no repair needed', {
                userId, symbol, stopCount: stopOrders.length
            });
        }

        const stopTarget = targetStopPct(gainPct);
        if (stopTarget === null) continue; // position hasn't moved enough to raise the stop

        const newStopPrice = parseFloat((entryPrice * (1 + stopTarget / 100)).toFixed(2));

        for (const stopOrder of stopOrders) {
            const currentStopPrice = parseFloat(stopOrder.stop_price || 0);
            if (newStopPrice <= currentStopPrice) {
                // Stop already at or above our target — nothing to do
                logger.debug('[TrailingStop] Stop already adequate', {
                    userId, symbol, currentStop: currentStopPrice, target: newStopPrice
                });
                continue;
            }

            logger.info('[TrailingStop] Raising stop', {
                userId, symbol,
                from:  currentStopPrice.toFixed(2),
                to:    newStopPrice.toFixed(2),
                gain:  gainPct.toFixed(1) + '%',
                price: currentPrice.toFixed(2)
            });

            // Try replaceOrder first (works on simple stop orders).
            // If Alpaca rejects (bracket legs can't always be replaced), fall back to cancel+create.
            let replaced = false;
            try {
                await _replaceOrder(keyId, secretKey, base, stopOrder.id, newStopPrice);
                replaced = true;
            } catch (err) {
                const status = err.response?.status;
                logger.debug('[TrailingStop] replaceOrder failed, trying cancel+create', {
                    userId, symbol, status, err: err.message
                });
            }

            if (!replaced) {
                try {
                    await _cancelOrder(keyId, secretKey, base, stopOrder.id);
                    await _createStopOrder(keyId, secretKey, base, symbol, row.quantity, newStopPrice);
                } catch (err) {
                    logger.warn('[TrailingStop] cancel+create also failed', {
                        userId, symbol, err: err.message
                    });
                    continue;
                }
            }

            await _sendAlert(userId, symbol, currentStopPrice, newStopPrice, gainPct, currentPrice, 'RAISED');
        }
    }
}

// ─── Telegram alert ───────────────────────────────────────────────────────────

async function _sendAlert(userId, symbol, oldStop, newStop, gainPct, price, action) {
    try {
        const alertService = require('./telegramAlertService');
        const gainStr = gainPct.toFixed(1);
        const oldStr  = oldStop != null ? `$${oldStop.toFixed(2)}` : '—';
        const icon    = action === 'RAISED'     ? '🔺'
                      : action === 'RECREATED'  ? '⚠️'
                      :                           '🛡️';
        const subtitle = action === 'RAISED'
            ? `Profit floor raised — ${gainStr}% gain protected`
            : action === 'RECREATED'
            ? `Stop was missing — recreated at $${newStop.toFixed(2)} (position now protected)`
            : `Protective stop placed at break-even`;

        const userRes  = await query('SELECT username FROM users WHERE id = $1', [userId]).catch(() => ({ rows: [] }));
        const username = userRes.rows[0]?.username || userId;

        const msg = [
            `${icon} *Trailing Stop ${action}* — ${symbol} (${username})`,
            `Current price: $${parseFloat(price).toFixed(2)}  (+${gainStr}%)`,
            `Stop: ${oldStr} → *$${newStop.toFixed(2)}*`,
            `_${subtitle}_`
        ].join('\n');
        await alertService.sendMessage(userId, msg);
    } catch { /* alert failure must not break the service */ }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────

async function runCycle() {
    if (_running) return;
    if (!isMarketOpen()) return;

    _running = true;
    try {
        const usersRes = await query(
            `SELECT id FROM users WHERE ai_trading_enabled = true`
        );
        const broker = (process.env.BROKER || 'simulated').toLowerCase();
        if (broker !== 'alpaca') return;

        for (const { id: userId } of usersRes.rows) {
            try {
                await adjustForUser(userId);
            } catch (err) {
                logger.warn('[TrailingStop] Error for user', { userId, err: err.message });
            }
        }
    } catch (err) {
        logger.error('[TrailingStop] Cycle error', { err: err.message });
    } finally {
        _running = false;
    }
}

function startTrailingStopService() {
    if (_interval) return;
    logger.info('[TrailingStop] Service started (5-min cycle, market hours only)');
    // First run after 2 minutes (give the bot time to place initial orders)
    setTimeout(runCycle, 2 * 60 * 1000);
    _interval = setInterval(runCycle, 5 * 60 * 1000);
}

function stopTrailingStopService() {
    if (_interval) {
        clearInterval(_interval);
        _interval = null;
        logger.info('[TrailingStop] Service stopped');
    }
}

/**
 * Fetch open stop/take-profit orders for a user from Alpaca.
 * Returns a map: symbol → { stopPrice, targetPrice, stopLocked (bool) }
 * stopLocked = true means the stop is at or above entry price (profits are protected).
 */
async function getStopOrders(userId) {
    const result = {};
    try {
        const { keyId, secretKey, base } = await _getCredsAndBase(userId);
        if (!keyId || !secretKey) return result;

        const holdingsRes = await query(
            `SELECT symbol, average_price FROM holdings WHERE user_id = $1 AND quantity > 0`,
            [userId]
        );
        const entryMap = {};
        for (const r of holdingsRes.rows) entryMap[r.symbol.toUpperCase()] = parseFloat(r.average_price);

        const openOrders = await _getOpenOrders(keyId, secretKey, base);

        for (const order of openOrders) {
            const sym = (order.symbol || '').toUpperCase();
            if (!entryMap[sym]) continue;

            if (order.side === 'sell') {
                if (!result[sym]) result[sym] = { stopPrice: null, targetPrice: null };
                if (order.type === 'stop' || order.type === 'stop_limit') {
                    const sp = parseFloat(order.stop_price || 0);
                    if (sp > 0) {
                        result[sym].stopPrice  = sp;
                        result[sym].stopLocked = sp >= entryMap[sym]; // at/above entry = locked
                    }
                }
                if (order.type === 'limit') {
                    const lp = parseFloat(order.limit_price || 0);
                    if (lp > 0) result[sym].targetPrice = lp;
                }
            }
        }
    } catch (err) {
        logger.warn('[TrailingStop] getStopOrders failed', { userId, err: err.message });
    }
    return result;
}

module.exports = { startTrailingStopService, stopTrailingStopService, runCycle, getStopOrders };
