/**
 * Crypto Trading — Scan + Monitor
 *
 * Calls Alpaca's crypto bars API directly rather than routing through
 * dataProvider.js — that abstraction was built entirely around equity
 * symbols (isYahooOnly/isIndexSymbol pattern-match on stock-like tickers,
 * Yahoo fallback that has no crypto data at all), and "BTC/USD"-style
 * symbols were never part of its design. Keeping this fully separate avoids
 * quietly breaking equity quote handling while adding crypto support.
 *
 * IMPORTANT, found live 2026-08-28: Alpaca's multi-symbol crypto bars
 * request (both via the SDK and the raw REST endpoint, tested directly)
 * silently returns data for only ONE symbol (BTC/USD) when multiple are
 * requested together, regardless of order — confirmed reproducible, not a
 * one-off. The original plan here was one batched call covering the whole
 * universe per cycle; that would have silently made this bot blind to 14 of
 * 15 symbols had it shipped untested. Reverted to per-symbol calls (each
 * individually verified working, including non-BTC pairs). Efficiency
 * instead comes from: a small curated universe (15 symbols, not Polygon's
 * multi-thousand-ticker crypto list) and a 5-minute cadence (vs Blitz's
 * 1-minute) — still ~5x fewer cycles/day than Blitz's design even without
 * the batching this originally assumed.
 */
const Alpaca = require('@alpacahq/alpaca-trade-api');
const userDb = require('./userDatabaseService');
const cryptoDb = require('./cryptoDatabaseService');
const cryptoBroker = require('./cryptoBrokerService');
const userCycleMutex = require('./userCycleMutex');
const { logger } = require('../utils/logger');

// Curated core — Alpaca's most liquid, most established pairs (confirmed
// tradable on this account 2026-08-28), not an attempt to cover the whole
// crypto market.
const UNIVERSE = [
    'BTC/USD', 'ETH/USD', 'SOL/USD', 'LTC/USD', 'BCH/USD',
    'LINK/USD', 'UNI/USD', 'AAVE/USD', 'DOT/USD', 'AVAX/USD',
    'DOGE/USD', 'SHIB/USD', 'XRP/USD', 'MKR/USD', 'CRV/USD'
];

const BAR_WINDOW = 20; // ~20 x 5-min bars = last ~100 min of price action for momentum read

async function _getClientForUser(userId) {
    const creds = await userDb.getUserAlpacaCredentials(userId);
    return new Alpaca({ keyId: creds.keyId, secretKey: creds.secretKey, paper: creds.isPaper });
}

async function _getBars(client, symbol) {
    try {
        const map = await client.getCryptoBars([symbol], { timeframe: '5Min', limit: BAR_WINDOW });
        return map.get(symbol) || null;
    } catch (err) {
        logger.debug('[CryptoBot] Bars fetch failed', { symbol, error: err.message });
        return null;
    }
}

/**
 * Momentum + volume score, 0-100. Same shape as Blitz's scoreCandidate
 * (base 50, +-25 momentum, +-15 volume) for consistency, computed from a
 * bar window instead of a single quote's daily change/avgVolume (crypto
 * bars don't carry an "average volume" field the way equity quotes do).
 */
function scoreFromBars(bars) {
    if (!bars || bars.length < 2) return 50;
    const first = bars[0];
    const last  = bars[bars.length - 1];
    const changePct = first.Open > 0 ? ((last.Close - first.Open) / first.Open) * 100 : 0;

    const avgVol = bars.reduce((sum, b) => sum + (b.Volume || 0), 0) / bars.length;
    const lastVol = last.Volume || 0;
    const volRatio = avgVol > 0 ? lastVol / avgVol : 1;

    let score = 50;
    score += Math.max(-25, Math.min(25, changePct * 8));       // crypto moves faster than equities, higher multiplier
    score += Math.max(-15, Math.min(15, (volRatio - 1) * 15));
    return Math.round(Math.max(0, Math.min(100, score)));
}

/**
 * One scan + monitor pass for a single user. Position monitoring runs first
 * (protect capital before chasing new entries), one bar fetch per held
 * symbol; then scans UNIVERSE for new candidates, one bar fetch per symbol
 * not already held. See file docstring for why this isn't one batched call.
 */
async function runCycleForUser(user) {
    const config = user; // getActiveUsers() already joins crypto_config columns onto the user row
    const openPositions = await cryptoDb.getPositions(user.id);
    const heldSymbols = new Set(openPositions.map(p => p.symbol));

    let client;
    try {
        client = await _getClientForUser(user.id);
    } catch (err) {
        logger.error('[CryptoBot] Could not get Alpaca client', { userId: user.id, error: err.message });
        return { opportunities: 0, trades: 0 };
    }

    // ── 1. Monitor existing positions first ──
    for (const pos of openPositions) {
        const bars = await _getBars(client, pos.symbol);
        if (!bars || bars.length === 0) continue;
        const price = bars[bars.length - 1].Close;
        if (!price) continue;

        await cryptoDb.updatePositionPrice(user.id, pos.symbol, price);

        // Same "broker-side stop already protects the hard downside, this is a
        // take-profit check + backstop" reasoning as Blitz's monitorPositionsForUser.
        const hitTakeProfit   = pos.take_profit_price && price >= parseFloat(pos.take_profit_price);
        const hitStopBackstop = pos.stop_loss_price   && price <= parseFloat(pos.stop_loss_price);

        if (hitTakeProfit || hitStopBackstop) {
            await userCycleMutex.withUserLock(`crypto:${user.id}`, () =>
                cryptoBroker.sellCrypto(user.id, pos.symbol, {
                    exitReason: hitTakeProfit ? 'take-profit' : 'stop-loss-backstop'
                })
            ).catch(err => logger.error('[CryptoBot] Exit failed', { userId: user.id, symbol: pos.symbol, err: err.message }));
        }
    }

    // ── 2. Scan for new entries ──
    if (openPositions.length >= config.max_open_positions) return { opportunities: 0, trades: 0 };

    const tradesToday = await cryptoDb.getTodayTradeCount(user.id);
    if (tradesToday >= config.max_daily_trades) return { opportunities: 0, trades: 0 };

    const todayPnl = await cryptoDb.getTodayPnl(user.id);
    if (todayPnl <= parseFloat(config.daily_loss_limit)) {
        logger.warn('[CryptoBot] Daily loss limit reached — skipping new entries', { userId: user.id, todayPnl });
        return { opportunities: 0, trades: 0 };
    }

    let opportunities = 0;
    let tradesExecuted = 0;

    for (const symbol of UNIVERSE) {
        if (heldSymbols.has(symbol)) continue;
        if (openPositions.length + tradesExecuted >= config.max_open_positions) break;

        const bars = await _getBars(client, symbol);
        if (!bars || bars.length < 2) continue;
        const price = bars[bars.length - 1].Close;
        if (!price) continue;

        const score = scoreFromBars(bars);
        if (score < config.min_score) continue;
        opportunities++;

        const positionNotional = Math.min(parseFloat(config.max_position_notional), parseFloat(config.allocation_amount));
        // Crypto quantities are fractional by default -- no Math.floor to whole
        // units here, just round to a sane 6dp precision most pairs accept.
        const quantity = parseFloat((positionNotional / price).toFixed(6));
        if (quantity <= 0) continue;

        const executed = await userCycleMutex.withUserLock(`crypto:${user.id}`, async () => {
            const cryptoCommitted = await cryptoDb.getCommittedCapital(user.id);
            if (cryptoCommitted + (quantity * price) > parseFloat(config.allocation_amount)) {
                return false; // would exceed this bot's own fixed allocation
            }
            await cryptoBroker.buyCrypto(user.id, symbol, quantity, {
                stopLossPercent: parseFloat(config.stop_loss_percent),
                takeProfitPercent: parseFloat(config.take_profit_percent)
            });
            return true;
        });

        if (executed) tradesExecuted++;
    }

    await cryptoDb.logCycle(user.id, {
        success: true, tradesExecuted, capitalDeployed: 0, opportunitiesFound: opportunities,
        message: `Scan complete: ${opportunities} candidates, ${tradesExecuted} entries`
    });

    return { opportunities, trades: tradesExecuted };
}

module.exports = { runCycleForUser, UNIVERSE };
