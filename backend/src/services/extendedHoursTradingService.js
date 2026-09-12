/**
 * ARROW — Extended-Hours Trading (opt-in)
 *
 * Runs entirely separately from the regular swing cycle (`executeAutonomousTrading`,
 * `isMarketOpen()`, the 5-min tick in enhancedAIScheduler.js) — this is an additive,
 * parallel path, not a modification of the core cycle. It reuses the same opportunity
 * pipeline (`scanMarketForOpportunities`/`getUserRiskConfig`) so scoring logic is never
 * duplicated.
 *
 * Opt-in via risk_configs.extended_hours_enabled — available to any account, paper or
 * live. Which users are actually enrolled is an operational rollout decision made by
 * whoever flips the toggle, not a restriction baked into this code.
 *
 * Alpaca platform rule (not a choice made here): extended-hours order submission
 * requires type:'limit' + time_in_force:'day' + extended_hours:true, and rejects
 * order_class:'bracket' and any stop/stop_limit order entirely during extended
 * sessions. So an entry here has NO attached stop. That gap is already covered by
 * existing code, not something new built for this feature: runMorningStopVerification
 * (enhancedAIScheduler.js, fires 9:31-9:44 AM ET) queries Alpaca's actual live
 * positions directly and backfills any missing stop; the regular-hours StopRepair
 * pass inside manageExistingPositions() does the same on every 5-min tick. Neither
 * cares what session a position was opened in (getOpenOrders has no session filter).
 *
 * ALSO owns position management during extended hours (added 2026-09-12) — not
 * just new entries anymore. manageExistingPositions() (trailing stops, decay
 * re-scoring, distress-mode tightening) only ever ran inside the regular 9:30-4:00
 * cycle, leaving every account's open positions unmanaged during the two windows
 * real equity trading (and therefore a real stop-loss fill) can still happen
 * outside that window — 4-9:30 AM and 4-8 PM ET. A stop still protects the
 * position either way (it's a real resting order at Alpaca, armed 24/7), but
 * nothing was tightening it, reacting to it, or even noticing it fired until the
 * next regular-hours tick or a reconciliation sweep — measured live at an average
 * 89-hour delay, versus a net-positive result whenever the loop actually got to
 * manage the exit itself. See manageOpenPositionsDuringExtendedHours below: unlike
 * the entry-scanning opt-in above, this runs for every active-AI-trading account,
 * since any open position is equally exposed regardless of how it was entered.
 * The 8 PM-4 AM span outside both windows needs no equivalent — no US equity venue
 * is open at all then, so no equity stop can fire in that stretch either way.
 */

const { query } = require('../config/database');
const { logger } = require('../utils/logger');
const brokerService = require('./brokerService');
const holdingsDb = require('./holdingsDatabaseService');
const alertService = require('./telegramAlertService');

const MAX_NOTIONAL_USD  = parseFloat(process.env.EXTENDED_HOURS_MAX_NOTIONAL_USD || '500');
const MAX_ENTRIES_TICK  = parseInt(process.env.EXTENDED_HOURS_MAX_ENTRIES_PER_TICK || '1', 10);
const MAX_POSITIONS_DAY = parseInt(process.env.EXTENDED_HOURS_MAX_POSITIONS_PER_DAY || '3', 10);

/** 4:00-9:30 AM ET and 4:00-8:00 PM ET, Mon-Fri. Deliberately separate from isMarketOpen(). */
function isExtendedHoursSession() {
    const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    const day = dayFmt.format(new Date());
    if (day === 'Sat' || day === 'Sun') return false;

    const timeFmt = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false
    });
    const parts = timeFmt.formatToParts(new Date());
    const h = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const m = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const t = h + m / 60;

    return (t >= 4 && t < 9.5) || (t >= 16 && t < 20);
}

/** Opt-in users only — no broker-type filter. Enrollment is an operational decision. */
async function getEligibleUsers() {
    const res = await query(`
        SELECT u.id, u.username
        FROM users u
        JOIN risk_configs rc ON rc.user_id = u.id
        WHERE u.ai_trading_enabled = true AND u.is_active = true
          AND rc.extended_hours_enabled = true
    `);
    return res.rows;
}

/**
 * Position management (trailing stops, decay re-scoring, distress-mode
 * tightening) — added 2026-09-12. Found live: extended-hours-touched
 * positions were closing out an average of 89 hours after their real
 * stop-loss actually fired at Alpaca, discovered only when a reconciliation
 * sweep happened to run, versus +$69 net when the normal position-management
 * loop caught the same class of exit live. Root cause: manageExistingPositions
 * only ever ran inside the regular 9:30-4:00 ET cycle (gated behind the same
 * isMarketOpen() check as new-trade scanning) — extended-hours entries create
 * fresh, not-yet-trailing-stopped positions right at 4-9:30 AM / 4-8 PM,
 * exactly the two windows nothing was watching them. Deliberately scoped to
 * EVERY active-AI-trading user here, not just those opted into extended-hours
 * ENTRIES (getEligibleUsers above) — any account can be holding a position
 * that's still open when regular hours end, and that position is equally
 * exposed to this gap regardless of how it was originally entered. No new
 * scheduling needed: this rides the same 5-minute tick runExtendedHoursCycle
 * already runs on, via enhancedAIScheduler.js's shared interval.
 */
async function manageOpenPositionsDuringExtendedHours() {
    const userDb = require('./userDatabaseService');
    let users;
    try {
        users = await userDb.getUsersWithAITradingEnabled();
    } catch (err) {
        logger.error('[ExtendedHours] Could not load users for position management', { error: err.message });
        return;
    }
    if (!users?.length) return;

    const enhancedAITradingBot = require('./enhancedAITradingBot');
    for (const user of users) {
        try {
            await enhancedAITradingBot.manageExistingPositions(user.id);
        } catch (err) {
            logger.error('[ExtendedHours] Position management error for user', { userId: user.id, error: err.message });
        }
    }
}

async function countTodaysExtendedHoursPositions(userId) {
    const res = await query(`
        SELECT COUNT(DISTINCT symbol) AS cnt FROM order_audit_log
        WHERE user_id = $1 AND idempotency_key LIKE '%:ext'
          AND state IN ('SUBMITTED','FILLED','PARTIALLY_FILLED')
          AND created_at >= CURRENT_DATE
    `, [userId]);
    return parseInt(res.rows[0]?.cnt || 0);
}

async function runExtendedHoursCycle() {
    if (!isExtendedHoursSession()) return;

    // Protect capital before chasing new entries — same ordering principle as
    // every other cycle in this codebase (crypto, regular-hours). Runs for
    // every active-AI-trading user, independent of the entry-scanning opt-in
    // below (see manageOpenPositionsDuringExtendedHours's own comment for why).
    await manageOpenPositionsDuringExtendedHours();

    let users;
    try {
        users = await getEligibleUsers();
    } catch (err) {
        logger.error('[ExtendedHours] Could not load eligible users', { error: err.message });
        return;
    }
    if (users.length === 0) return;

    for (const user of users) {
        try {
            await scanExtendedHoursForUser(user);
        } catch (err) {
            logger.error('[ExtendedHours] Cycle error for user', { userId: user.id, error: err.message });
        }
    }
}

async function scanExtendedHoursForUser(user) {
    const userId = user.id;

    const dailyCount = await countTodaysExtendedHoursPositions(userId);
    if (dailyCount >= MAX_POSITIONS_DAY) return;

    const enhancedAITradingBot = require('./enhancedAITradingBot');
    const riskConfig = await enhancedAITradingBot.getUserRiskConfig(userId);
    const opportunities = await enhancedAITradingBot.scanMarketForOpportunities(userId, 50, riskConfig.minBuyScore);

    const holdings = await holdingsDb.getUserHoldings(userId);
    const owned = new Set(holdings.map(h => h.symbol));

    const candidates = opportunities
        .filter(o => !owned.has(o.symbol) && o.recommendation === 'STRONG BUY')
        .slice(0, MAX_ENTRIES_TICK);

    if (candidates.length === 0) return;

    const accountInfo = await brokerService.getAccountInfo(userId);
    const positionSize = Math.max(0, Math.min(
        MAX_NOTIONAL_USD,
        riskConfig.maxOrderNotional || MAX_NOTIONAL_USD,
        accountInfo.cashBalance * 0.5
    ));

    for (const opp of candidates) {
        const shares = Math.floor(positionSize / opp.price);
        // Alpaca does not accept notional/fractional orders in extended sessions —
        // whole shares only. Skip rather than round up into an oversized position.
        if (shares < 1) continue;

        try {
            const result = await brokerService.buyLimitExtendedHours(userId, opp.symbol, shares, {
                aiScore: opp.aiScore, sector: opp.sector, atr: opp.atr || null,
                stopLossPct: riskConfig.stopLoss
            });
            if (result.filledQty > 0) {
                logger.info('[ExtendedHours] Entry filled', {
                    userId, symbol: opp.symbol, qty: result.filledQty, price: result.filledAvgPrice,
                    stopPlaced: !result.noStopAttached
                });
                const stopLine = result.noStopAttached
                    ? `⚠️ Could not place a stop immediately — it will be added automatically at next market open (9:31 AM ET).`
                    : `🛡️ Protective stop placed immediately (rests in the book now, arms automatically once regular hours open).`;
                alertService.sendMessage(userId,
                    `🌙 *Extended-Hours Entry* — ${opp.symbol}\n` +
                    `${result.filledQty} sh @ $${result.filledAvgPrice?.toFixed(2)} (score ${opp.aiScore})\n\n` +
                    `${stopLine}`
                ).catch(() => {});
            }
        } catch (err) {
            logger.warn('[ExtendedHours] Entry failed', { userId, symbol: opp.symbol, error: err.message });
        }
    }
}

module.exports = { isExtendedHoursSession, runExtendedHoursCycle, getEligibleUsers, manageOpenPositionsDuringExtendedHours };
