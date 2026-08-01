/**
 * Blitz — Intraday Trading Bot
 *
 * Deliberately narrow scope for a first version: a small, fixed, highly
 * liquid symbol list (same shape as the options bot's PREWARM_UNIVERSE),
 * a simple momentum/volume score, market-order entries with a resting
 * broker-side protective stop, and software-monitored take-profit + EOD
 * flatten. All market data goes through dataProvider.js, so it inherits
 * the existing shared Alpaca throttle and 60s quote cache for free — this
 * bot cannot add new external API load beyond what already exists.
 */

const dataProvider = require('./dataProvider');
const intradayDb = require('./intradayDatabaseService');
const capitalCoordinator = require('./capitalCoordinator');
const intradayBroker = require('./intradayBrokerService');
const userCycleMutex = require('./userCycleMutex');
const brokerService = require('./brokerService');
const { logger } = require('../utils/logger');

const UNIVERSE = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'TSLA', 'AMD', 'GOOGL'];

/**
 * Simple momentum + volume score, 0-100. Not trying to match swing's much
 * richer multi-factor scoring — Blitz's whole premise is a narrower, faster,
 * intraday-specific read, not a smaller copy of ARROW.
 */
function scoreCandidate(quote) {
    const changePct = quote.changePercent || 0;
    const volRatio = quote.avgVolume > 0 ? (quote.volume / quote.avgVolume) : 1;

    let score = 50;
    score += Math.max(-25, Math.min(25, changePct * 5));       // momentum, capped +-25
    score += Math.max(-15, Math.min(15, (volRatio - 1) * 15)); // volume confirmation, capped +-15
    return Math.round(Math.max(0, Math.min(100, score)));
}

async function scanForUser(user) {
    const config = user; // getActiveUsers() already joins intraday_config columns onto the user row
    const openPositions = await intradayDb.getPositions(user.id);

    if (openPositions.length >= config.max_open_positions) return { opportunities: 0, trades: 0 };

    const tradesToday = await intradayDb.getTodayTradeCount(user.id);
    if (tradesToday >= config.max_daily_trades) return { opportunities: 0, trades: 0 };

    const todayPnl = await intradayDb.getTodayPnl(user.id);
    if (todayPnl <= parseFloat(config.daily_loss_limit)) {
        logger.warn('[Blitz] Daily loss limit reached — skipping new entries', { userId: user.id, todayPnl });
        return { opportunities: 0, trades: 0 };
    }

    const heldSymbols = new Set(openPositions.map(p => p.symbol));
    let opportunities = 0;
    let tradesExecuted = 0;
    let capitalDeployed = 0;

    for (const symbol of UNIVERSE) {
        if (heldSymbols.has(symbol)) continue;
        if (openPositions.length + tradesExecuted >= config.max_open_positions) break;

        let quote;
        try {
            quote = await dataProvider.getQuote(symbol);
        } catch {
            continue;
        }
        if (!quote || !quote.price) continue;

        const score = scoreCandidate(quote);
        if (score < config.min_score) continue;
        opportunities++;

        // Capital check — Blitz's own ceiling, then the cross-strategy carve-out.
        const positionNotional = Math.min(parseFloat(config.max_position_notional), parseFloat(config.allocation_amount));
        const quantity = Math.floor(positionNotional / quote.price);
        if (quantity < 1) continue;

        const executed = await userCycleMutex.withUserLock(`blitz:${user.id}`, async () => {
            const intradayCommitted = await intradayDb.getCommittedCapital(user.id);
            if (intradayCommitted + (quantity * quote.price) > parseFloat(config.allocation_amount)) {
                return false; // would exceed Blitz's own fixed allocation
            }

            let realBuyingPower;
            try {
                const acct = await brokerService.getAccountInfo(user.id);
                realBuyingPower = acct?.buyingPower ?? acct?.cashBalance ?? 0;
            } catch {
                return false; // can't confirm real buying power — skip rather than guess
            }
            const swingCommitted = await capitalCoordinator.getSwingCommittedCapital(user.id);
            const trueAvailable = realBuyingPower - swingCommitted - intradayCommitted;
            if (trueAvailable < quantity * quote.price) return false;

            await intradayBroker.buyIntraday(user.id, symbol, quantity, {
                stopLossPercent: parseFloat(config.stop_loss_percent),
                takeProfitPercent: parseFloat(config.take_profit_percent)
            });
            return true;
        });

        if (executed) {
            tradesExecuted++;
            capitalDeployed += quantity * quote.price;
        }
    }

    await intradayDb.logCycle(user.id, {
        success: true, tradesExecuted, capitalDeployed, opportunitiesFound: opportunities,
        message: `Scan complete: ${opportunities} candidates, ${tradesExecuted} entries`
    });

    return { opportunities, trades: tradesExecuted };
}

async function monitorPositionsForUser(user) {
    const positions = await intradayDb.getPositions(user.id);

    for (const pos of positions) {
        let quote;
        try {
            quote = await dataProvider.getQuote(pos.symbol);
        } catch {
            continue;
        }
        if (!quote || !quote.price) continue;

        await intradayDb.updatePositionPrice(user.id, pos.symbol, quote.price);

        // Broker-side stop already protects the hard downside; this loop only
        // needs to catch the software-monitored take-profit (and act as a
        // backstop if the resting stop was ever missing for some reason).
        const hitTakeProfit = pos.take_profit_price && quote.price >= parseFloat(pos.take_profit_price);
        const hitStopBackstop = pos.stop_loss_price && quote.price <= parseFloat(pos.stop_loss_price);

        if (hitTakeProfit || hitStopBackstop) {
            await userCycleMutex.withUserLock(`blitz:${user.id}`, () =>
                intradayBroker.sellIntraday(user.id, pos.symbol, {
                    exitReason: hitTakeProfit ? 'take-profit' : 'stop-loss-backstop'
                })
            ).catch(err => logger.error('[Blitz] Exit failed', { userId: user.id, symbol: pos.symbol, err: err.message }));
        }
    }
}

async function forceFlattenUser(user) {
    if (!user.force_flat_eod) return;
    const positions = await intradayDb.getPositions(user.id);
    for (const pos of positions) {
        await userCycleMutex.withUserLock(`blitz:${user.id}`, () =>
            intradayBroker.sellIntraday(user.id, pos.symbol, { exitReason: 'eod-flatten' })
        ).catch(err => logger.error('[Blitz] EOD flatten failed', { userId: user.id, symbol: pos.symbol, err: err.message }));
    }
}

module.exports = { scanForUser, monitorPositionsForUser, forceFlattenUser, UNIVERSE };
