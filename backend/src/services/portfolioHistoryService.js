const {
    savePortfolioSnapshot,
    getSnapshotsInRange
} = require('./portfolioSnapshotService');
const brokerService = require('./brokerService');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

// Some cash-basis changes never reach Alpaca's own activity log — paper accounts'
// "Reset balance" / "Deposit" actions (tradingAccountService.js) only update the
// KiranRock DB directly, no Alpaca API call involved, yet they DO change the real
// tracked portfolio value (verified 2026-07-09: a $50k DB-only "Account deposit" made
// the snapshot value jump by exactly $50k at that instant). So both sources have to be
// merged for period-return math to be accurate on paper accounts. The live account's DB
// sometimes ALSO has a redundant bootstrap row for a deposit Alpaca already reports
// (logged a few days later, when the app started tracking that account) — skip any DB
// row that closely matches an existing Alpaca event in amount and date, or it would be
// double-counted.
const DEDUPE_WINDOW_MS = 10 * 24 * 60 * 60 * 1000; // 10 days

// Deposits/withdrawals are rare (a handful of events over an account's whole life), but
// without caching, every chart load — and every 30s auto-refresh, across all 6 range
// tabs — re-fetched the full history from Alpaca (4 activity-type calls) AND re-queried
// the trades table. Caching cuts that ~120x (30s auto-refresh -> 1h cache) and reduces
// Alpaca rate-limit exposure (raised 2026-07-09).
const _depositEventsCache = new Map(); // userId -> { events, fetchedAt }
const DEPOSIT_EVENTS_CACHE_TTL = 60 * 60 * 1000; // 1h

// Two-tier: in-memory (fastest, cleared on restart) backed by a DB row (deposit_events_cache
// table) so a cold start after a restart can load the last-known-good events instantly
// instead of re-hitting Alpaca on the very first request (raised 2026-07-09).
async function getMergedDepositEvents(userId) {
    const memCached = _depositEventsCache.get(userId);
    if (memCached && Date.now() - memCached.fetchedAt < DEPOSIT_EVENTS_CACHE_TTL) return memCached.events;

    try {
        const dbCached = await query(`SELECT events, computed_at FROM deposit_events_cache WHERE user_id = $1`, [userId]);
        const row = dbCached.rows[0];
        if (row && Date.now() - new Date(row.computed_at).getTime() < DEPOSIT_EVENTS_CACHE_TTL) {
            const events = row.events.map(e => ({ date: new Date(e.date), amount: e.amount }));
            _depositEventsCache.set(userId, { events, fetchedAt: new Date(row.computed_at).getTime() });
            return events;
        }
    } catch (err) {
        logger.debug('[PortfolioHistory] deposit_events_cache read failed — recomputing', { userId, error: err.message });
    }

    const alpacaEvents = await brokerService.getDepositActivities(userId);
    let dbEvents = [];
    try {
        const dbRows = await query(
            `SELECT action, total, trade_date FROM trades WHERE user_id = $1 AND action IN ('DEPOSIT', 'WITHDRAWAL') ORDER BY trade_date ASC`,
            [userId]
        );
        dbEvents = dbRows.rows
            .map(row => ({
                date: new Date(row.trade_date),
                amount: row.action === 'WITHDRAWAL' ? -Math.abs(parseFloat(row.total)) : Math.abs(parseFloat(row.total))
            }))
            .filter(dbEvent => !alpacaEvents.some(e =>
                Math.abs(e.amount - dbEvent.amount) < 0.01 &&
                Math.abs(e.date.getTime() - dbEvent.date.getTime()) < DEDUPE_WINDOW_MS
            ));
    } catch (err) {
        logger.debug('[PortfolioHistory] Failed to fetch DB-tracked deposit events', { userId, error: err.message });
    }

    const events = [...alpacaEvents, ...dbEvents].sort((a, b) => a.date.getTime() - b.date.getTime());
    _depositEventsCache.set(userId, { events, fetchedAt: Date.now() });
    query(
        `INSERT INTO deposit_events_cache (user_id, events, computed_at) VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET events = EXCLUDED.events, computed_at = NOW()`,
        [userId, JSON.stringify(events)]
    ).catch(err => logger.debug('[PortfolioHistory] deposit_events_cache write failed', { userId, error: err.message }));
    return events;
}

/** Call after a deposit/withdrawal/balance-reset so the next chart load reflects it immediately instead of waiting out the cache TTL. */
function invalidateDepositEventsCache(userId) {
    _depositEventsCache.delete(userId);
    query(`DELETE FROM deposit_events_cache WHERE user_id = $1`, [userId])
        .catch(err => logger.debug('[PortfolioHistory] deposit_events_cache invalidation failed', { userId, error: err.message }));
}

const RANGE_CONFIG = {
    '1D': { lookbackMs: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 },
    '1W': { lookbackMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
    // 1M/3M bucketed to 30 min (was daily/weekly) so scrubbing lands on a value every
    // 30 min instead of once a day/week — feasible now that snapshots are captured on
    // every 30s auto-refresh, not just once per page load (requested 2026-07-09).
    '1M': { lookbackMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 30 * 60 * 1000 },
    '3M': { lookbackMs: 90 * 24 * 60 * 60 * 1000, bucketMs: 30 * 60 * 1000 },
    'YTD': { lookbackMs: null, bucketMs: 30 * 24 * 60 * 60 * 1000 },
    // 1Y bucketed weekly (was monthly) so scrubbing lands on a value every week.
    '1Y': { lookbackMs: 365 * 24 * 60 * 60 * 1000, bucketMs: 7 * 24 * 60 * 60 * 1000 }
};

function getStartDate(range) {
    const now = new Date();
    if (range === 'YTD') {
        return new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
    }

    const config = RANGE_CONFIG[range] || RANGE_CONFIG['1D'];
    return new Date(Date.now() - config.lookbackMs);
}

function bucketSnapshots(snapshots, bucketMs) {
    if (!Array.isArray(snapshots) || snapshots.length === 0) {
        return [];
    }

    if (!bucketMs || bucketMs <= 0) {
        return snapshots;
    }

    const buckets = new Map();
    for (const snapshot of snapshots) {
        const capturedAt = new Date(snapshot.capturedAt);
        const bucketKey = Math.floor(capturedAt.getTime() / bucketMs) * bucketMs;
        buckets.set(bucketKey, {
            time: snapshot.capturedAt,
            value: Number(snapshot.totalPortfolioValue || 0)
        });
    }

    return Array.from(buckets.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value);
}

async function buildPortfolioHistory(userId, range, summary) {
    const normalizedRange = RANGE_CONFIG[range] ? range : '1D';
    const startDate = getStartDate(normalizedRange);
    const endDate = new Date();

    await savePortfolioSnapshot(userId, summary, { source: `portfolio-history-${normalizedRange}` });

    const snapshots = await getSnapshotsInRange(userId, startDate, endDate);
    let history = bucketSnapshots(snapshots, RANGE_CONFIG[normalizedRange].bucketMs);

    if (history.length === 0) {
        history = [
            { time: startDate.toISOString(), value: Number(summary.totalPortfolioValue || 0) },
            { time: endDate.toISOString(), value: Number(summary.totalPortfolioValue || 0) }
        ];
    } else if (history.length === 1) {
        history = [
            { time: startDate.toISOString(), value: history[0].value },
            history[0],
            { time: endDate.toISOString(), value: Number(summary.totalPortfolioValue || history[0].value || 0) }
        ];
    } else {
        const lastValue = Number(summary.totalPortfolioValue || history[history.length - 1].value || 0);
        const lastPointTime = new Date(history[history.length - 1].time).getTime();
        if (!Number.isFinite(lastPointTime) || lastPointTime < endDate.getTime() - (5 * 60 * 1000)) {
            history.push({ time: endDate.toISOString(), value: lastValue });
        }
    }

    const firstValue = Number(history[0]?.value || 0);
    const lastValue = Number(history[history.length - 1]?.value || 0);

    // Fetch the full deposit/withdrawal history once so both the period-level total
    // AND a per-point "deposits since this point" figure can be computed locally —
    // the latter lets the frontend show a valid deposit-adjusted change while
    // scrubbing any individual point on the chart, not just for the period as a whole.
    let depositEvents = [];
    try {
        depositEvents = await getMergedDepositEvents(userId);
    } catch (err) {
        logger.debug('[PortfolioHistory] Failed to fetch deposit activities — reporting raw change', { userId, range: normalizedRange, error: err.message });
    }
    const netDepositsBetween = (fromMs, toMs) => depositEvents.reduce(
        (sum, e) => (e.date.getTime() > fromMs && e.date.getTime() <= toMs) ? sum + e.amount : sum, 0
    );

    // Raw value delta conflates deposits/withdrawals during the period with actual
    // investment gain — a deposit made mid-period would otherwise read as "return".
    // Strip out net cash flow within [startDate, endDate] so changePercent reflects
    // real portfolio performance only (found 2026-07-08: a $5,000 deposit spread across
    // 3 days was showing as +990% "3M return").
    const netDepositsInPeriod = netDepositsBetween(startDate.getTime(), endDate.getTime());

    // If every deposit the account has ever received falls inside this period, the
    // period's own bucketed baseline (firstValue) isn't trustworthy as a starting
    // equity figure — it may predate the account being genuinely funded (e.g. a
    // leftover seed/test snapshot from before the first real deposit landed, as seen
    // 2026-07-09: a $500 snapshot from a month before the account's first Alpaca
    // deposit made 3M read as a big loss instead of matching the real all-time return).
    // In that case anchor to the authoritative all-time deposited total instead.
    const totalDepositedAllTime = Number(summary?.totalInvested || 0);
    const changeValue = (totalDepositedAllTime > 0 && netDepositsInPeriod >= totalDepositedAllTime - 0.01)
        ? lastValue - totalDepositedAllTime
        : (lastValue - firstValue) - netDepositsInPeriod;

    // Percent denominator is always the full deposited basis, not the period's own
    // (possibly partial, possibly stale) starting snapshot — a mid-period deposit means
    // firstValue only reflects a fraction of the capital actually at risk, which would
    // otherwise wildly overstate the swing (e.g. -$46 read as -9% instead of -0.84%).
    // This also keeps every period's percent consistent with the "Account Return" stat.
    const changePercent = totalDepositedAllTime > 0
        ? (changeValue / totalDepositedAllTime) * 100
        : (firstValue > 0 ? (changeValue / firstValue) * 100 : 0);

    // Same deposits-since-point figure for every individual chart point, so the
    // frontend can show a valid change while scrubbing anywhere on the chart, not
    // just at the period's endpoints.
    const nowMs = endDate.getTime();
    const annotatedHistory = history.map(p => ({
        ...p,
        depositsSince: netDepositsBetween(new Date(p.time).getTime(), nowMs)
    }));

    return {
        history: annotatedHistory,
        changeValue,
        changePercent,
        source: 'portfolio-snapshots'
    };
}

module.exports = {
    buildPortfolioHistory,
    invalidateDepositEventsCache
};