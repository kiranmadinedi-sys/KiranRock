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
        let bars = map.get(symbol) || null;

        // Drop a still-forming last bar. This cycle runs at :X0:03 — a few
        // seconds after every 5-min boundary — and at that instant Alpaca can
        // hand back the brand-new, not-yet-closed candle as the newest element.
        // For a thin pair (crypto universe includes several low-volume ones)
        // that candle can be seeded from a single stale/synthetic tick nowhere
        // near the real, settled price, since real historical re-queries of the
        // same window later show a completely different, smooth value.
        // Found 2026-09-15: UNI/USD whipsawed 7/7 times, each exit mislabeled
        // "take-profit" despite price never actually reaching the real +4%
        // target — root cause traced to exactly this partial bar. Both the
        // position-monitor's exit check and the entry scan's scoring/sizing
        // route through this one function, so trimming it here fixes both.
        if (bars && bars.length > 0) {
            const lastBar = bars[bars.length - 1];
            const lastBarStart = new Date(lastBar.Timestamp || lastBar.timestamp || lastBar.t).getTime();
            if (!Number.isNaN(lastBarStart) && lastBarStart + 5 * 60 * 1000 > Date.now()) {
                bars = bars.slice(0, -1);
            }
        }

        // Persist every fetch — this is the only place bars are pulled (both the
        // position-monitor loop and the new-entry scan route through here), so this
        // single call site is enough to build a complete history of the curated
        // universe over time. Fire-and-forget: a history-write failure must never
        // block the actual scoring/trading decision that already has the bars in hand.
        if (bars && bars.length > 0) {
            cryptoDb.savePriceBars(symbol, bars).catch(err =>
                logger.debug('[CryptoBot] savePriceBars failed', { symbol, error: err.message })
            );
        }
        return bars;
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
 * Re-verify an exit trigger against a fresh, independent live-trade price
 * before committing to a sell. Found 2026-09-23: for a thin pair, even an
 * already-CLOSED 5-min bar (not caught by _getBars' still-forming-bar trim,
 * which only guards the wall-clock-open case) can carry a single bad/synthetic
 * tick large enough to spuriously cross the take-profit threshold. UNI/USD
 * whipsawed 9 times in ~2 hours; the logged takeProfitPrice was always
 * correctly fillPrice*1.04, but 6 of the "take-profit" exits filled at a REAL
 * price far below that threshold (e.g. entry 9.628 -> takeProfitPrice
 * 10.01312 -> real fill 9.71378) — the trigger fired off a bad bar tick that
 * had already reverted by the time the market sell actually executed.
 * Same class of bug as the 2026-09-15 fix in _getBars, different
 * manifestation (a bad tick inside a technically-closed bar, not a
 * still-forming one). A confirmation miss just leaves the position open for
 * re-evaluation next cycle (5 min later) — the real broker-side resting stop
 * from buyCrypto is still the actual hard-downside protection either way, so
 * failing closed here (skip the exit) costs nothing but a short delay.
 */
async function _confirmExitTrigger(client, symbol, hitTakeProfit, pos) {
    try {
        const trades = await client.getLatestCryptoTrades([symbol]);
        const livePrice = trades.get(symbol)?.Price;
        if (!Number.isFinite(livePrice)) return false;

        return hitTakeProfit
            ? livePrice >= parseFloat(pos.take_profit_price)
            : livePrice <= parseFloat(pos.stop_loss_price);
    } catch (err) {
        logger.debug('[CryptoBot] Exit confirmation lookup failed', { symbol, error: err.message });
        return false;
    }
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
            const confirmed = await _confirmExitTrigger(client, pos.symbol, hitTakeProfit, pos);
            if (!confirmed) {
                logger.warn('[CryptoBot] Exit trigger not confirmed by a fresh live-trade price — likely a bad bar tick, skipping this cycle', {
                    userId: user.id, symbol: pos.symbol, barPrice: price,
                    threshold: hitTakeProfit ? pos.take_profit_price : pos.stop_loss_price
                });
                continue;
            }
            await userCycleMutex.withUserLock(`crypto:${user.id}`, () =>
                cryptoBroker.sellCrypto(user.id, pos.symbol, {
                    exitReason: hitTakeProfit ? 'take-profit' : 'stop-loss-backstop'
                })
            ).catch(err => logger.error('[CryptoBot] Exit failed', { userId: user.id, symbol: pos.symbol, err: err.message }));
            continue;
        }

        // Ghost-position reconciliation — added 2026-09-13. A position can close
        // at Alpaca (its real resting stop firing) without price ever again
        // crossing OUR recorded threshold, so the check above never has a reason
        // to fire and notice: found live, BCH/USD stopped out cleanly at Alpaca
        // on 9/11 but sat as a stale $500 "open position" here for 2+ days
        // because price drifted back up and never revisited either level. Only
        // runs when neither threshold above already triggered a real exit call
        // this cycle, so it adds one lightweight position lookup per held
        // symbol, not per trade. Reuses sellCrypto's existing stale_skip path
        // (2026-09-12) to record the real historical fill rather than guessing.
        const stillReal = await cryptoBroker.hasRealPosition(user.id, pos.symbol).catch(() => true);
        if (!stillReal) {
            logger.warn('[CryptoBot] Position no longer exists at Alpaca — reconciling stale DB row', {
                userId: user.id, symbol: pos.symbol
            });
            await cryptoBroker.sellCrypto(user.id, pos.symbol, { exitReason: 'reconciliation_ghost' })
                .catch(err => logger.error('[CryptoBot] Ghost reconciliation failed', { userId: user.id, symbol: pos.symbol, err: err.message }));
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

module.exports = { runCycleForUser, UNIVERSE, _confirmExitTrigger };
