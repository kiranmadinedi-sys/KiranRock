/**
 * Broker Abstraction Layer
 * =========================
 * Switch between brokers by changing BROKER in .env:
 *
 *   BROKER=simulated  — paper trades stored in our own PostgreSQL (default, works now)
 *   BROKER=alpaca     — real orders sent to Alpaca Markets (paper or live)
 *
 * SAFETY: BROKER=alpaca with ALPACA_PAPER=false = REAL MONEY.
 *         Only enable after 6 months of validated paper trading.
 *
 * All trading bot code calls brokerService — never tradingServiceDB directly.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { logger } = require('../utils/logger');
const { getGlobalTradingControl, getUserTradingControls } = require('./tradingControlService');
const { query } = require('../config/database');

// ─── ARROW ORDER AUDIT LOG ────────────────────────────────────────────────────
// Append-only per PANTHEON spec — never UPDATE or DELETE rows.
// Full state machine:
//   CREATED → VALIDATED → SUBMITTED → PENDING_FILL
//   → PARTIALLY_FILLED → FILLED → OPEN_WITH_STOP
//   → STOPPED (stop leg hit) / CLOSED (target hit) / CLOSED_MANUAL (manual exit)
//   → JOURNALED
//   REJECTED (terminal) / CANCELED (terminal)

async function logOrderState(idempotencyKey, userId, symbol, state, previousState, meta = {}) {
    try {
        await query(
            `INSERT INTO order_audit_log
             (idempotency_key, user_id, symbol, state, previous_state, broker, broker_order_id, quantity, price, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
                idempotencyKey,
                String(userId),
                symbol,
                state,
                previousState || null,
                meta.broker        || null,
                meta.brokerOrderId || null,
                meta.quantity != null ? parseFloat(meta.quantity) : null,
                meta.price         || null,
                JSON.stringify(meta.extra || {})
            ]
        );
    } catch (err) {
        // Audit log failure must never block trading
        logger.warn('[ARROW] audit_log write failed', { idempotencyKey, state, err: err.message });
    }
}

async function isOrderAlreadySubmitted(idempotencyKey) {
    try {
        const res = await query(
            `SELECT 1 FROM order_audit_log WHERE idempotency_key=$1 AND state='SUBMITTED' LIMIT 1`,
            [idempotencyKey]
        );
        return res.rows.length > 0;
    } catch {
        return false; // fail open — don't block on audit log issues
    }
}

const BROKER = (process.env.BROKER || 'simulated').toLowerCase();
const BOT_ENABLED = process.env.BOT_ENABLED !== 'false';
const MAX_BOT_INVESTMENT = parseFloat(process.env.MAX_BOT_INVESTMENT_USD || '5000');

logger.info(`[Broker] Using broker: ${BROKER.toUpperCase()} | BotEnabled: ${BOT_ENABLED} | MaxInvestment: $${MAX_BOT_INVESTMENT}`);

// ─── SAFETY GATE ─────────────────────────────────────────────────────────────
async function safetyCheck(userId, symbol, quantity, estimatedPrice, options = {}) {
    const {
        requireAiEnabled = true,
        requireBotEnabled = true,
        enforceNotionalLimit = true
    } = options;

    const globalControl = await getGlobalTradingControl();
    if (!globalControl.globalTradingEnabled) {
        throw new Error(`Global trading kill switch active${globalControl.killSwitchReason ? `: ${globalControl.killSwitchReason}` : ''}`);
    }

    const userControls = await getUserTradingControls(userId);
    if (requireAiEnabled && !userControls.aiTradingEnabled) {
        throw new Error('AI trading is disabled for this user. Enable it before placing orders.');
    }

    if (userControls.emergencyStopEnabled) {
        throw new Error('User emergency stop is enabled. Disable it before placing orders.');
    }

    if (requireBotEnabled && !BOT_ENABLED) {
        throw new Error('Bot is disabled. Set BOT_ENABLED=true in .env to enable trading.');
    }

    const estimatedCost = quantity * estimatedPrice;
    if (requireBotEnabled && estimatedCost > MAX_BOT_INVESTMENT) {
        throw new Error(
            `Order rejected: estimated cost $${estimatedCost.toFixed(2)} exceeds MAX_BOT_INVESTMENT_USD $${MAX_BOT_INVESTMENT}`
        );
    }

    if (enforceNotionalLimit && userControls.maxOrderNotional > 0 && estimatedCost > userControls.maxOrderNotional) {
        throw new Error(
            `Order rejected: estimated cost $${estimatedCost.toFixed(2)} exceeds maxOrderNotional $${userControls.maxOrderNotional.toFixed(2)}`
        );
    }
}

// ─── SIMULATED BROKER (uses our DB) ──────────────────────────────────────────
const simulatedBroker = (() => {
    const tradingServiceDB = require('./tradingServiceDB');

    async function buyMarket(userId, symbol, quantity, meta = {}) {
        const price = await tradingServiceDB.getCurrentPrice(symbol);
        await safetyCheck(userId, symbol, quantity, price || 0, meta.safetyOptions);

        logger.info('[Broker:Simulated] BUY order', { symbol, quantity, estimatedPrice: price, meta });

        const result = await tradingServiceDB.executeBuyOrder(
            userId, symbol, quantity,
            meta.executedBy || 'AI_BOT',
            meta.aiScore    || null,
            meta.sector     || null
        );

        return {
            orderId:   `SIM-${Date.now()}`,
            symbol,
            side:      'buy',
            qty:       quantity,
            filledQty: quantity,
            filledAvgPrice: result.price,
            status:    'filled',
            total:     result.total,
            commission: result.commission,
            broker:    'simulated'
        };
    }

    async function buyBracket(userId, symbol, quantity, meta = {}) {
        // Simulated broker has no native bracket support — mirrors as a regular buy
        return buyMarket(userId, symbol, quantity, meta);
    }

    async function sellMarket(userId, symbol, quantity, meta = {}) {
        logger.info('[Broker:Simulated] SELL order', { symbol, quantity, meta });

        const result = await tradingServiceDB.executeSellOrder(
            userId, symbol, quantity,
            meta.executedBy || 'AI_BOT',
            meta.reason     || ''
        );

        return {
            orderId:   `SIM-${Date.now()}`,
            symbol,
            side:      'sell',
            qty:       quantity,
            filledQty: quantity,
            filledAvgPrice: result.price,
            status:    'filled',
            total:     result.total,
            commission: result.commission,
            broker:    'simulated'
        };
    }

    async function getAccountInfo(userId) {
        const accountDb = require('./tradingAccountDatabaseService');
        const account = await accountDb.getTradingAccount(userId);
        return {
            cashBalance:    parseFloat(account.balance),
            portfolioValue: parseFloat(account.portfolio_value || account.balance),
            buyingPower:    parseFloat(account.balance),
            broker:         'simulated'
        };
    }

    async function getPositions(userId) {
        const holdingsDb = require('./holdingsDatabaseService');
        const holdings = await holdingsDb.getUserHoldings(userId);
        return holdings.map(h => ({
            symbol:       h.symbol,
            qty:          parseInt(h.quantity),
            avgEntryPrice: parseFloat(h.average_price),
            currentPrice:  parseFloat(h.current_price || h.average_price),
            marketValue:   parseFloat(h.market_value  || 0),
            unrealizedPL:  parseFloat(h.gain_loss     || 0)
        }));
    }

    // Simulated broker has no concept of open orders — always returns empty
    async function getOpenOrders() { return []; }
    async function placeStopOrder() { return null; }
    async function cancelOrder() { return null; }

    // Simulated broker: check DB holdings as a proxy for "has position"
    async function getPosition(userId, symbol) {
        try {
            const holdingsDb = require('./holdingsDatabaseService');
            const holdings   = await holdingsDb.getUserHoldings(userId);
            const holding    = holdings.find(h => h.symbol.toUpperCase() === symbol.toUpperCase());
            if (!holding || parseInt(holding.quantity) <= 0) return null;
            return { symbol, qty: parseInt(holding.quantity), avg_entry_price: parseFloat(holding.average_price) };
        } catch { return null; }
    }

    return { buyMarket, buyBracket, sellMarket, getAccountInfo, getPositions, getOpenOrders, getPosition, placeStopOrder, cancelOrder, name: 'Simulated (Paper DB)' };
})();

// ─── ALPACA BROKER ────────────────────────────────────────────────────────────
const alpacaBroker = (() => {
    const userDb = require('./userDatabaseService');

    // Per-user client factory — reads personal credentials from DB, falls back to .env.
    // No singleton: credentials can change at runtime when a user saves new keys.
    async function getClientForUser(userId) {
        const creds = await userDb.getUserAlpacaCredentials(userId);
        if (!creds.keyId || !creds.secretKey) {
            throw new Error('Alpaca keys not configured. Add ALPACA_KEY_ID / ALPACA_SECRET_KEY to .env or save them in Profile → Broker Settings.');
        }
        const Alpaca = require('@alpacahq/alpaca-trade-api');
        const client = new Alpaca({ keyId: creds.keyId, secretKey: creds.secretKey, paper: creds.isPaper });
        logger.info('[Broker:Alpaca] Client created', { userId, paper: creds.isPaper, source: creds.source });
        return { client, isPaper: creds.isPaper };
    }

    async function buyMarket(userId, symbol, quantity, meta = {}) {
        // Estimate price for safety check (use last trade price)
        const dataProvider = require('./dataProvider');
        const quote = await dataProvider.getQuote(symbol);
        await safetyCheck(userId, symbol, quantity, quote.price || 0, meta.safetyOptions);

        const { client, isPaper } = await getClientForUser(userId);

        logger.info('[Broker:Alpaca] Submitting BUY order', {
            symbol, quantity, paper: isPaper, estimatedPrice: quote.price
        });

        // PANTHEON: limit orders only — never market orders.
        // Limit price is set 0.5% above ask to ensure fill while avoiding slippage surprise.
        const limitPrice = parseFloat(((quote.price || quote.ask || quote.bid || 0) * 1.005).toFixed(2));
        const order = await client.createOrder({
            symbol,
            qty:           quantity,
            side:          'buy',
            type:          'limit',
            limit_price:   limitPrice,
            time_in_force: 'day'
        });

        // Wait for fill (poll up to 15 seconds)
        const filled = await waitForFill(client, order.id, 15000);

        // Mirror the trade in our DB for portfolio tracking
        const tradingServiceDB = require('./tradingServiceDB');
        await tradingServiceDB.executeBuyOrder(
            userId, symbol, quantity,
            `ALPACA_${isPaper ? 'PAPER' : 'LIVE'}`,
            meta.aiScore || null,
            meta.sector  || null
        );

        const buyMarketFinalStatus = filled.status || 'submitted';
        const buyMarketFilledQty   = filled.filled_qty
            ? parseInt(filled.filled_qty)
            : (buyMarketFinalStatus === 'filled' ? quantity : 0);

        return {
            orderId:        order.id,
            symbol,
            side:           'buy',
            qty:            quantity,
            filledQty:      buyMarketFilledQty,
            filledAvgPrice: filled.filled_avg_price ? parseFloat(filled.filled_avg_price) : quote.price,
            status:         buyMarketFinalStatus,
            broker:         isPaper ? 'alpaca-paper' : 'alpaca-live'
        };
    }

    async function buyBracket(userId, symbol, quantity, meta = {}) {
        // Atomic bracket order: entry limit + stop-loss + take-profit in one submission.
        // PANTHEON ARROW spec: always use bracket for new equity entries.
        // Key is stable for the full trading day per user+symbol — aiScore must NOT be
        // included because it changes each bot cycle, which caused the order-storm bug
        // where hundreds of re-submissions bypassed the idempotency gate.
        const idemKey = meta.idempotencyKey || `${symbol}:${new Date().toISOString().slice(0,10)}:${userId}:buy`;

        // ARROW idempotency gate — never re-submit an already-submitted order
        if (await isOrderAlreadySubmitted(idemKey)) {
            logger.warn('[ARROW] Duplicate submission blocked', { idemKey, symbol });
            throw new Error(`Duplicate order blocked: ${idemKey}`);
        }

        await logOrderState(idemKey, userId, symbol, 'CREATED', null, { quantity });

        const dataProvider = require('./dataProvider');
        const quote = await dataProvider.getQuote(symbol);
        await safetyCheck(userId, symbol, quantity, quote.price || 0, meta.safetyOptions);

        await logOrderState(idemKey, userId, symbol, 'VALIDATED', 'CREATED', { quantity, price: quote.price });

        const { client, isPaper } = await getClientForUser(userId);

        // Cash guard — never buy with margin. Check actual Alpaca cash before submitting.
        // Alpaca automatically extends margin if we don't check, running the account negative.
        try {
            const acctInfo = await client.getAccount();
            const availableCash = parseFloat(acctInfo.cash);
            const orderCost = (quote.price || 0) * quantity * 1.01; // 1% buffer for limit slippage
            if (availableCash < orderCost) {
                logger.warn('[Broker:Alpaca] Cash guard blocked order — insufficient cash (no margin)', {
                    symbol, quantity, orderCost: orderCost.toFixed(2), availableCash: availableCash.toFixed(2)
                });
                await logOrderState(idemKey, userId, symbol, 'REJECTED', 'VALIDATED', {
                    reason: `Cash guard: need $${orderCost.toFixed(2)}, have $${availableCash.toFixed(2)} cash`
                });
                throw new Error(`Cash guard: insufficient cash ($${availableCash.toFixed(2)}) for $${orderCost.toFixed(2)} order — margin blocked`);
            }
        } catch (cashErr) {
            if (cashErr.message.startsWith('Cash guard')) throw cashErr;
            logger.warn('[Broker:Alpaca] Could not verify cash balance — proceeding with caution', { err: cashErr.message });
        }

        const entryLimit  = parseFloat(((quote.price || quote.ask || 0) * 1.005).toFixed(2));
        const stopPrice   = meta.stopPrice  > 0 ? parseFloat(meta.stopPrice.toFixed(2))  : parseFloat((entryLimit * 0.93).toFixed(2));
        const targetPrice = meta.targetPrice > 0 ? parseFloat(meta.targetPrice.toFixed(2)) : parseFloat((entryLimit * 1.10).toFixed(2));

        logger.info('[Broker:Alpaca] Submitting BRACKET order', {
            symbol, quantity, entryLimit, stopPrice, targetPrice, paper: isPaper
        });

        await logOrderState(idemKey, userId, symbol, 'SUBMITTED', 'VALIDATED', {
            broker: isPaper ? 'alpaca-paper' : 'alpaca-live', quantity, price: entryLimit,
            extra: { stopPrice, targetPrice }
        });

        const order = await client.createOrder({
            symbol,
            qty:           quantity,
            side:          'buy',
            type:          'limit',
            limit_price:   entryLimit,
            time_in_force: 'day',
            order_class:   'bracket',
            stop_loss:     { stop_price: stopPrice },
            take_profit:   { limit_price: targetPrice }
        });

        const filled = await waitForFill(client, order.id, 15000);

        const finalStatus = filled.status || 'submitted';
        const brokerLabel = isPaper ? 'alpaca-paper' : 'alpaca-live';

        // Only count shares that Alpaca confirms were actually executed.
        // When the order is still pending after the 15-second window, filledQty
        // is 0 rather than falling back to the requested quantity.  The open-order
        // guard (checked before every new buy) prevents re-submission while the
        // order sits live on Alpaca, so no phantom holding is needed here.
        const filledQty = filled.filled_qty ? parseInt(filled.filled_qty) : (finalStatus === 'filled' ? quantity : 0);
        const fillPrice = filled.filled_avg_price ? parseFloat(filled.filled_avg_price) : entryLimit;

        if (finalStatus === 'partially_filled') {
            await logOrderState(idemKey, userId, symbol, 'PARTIALLY_FILLED', 'SUBMITTED', {
                brokerOrderId: order.id, price: fillPrice, quantity: filledQty, broker: brokerLabel,
                extra: { requestedQty: quantity, filledQty, stopPrice, targetPrice }
            });
        } else if (finalStatus === 'filled') {
            await logOrderState(idemKey, userId, symbol, 'FILLED', 'SUBMITTED', {
                brokerOrderId: order.id, price: fillPrice, quantity: filledQty, broker: brokerLabel
            });
            // Bracket stop/take-profit legs are now live on Alpaca and survive server downtime
            await logOrderState(idemKey, userId, symbol, 'OPEN_WITH_STOP', 'FILLED', {
                brokerOrderId: order.id, broker: brokerLabel,
                extra: { stopPrice, targetPrice, entryPrice: fillPrice }
            });
        } else {
            // Order is pending on Alpaca (bracket legs not yet active).
            // The open-order guard prevents re-submission on the next cycle.
            await logOrderState(idemKey, userId, symbol, 'PENDING_FILL', 'SUBMITTED', {
                brokerOrderId: order.id, price: entryLimit, quantity, broker: brokerLabel
            });
        }

        // Only mirror to trades/holdings when shares were actually executed
        if (filledQty > 0) {
            const tradingServiceDB = require('./tradingServiceDB');
            await tradingServiceDB.executeBuyOrder(
                userId,
                symbol,
                filledQty,
                `ALPACA_${isPaper ? 'PAPER' : 'LIVE'}`,
                meta.aiScore  || null,
                meta.sector   || null,
                JSON.stringify({
                    signalPrice:   meta.signalPrice   || entryLimit,
                    regime:        meta.regime        || null,
                    oraclePattern: meta.oraclePattern || null,
                    stopPrice,
                    targetPrice,
                    bracketOrder: true
                }),
                fillPrice
            ).catch(err => {
                // DB write failed AFTER the broker order was confirmed filled.
                // Log at error level and fire a Telegram alert — morning reconciliation
                // will catch this as a SHADOW position and insert the DB record, but
                // the operator needs to know immediately so they can verify.
                logger.error('[Broker:Alpaca] buyBracket DB record failed — order filled but not in DB', {
                    symbol, filledQty, fillPrice, orderId: order.id, err: err.message
                });
                try {
                    const alertSvc = require('./telegramAlertService');
                    alertSvc.sendMessage(
                        userId,
                        `⚠️ *DB Write Failure After Fill*\n` +
                        `${symbol}: ${filledQty} shares filled @ $${fillPrice.toFixed(2)} but DB record failed.\n` +
                        `Order: \`${order.id}\`\n` +
                        `_Morning reconciliation will auto-fix. Verify position on Alpaca._`
                    ).catch(() => {});
                } catch (_) {}
            });
        }

        return {
            orderId:        order.id,
            symbol,
            side:           'buy',
            qty:            quantity,
            filledQty,
            filledAvgPrice: fillPrice,
            status:         finalStatus,
            stopPrice,
            targetPrice,
            broker:         brokerLabel
        };
    }

    async function buyFractional(userId, symbol, notionalAmount, meta = {}) {
        // Notional (dollar-amount) market buy for positions where Kelly sizing rounds to 0 whole shares.
        // After fill: places standalone stop-loss GTC + take-profit limit GTC.
        // The trailing stop service raises the stop-loss exactly as it does for whole-share positions
        // (standalone stop orders, not bracket legs — no extra handling needed there).
        const idemKey = meta.idempotencyKey || `${symbol}:${new Date().toISOString().slice(0,10)}:${userId}:frac`;

        if (await isOrderAlreadySubmitted(idemKey)) {
            logger.warn('[ARROW] Duplicate fractional submission blocked', { idemKey, symbol });
            throw new Error(`Duplicate order blocked: ${idemKey}`);
        }

        await logOrderState(idemKey, userId, symbol, 'CREATED', null, { notionalAmount, fractional: true });

        const { client, isPaper } = await getClientForUser(userId);
        const brokerLabel = isPaper ? 'alpaca-paper' : 'alpaca-live';

        const stopPrice   = meta.stopPrice   > 0 ? parseFloat(meta.stopPrice.toFixed(2))   : null;
        const targetPrice = meta.targetPrice > 0 ? parseFloat(meta.targetPrice.toFixed(2)) : null;

        logger.info('[Broker:Alpaca] Submitting FRACTIONAL notional buy', {
            symbol, notional: notionalAmount.toFixed(2), stopPrice, targetPrice, paper: isPaper
        });

        await logOrderState(idemKey, userId, symbol, 'SUBMITTED', 'CREATED', {
            broker: brokerLabel, notionalAmount, extra: { stopPrice, targetPrice, fractional: true }
        });

        const order = await client.createOrder({
            symbol,
            notional:      notionalAmount.toFixed(2),
            side:          'buy',
            type:          'market',
            time_in_force: 'day'
        });

        const filled = await waitForFill(client, order.id, 15000);
        const finalStatus = filled.status || 'submitted';
        // parseFloat (not parseInt) — fractional qty like 0.15 would truncate to 0 with parseInt
        const filledQty   = filled.filled_qty       ? parseFloat(filled.filled_qty)       : 0;
        const fillPrice   = filled.filled_avg_price ? parseFloat(filled.filled_avg_price) : 0;

        await logOrderState(idemKey, userId, symbol,
            finalStatus === 'filled' ? 'FILLED' : 'PENDING_FILL', 'SUBMITTED', {
            brokerOrderId: order.id, price: fillPrice, quantity: filledQty, broker: brokerLabel,
            extra: { notionalAmount, fractional: true }
        });

        if (filledQty > 0) {
            const effectiveStop   = stopPrice   || parseFloat((fillPrice * 0.96).toFixed(2));
            const effectiveTarget = targetPrice || parseFloat((fillPrice * 1.10).toFixed(2));
            const qtyStr = String(filledQty);

            // Standalone stop-loss GTC — trailing stop service raises this as the position gains
            try {
                await client.createOrder({
                    symbol, qty: qtyStr, side: 'sell', type: 'stop',
                    time_in_force: 'gtc', stop_price: String(effectiveStop)
                });
                logger.info('[Broker:Alpaca] Fractional stop-loss placed', {
                    symbol, qty: filledQty, stopPrice: effectiveStop
                });
            } catch (err) {
                logger.warn('[Broker:Alpaca] Fractional stop-loss failed', { symbol, err: err.message });
            }

            // Take-profit limit GTC
            try {
                await client.createOrder({
                    symbol, qty: qtyStr, side: 'sell', type: 'limit',
                    time_in_force: 'gtc', limit_price: String(effectiveTarget)
                });
                logger.info('[Broker:Alpaca] Fractional take-profit placed', {
                    symbol, qty: filledQty, targetPrice: effectiveTarget
                });
            } catch (err) {
                logger.warn('[Broker:Alpaca] Fractional take-profit failed', { symbol, err: err.message });
            }

            await logOrderState(idemKey, userId, symbol, 'OPEN_WITH_STOP', 'FILLED', {
                brokerOrderId: order.id, broker: brokerLabel,
                extra: { stopPrice: effectiveStop, targetPrice: effectiveTarget, entryPrice: fillPrice, fractional: true }
            });

            const tradingServiceDB = require('./tradingServiceDB');
            await tradingServiceDB.executeBuyOrder(
                userId, symbol, filledQty,
                `ALPACA_${isPaper ? 'PAPER' : 'LIVE'}_FRAC`,
                meta.aiScore || null, meta.sector || null,
                JSON.stringify({
                    signalPrice:   meta.signalPrice   || fillPrice,
                    regime:        meta.regime        || null,
                    oraclePattern: meta.oraclePattern || null,
                    stopPrice:     effectiveStop,
                    targetPrice:   effectiveTarget,
                    fractional:    true
                }),
                fillPrice
            ).catch(err => {
                logger.error('[Broker:Alpaca] buyFractional DB record failed — order filled but not in DB', {
                    symbol, filledQty, fillPrice, orderId: order.id, err: err.message
                });
            });
        }

        return {
            orderId:        order.id,
            symbol,
            side:           'buy',
            notional:       notionalAmount,
            filledQty,
            filledAvgPrice: fillPrice,
            status:         finalStatus,
            stopPrice:      meta.stopPrice   || null,
            targetPrice:    meta.targetPrice || null,
            broker:         brokerLabel,
            fractional:     true
        };
    }

    async function sellMarket(userId, symbol, quantity, meta = {}) {
        const idemKey = meta.idempotencyKey || `${symbol}:${new Date().toISOString().slice(0,10)}:sell:${meta.reason?.slice(0,20) || 'exit'}`;
        await logOrderState(idemKey, userId, symbol, 'CREATED', null, { quantity });

        const { client, isPaper } = await getClientForUser(userId);

        // Cancel any open orders for this symbol before selling — stop-loss orders lock
        // all shares (held_for_orders = qty) and cause Alpaca to reject new sell orders
        // with error 40310000 ("insufficient qty available").
        // Use raw REST API (not SDK) to avoid parameter-format differences between SDK versions.
        try {
            const axios = require('axios');
            const creds = await userDb.getUserAlpacaCredentials(userId);
            const baseUrl = creds.isPaper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
            const headers = { 'APCA-API-KEY-ID': creds.keyId, 'APCA-API-SECRET-KEY': creds.secretKey };
            const { data: openOrders } = await axios.get(
                `${baseUrl}/v2/orders?status=open&symbols=${encodeURIComponent(symbol)}&limit=50`,
                { headers }
            );
            for (const o of openOrders) {
                await axios.delete(`${baseUrl}/v2/orders/${o.id}`, { headers }).catch(() => {});
                logger.info('[Broker:Alpaca] Cancelled open order before sell', { symbol, orderId: o.id, type: o.type, status: o.status });
            }
            if (openOrders.length > 0) {
                // Brief pause for Alpaca to release the held shares
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (cancelErr) {
            logger.warn('[Broker:Alpaca] Could not cancel open orders before sell', { symbol, err: cancelErr.message });
        }

        logger.info('[Broker:Alpaca] Submitting SELL order', { symbol, quantity, paper: isPaper });

        // PANTHEON: limit orders only — never market orders.
        // Sell limit is set 0.5% below current price to ensure fill while protecting against flash drops.
        const dataProvider = require('./dataProvider');
        const sellQuote = await dataProvider.getQuote(symbol).catch(() => null);
        const sellPrice = parseFloat(((sellQuote?.price || 0) * 0.995).toFixed(2));

        let order;
        try {
            order = await client.createOrder({
                symbol,
                qty:           quantity,
                side:          'sell',
                type:          sellPrice > 0 ? 'limit' : 'market',
                ...(sellPrice > 0 ? { limit_price: sellPrice } : {}),
                time_in_force: 'day'
            });
        } catch (orderErr) {
            await logOrderState(idemKey, userId, symbol, 'FAILED', 'CREATED', {
                broker: isPaper ? 'alpaca-paper' : 'alpaca-live',
                quantity, price: sellPrice,
                extra: { error: orderErr.message }
            });
            throw orderErr;
        }

        await logOrderState(idemKey, userId, symbol, 'SUBMITTED', 'CREATED', {
            broker: isPaper ? 'alpaca-paper' : 'alpaca-live',
            quantity, price: sellPrice
        });

        const filled = await waitForFill(client, order.id, 15000);

        const sellStatus   = filled.status || 'submitted';
        const sellFillQty  = filled.filled_qty ? parseInt(filled.filled_qty) : quantity;
        const sellFillPx   = filled.filled_avg_price ? parseFloat(filled.filled_avg_price) : sellPrice;

        // Mirror in DB — pass the broker fill price so executeSellOrder doesn't
        // need to re-fetch a quote (avoids failures when Alpaca snapshot returns 0).
        const tradingServiceDB = require('./tradingServiceDB');
        await tradingServiceDB.executeSellOrder(
            userId, symbol, quantity,
            `ALPACA_${isPaper ? 'PAPER' : 'LIVE'}`,
            meta.reason || '',
            sellFillPx || null
        );
        const sellBroker   = isPaper ? 'alpaca-paper' : 'alpaca-live';
        const reason       = (meta.reason || '').toLowerCase();

        // Determine exit state from reason tag
        let exitState = 'CLOSED'; // default: take-profit or general close
        if (reason.includes('stop_loss') || reason.includes('stop loss') || reason.includes('stoploss')) {
            exitState = 'STOPPED';
        } else if (reason.includes('manual') || meta.executedBy === 'MANUAL') {
            exitState = 'CLOSED_MANUAL';
        }

        if (sellStatus === 'partially_filled') {
            await logOrderState(idemKey, userId, symbol, 'PARTIALLY_FILLED', 'SUBMITTED', {
                brokerOrderId: order.id, price: sellFillPx, quantity: sellFillQty, broker: sellBroker,
                extra: { requestedQty: quantity, exitState, reason: meta.reason }
            });
        } else if (['filled'].includes(sellStatus)) {
            await logOrderState(idemKey, userId, symbol, exitState, 'SUBMITTED', {
                brokerOrderId: order.id, price: sellFillPx, quantity: sellFillQty, broker: sellBroker,
                extra: { reason: meta.reason }
            });
        } else {
            await logOrderState(idemKey, userId, symbol, 'PENDING_FILL', 'SUBMITTED', {
                brokerOrderId: order.id, price: sellPrice, quantity, broker: sellBroker
            });
        }

        return {
            orderId:        order.id,
            symbol,
            side:           'sell',
            qty:            quantity,
            filledQty:      sellFillQty,
            filledAvgPrice: sellFillPx,
            status:         sellStatus,
            exitState,
            broker:         sellBroker
        };
    }

    async function waitForFill(client, orderId, timeoutMs = 15000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const order = await client.getOrder(orderId);
            if (['filled', 'partially_filled', 'canceled', 'rejected', 'expired'].includes(order.status)) {
                return order;
            }
            await new Promise(r => setTimeout(r, 500));
        }
        // Return whatever state we have — don't crash
        return await client.getOrder(orderId);
    }

    async function getAccountInfo(userId) {
        const { client, isPaper } = await getClientForUser(userId);
        const account = await client.getAccount();
        return {
            cashBalance:    parseFloat(account.cash),
            portfolioValue: parseFloat(account.portfolio_value),
            buyingPower:    parseFloat(account.buying_power),
            broker:         isPaper ? 'alpaca-paper' : 'alpaca-live'
        };
    }

    async function getPositions(userId) {
        const { client } = await getClientForUser(userId);
        const positions = await client.getPositions();
        return positions.map(p => ({
            symbol:        p.symbol,
            qty:           parseFloat(p.qty),
            avgEntryPrice: parseFloat(p.avg_entry_price),
            currentPrice:  parseFloat(p.current_price),
            marketValue:   parseFloat(p.market_value),
            unrealizedPL:  parseFloat(p.unrealized_pl)
        }));
    }

    async function getOpenOrders(userId, symbol) {
        try {
            const { client } = await getClientForUser(userId);
            const all = await client.getOrders({ status: 'open', limit: 200 });
            // When no symbol given, return ALL open orders (used by stop-repair scan).
            if (!symbol) return all || [];
            const sym = symbol.toUpperCase();
            return (all || []).filter(o => (o.symbol || '').toUpperCase() === sym);
        } catch (err) {
            logger.warn('[Broker:Alpaca] getOpenOrders failed', { symbol, err: err.message });
            return [];
        }
    }

    async function placeStopOrder(userId, symbol, qty, stopPrice) {
        const { client } = await getClientForUser(userId);
        return client.createOrder({
            symbol, qty: String(qty), side: 'sell',
            type: 'stop', time_in_force: 'gtc',
            stop_price: String(parseFloat(stopPrice).toFixed(2))
        });
    }

    async function cancelOrder(userId, orderId) {
        const { client } = await getClientForUser(userId);
        return client.cancelOrder(orderId);
    }

    // Returns the Alpaca position object for symbol, or null if none held.
    // Used as the final broker-side guard before submitting a new buy order.
    async function getPosition(userId, symbol) {
        try {
            const { client } = await getClientForUser(userId);
            const pos = await client.getPosition(symbol);
            // parseFloat handles fractional positions (e.g. 0.15 shares); parseInt would truncate to 0
            return pos && parseFloat(pos.qty) > 0 ? pos : null;
        } catch (err) {
            // Alpaca throws a 404-style error when no position exists — that is the normal path
            if (err.response?.status === 404 || /position does not exist/i.test(err.message)) {
                return null;
            }
            logger.warn('[Broker:Alpaca] getPosition failed', { symbol, err: err.message });
            return null;
        }
    }

    /**
     * Fetch total deposits and withdrawals directly from Alpaca account activities.
     * Activity types:
     *   CSD  = cash deposit  (live accounts — ACH, wire)
     *   CSW  = cash withdrawal (live accounts)
     *   JNLC = journal credit  (paper accounts — initial seed and top-ups)
     *   JNLS = journal debit   (paper accounts)
     * Returns { totalDeposited, totalWithdrawn } in USD.
     */
    async function getNetDeposits(userId) {
        const { client } = await getClientForUser(userId);
        let totalDeposited = 0;
        let totalWithdrawn = 0;

        // Fetch all four types; each may return empty array if account never had that activity
        const depositTypes    = ['CSD', 'JNLC'];
        const withdrawalTypes = ['CSW', 'JNLS'];

        for (const activityType of [...depositTypes, ...withdrawalTypes]) {
            try {
                const activities = await client.getAccountActivities({ activityType });
                for (const a of (activities || [])) {
                    const amount = Math.abs(parseFloat(a.net_amount || a.amount || 0));
                    if (amount <= 0) continue;
                    if (depositTypes.includes(activityType))    totalDeposited += amount;
                    if (withdrawalTypes.includes(activityType)) totalWithdrawn += amount;
                }
            } catch (err) {
                // Some activity types may not exist on this plan tier — silent skip
                logger.debug(`[Broker:Alpaca] getNetDeposits skipping ${activityType}: ${err.message}`);
            }
        }

        logger.info('[Broker:Alpaca] Net deposits synced from Alpaca activities', {
            userId, totalDeposited, totalWithdrawn
        });
        return { totalDeposited, totalWithdrawn };
    }

    return { buyMarket, buyBracket, buyFractional, sellMarket, getAccountInfo, getPositions, getOpenOrders, getPosition, getNetDeposits, placeStopOrder, cancelOrder, name: 'Alpaca Markets' };
})();

// ─── ACTIVE BROKER SELECTION ─────────────────────────────────────────────────
const BROKERS = { simulated: simulatedBroker, alpaca: alpacaBroker };
const activeBroker = BROKERS[BROKER] || simulatedBroker;

if (!BROKERS[BROKER]) {
    logger.warn(`[Broker] Unknown broker '${BROKER}', falling back to simulated`);
}

async function buildManualTradeResponse(side, userId, symbol, quantity, brokerResult) {
    const tradingAccountDb = require('./tradingAccountDatabaseService');
    const account = await tradingAccountDb.getTradingAccount(userId);
    const normalizedSymbol = symbol.toUpperCase();
    const price = brokerResult.filledAvgPrice ?? null;
    const total = brokerResult.total ?? (price !== null ? price * quantity : null);
    const commission = brokerResult.commission ?? null;

    const trade = side === 'buy'
        ? {
            symbol: normalizedSymbol,
            type: 'BUY',
            quantity,
            price,
            totalCost: total,
            commission
        }
        : {
            symbol: normalizedSymbol,
            type: 'SELL',
            quantity,
            price,
            totalProceeds: total,
            commission
        };

    return {
        success: true,
        symbol: normalizedSymbol,
        quantity,
        price,
        broker: brokerResult.broker,
        orderId: brokerResult.orderId,
        status: brokerResult.status,
        newBalance: account ? parseFloat(account.balance) : null,
        trade,
        message: side === 'buy'
            ? `Successfully bought ${quantity} shares of ${normalizedSymbol}${price !== null ? ` at $${price.toFixed(2)}` : ''}`
            : `Successfully sold ${quantity} shares of ${normalizedSymbol}${price !== null ? ` at $${price.toFixed(2)}` : ''}`
    };
}

async function executeManualBuyOrder(userId, symbol, quantity) {
    const normalizedSymbol = symbol.toUpperCase();
    const result = await activeBroker.buyMarket(userId, normalizedSymbol, quantity, {
        executedBy: 'MANUAL',
        safetyOptions: {
            requireAiEnabled: false,
            requireBotEnabled: false,
            enforceNotionalLimit: false  // manual trade — user is making a deliberate decision; Alpaca rejects if insufficient funds
        }
    });

    return buildManualTradeResponse('buy', userId, normalizedSymbol, quantity, result);
}

async function executeManualSellOrder(userId, symbol, quantity) {
    const normalizedSymbol = symbol.toUpperCase();
    const result = await activeBroker.sellMarket(userId, normalizedSymbol, quantity, {
        executedBy: 'MANUAL',
        reason: 'Manual sell order'
    });

    return buildManualTradeResponse('sell', userId, normalizedSymbol, quantity, result);
}

module.exports = {
    executeManualBuyOrder,
    executeManualSellOrder,

    /**
     * ARROW EOD: Cancel remaining open/partial-fill orders before market close
     * and journal them as CANCELED per PANTHEON spec.
     *
     * Spec: "Cancel remainder before close. Journal as complete."
     *
     * Runs at 15:45 ET (15 mins before NYSE close).
     * For Alpaca: cancels all open orders via API then journals each.
     * For simulated: journals any SUBMITTED/PARTIALLY_FILLED rows in order_audit_log.
     *
     * @returns {{ canceled: number, journaled: number }}
     */
    async eodCancelPartialFills() {
        const canceled  = [];
        const journaled = [];

        if (BROKER === 'alpaca') {
            // ── Alpaca: cancel all open orders via broker API ──────────────────
            try {
                const alpacaClient = (() => {
                    const { Alpaca } = require('@alpacahq/alpaca-trade-api');
                    return new Alpaca({
                        keyId:     process.env.ALPACA_KEY_ID,
                        secretKey: process.env.ALPACA_SECRET_KEY,
                        paper:     process.env.ALPACA_PAPER !== 'false'
                    });
                })();

                const openOrders = await alpacaClient.getOrders({ status: 'open', limit: 100 });
                for (const order of openOrders) {
                    // NEVER cancel protective sell-side orders (stop-loss, trailing stop, take-profit).
                    // Canceling stops leaves positions naked overnight — a gap-down can wipe months of gains.
                    // Only cancel unfilled BUY orders that will become stale after market close.
                    const isSellSide = order.side === 'sell';
                    const isStopType = order.type === 'stop' || order.type === 'stop_limit' || order.type === 'trailing_stop';
                    if (isSellSide || isStopType) {
                        logger.info('[ARROW-EOD] Preserving protective order — not canceling', {
                            orderId: order.id, symbol: order.symbol, side: order.side, type: order.type
                        });
                        continue;
                    }
                    try {
                        await alpacaClient.cancelOrder(order.id);
                        canceled.push(order.id);
                        logger.info('[ARROW-EOD] Canceled unfilled buy order', {
                            orderId: order.id, symbol: order.symbol, qty: order.qty
                        });
                    } catch (cancelErr) {
                        logger.warn('[ARROW-EOD] Could not cancel order — may have filled', {
                            orderId: order.id, err: cancelErr.message
                        });
                    }
                }
            } catch (err) {
                logger.warn('[ARROW-EOD] Alpaca cancel-all failed', { err: err.message });
            }
        }

        // ── Journal stale SUBMITTED / PARTIALLY_FILLED rows in audit log ──────
        // (applies to both simulated and alpaca — catches anything missed)
        try {
            const staleRes = await query(
                `SELECT DISTINCT ON (idempotency_key) idempotency_key, user_id, symbol, quantity, broker_order_id
                 FROM order_audit_log
                 WHERE state IN ('SUBMITTED', 'PENDING_FILL', 'PARTIALLY_FILLED')
                   AND created_at < NOW() - INTERVAL '30 minutes'
                 ORDER BY idempotency_key, created_at DESC`
            );

            for (const row of staleRes.rows) {
                const eodKey = row.idempotency_key + ':arrow_eod';
                // Idempotency: skip if already journaled
                const exists = await query(
                    `SELECT 1 FROM order_audit_log WHERE idempotency_key = $1 LIMIT 1`,
                    [eodKey]
                );
                if (exists.rows.length > 0) continue;

                await logOrderState(
                    eodKey,
                    row.user_id,
                    row.symbol,
                    'CANCELED',
                    'PARTIALLY_FILLED',
                    {
                        broker:        row.broker || BROKER,
                        brokerOrderId: row.broker_order_id,
                        quantity:      row.quantity,
                        extra: {
                            reason: 'ARROW EOD — remainder canceled before market close',
                            auto:   true,
                            timestamp: new Date().toISOString()
                        }
                    }
                );
                journaled.push(row.idempotency_key);
                logger.info('[ARROW-EOD] Journaled stale order as CANCELED', {
                    key: row.idempotency_key, symbol: row.symbol
                });
            }
        } catch (err) {
            logger.error('[ARROW-EOD] Audit log journaling failed', { err: err.message });
        }

        logger.info('[ARROW-EOD] EOD cleanup complete', {
            canceledAtBroker: canceled.length,
            journaledInDB:    journaled.length
        });
        return { canceled: canceled.length, journaled: journaled.length };
    },

    /**
     * Place a limit buy order (no stop/target attached).
     * @param {string} userId
     * @param {string} symbol
     * @param {number} quantity  whole shares
     * @param {object} meta      { aiScore, sector, executedBy }
     */
    buyMarket:      (userId, symbol, quantity, meta) =>
                        activeBroker.buyMarket(userId, symbol, quantity, meta),

    /**
     * Place an atomic bracket order: entry limit + stop-loss + take-profit in one submission.
     * Falls back to a plain limit buy on the simulated broker.
     * @param {string} userId
     * @param {string} symbol
     * @param {number} quantity   whole shares
     * @param {object} meta       { aiScore, sector, executedBy, stopPrice, targetPrice }
     */
    buyBracket:     (userId, symbol, quantity, meta) =>
                        activeBroker.buyBracket(userId, symbol, quantity, meta),

    /**
     * Fractional (notional dollar-amount) market buy for small accounts where Kelly sizing
     * rounds to 0 whole shares. Places standalone stop + take-profit GTC orders after fill.
     * The trailing stop service handles these exactly like whole-share standalone stops.
     * Falls back to buyBracket(1 share) on the simulated broker.
     */
    buyFractional:  (userId, symbol, notional, meta) =>
                        activeBroker.buyFractional
                            ? activeBroker.buyFractional(userId, symbol, notional, meta)
                            : activeBroker.buyBracket(userId, symbol, 1, meta),

    /** Place a limit sell order */
    sellMarket:     (userId, symbol, quantity, meta) =>
                        activeBroker.sellMarket(userId, symbol, quantity, meta),

    /** Get account cash/portfolio value */
    getAccountInfo: (userId) => activeBroker.getAccountInfo(userId),

    /** Get open positions */
    getPositions:   (userId) => activeBroker.getPositions(userId),

    /** Get a single open position for a symbol (null if not held) */
    getPosition:    (userId, symbol) =>
                        activeBroker.getPosition
                            ? activeBroker.getPosition(userId, symbol)
                            : Promise.resolve(null),

    /** Get pending open orders — pass symbol to filter, omit for all orders */
    getOpenOrders:  (userId, symbol) =>
                        activeBroker.getOpenOrders
                            ? activeBroker.getOpenOrders(userId, symbol)
                            : Promise.resolve([]),

    /** Place a standalone GTC stop-loss order (used by stop-repair and morning verification) */
    placeStopOrder: (userId, symbol, qty, stopPrice) =>
                        activeBroker.placeStopOrder
                            ? activeBroker.placeStopOrder(userId, symbol, qty, stopPrice)
                            : Promise.resolve(null),

    /** Cancel a specific order by ID */
    cancelOrder:    (userId, orderId) =>
                        activeBroker.cancelOrder
                            ? activeBroker.cancelOrder(userId, orderId)
                            : Promise.resolve(null),

    /**
     * Fetch total deposits and withdrawals from Alpaca account activities.
     * Returns { totalDeposited, totalWithdrawn } sourced from Alpaca — not the KiranRock DB.
     * Falls back to { totalDeposited: null, totalWithdrawn: null } for simulated broker.
     */
    getNetDeposits: (userId) =>
                        activeBroker.getNetDeposits
                            ? activeBroker.getNetDeposits(userId)
                            : Promise.resolve({ totalDeposited: null, totalWithdrawn: null }),

    brokerName:     activeBroker.name,
    brokerKey:      BROKER,
    isSimulated:    BROKER === 'simulated',
    isPaperAlpaca:  BROKER === 'alpaca' && process.env.ALPACA_PAPER !== 'false',
    isLive:         BROKER === 'alpaca' && process.env.ALPACA_PAPER === 'false'
};
