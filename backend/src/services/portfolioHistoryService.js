const {
    getSnapshotsInRange,
    getSnapshotsBeforeDate
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
    // 1D/1W bucketed to 30 SECONDS (was hourly/daily) — matches the actual auto-refresh/
    // snapshot-save cadence, so the chart reflects every real data point captured instead
    // of down-sampling into coarser steps. bucketSnapshots() only emits a point for
    // buckets that actually have a snapshot, so this doesn't pad the series with empty
    // points during quiet stretches — it just stops throwing away real density that
    // exists (requested 2026-07-11, clarified from an initial 30-min guess).
    '1D': { lookbackMs: 24 * 60 * 60 * 1000, bucketMs: 30 * 1000 },
    '1W': { lookbackMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 30 * 1000 },
    // 1M/3M bucketed to 30 min (was daily/weekly) so scrubbing lands on a value every
    // 30 min instead of once a day/week — feasible now that snapshots are captured on
    // every 30s auto-refresh, not just once per page load (requested 2026-07-09).
    '1M': { lookbackMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 30 * 60 * 1000 },
    '3M': { lookbackMs: 90 * 24 * 60 * 60 * 1000, bucketMs: 30 * 60 * 1000 },
    'YTD': { lookbackMs: null, bucketMs: 30 * 24 * 60 * 60 * 1000 },
    // 1Y bucketed weekly (was monthly) so scrubbing lands on a value every week.
    '1Y': { lookbackMs: 365 * 24 * 60 * 60 * 1000, bucketMs: 7 * 24 * 60 * 60 * 1000 }
};

// Midnight ET "today", expressed as a real UTC instant — DST-safe (doesn't hardcode
// a fixed UTC-4/UTC-5 offset, derives whatever the actual current ET offset is).
function getStartOfTodayET() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).formatToParts(now);
    const get = t => parts.find(p => p.type === t).value;
    // "now" re-expressed as if its ET wall-clock reading were UTC — the gap between that
    // and the real UTC instant is exactly today's ET UTC offset (handles DST automatically).
    const nowAsIfUTC = Date.UTC(+get('year'), +get('month') - 1, +get('day'), +get('hour'), +get('minute'), +get('second'));
    const offsetMs = nowAsIfUTC - now.getTime();
    const midnightAsIfUTC = Date.UTC(+get('year'), +get('month') - 1, +get('day'), 0, 0, 0);
    return new Date(midnightAsIfUTC - offsetMs);
}

function getStartDate(range) {
    const now = new Date();
    if (range === 'YTD') {
        return new Date(Date.UTC(now.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
    }
    // "1D" means today, not "the last 24 hours" — a rolling window kept dragging in
    // yesterday's full trading session, which made the chart's shape (and its y-axis
    // scale) dominated by a session that's no longer relevant, especially before market
    // open when today's own data is still thin (found 2026-07-21, screenshot showed a
    // dramatic-looking spike/crash that was actually yesterday's normal, small intraday
    // move visually exaggerated by both this and the y-axis scaling — see portfolio/page.tsx).
    if (range === '1D') {
        return getStartOfTodayET();
    }

    const config = RANGE_CONFIG[range] || RANGE_CONFIG['1D'];
    return new Date(Date.now() - config.lookbackMs);
}

// Filters out transient "V-shaped" blips — a snapshot that dips or spikes sharply and
// then reverts within about an hour, with no real cash-flow to explain it. Found
// 2026-07-11: a pending order can temporarily hold cash on Alpaca's side, causing
// getPortfolioSummary's cash+holdings fallback (used when Alpaca's own equity figure is
// momentarily unavailable) to read low for a few minutes before recovering — e.g. June 24
// showed $2,998.71 for ~5 min between two $5,435+ readings. Coarser daily/weekly buckets
// used to average this away by chance; finer 30-min/30-sec buckets (added this week) can
// land squarely on the blip and surface it directly on the chart. Only filters a point
// when it deviates sharply from BOTH a ~1h-earlier AND ~1h-later reference AND those two
// references agree with each other — a genuine sustained move wouldn't have neighbors on
// both sides converging back to the same value, so this shouldn't mask real volatility.
const OUTLIER_DEVIATION_THRESHOLD = 0.15; // 15%
const OUTLIER_REFERENCE_WINDOW_MS = 60 * 60 * 1000; // ~1 hour
// Tuned against an unusually bad 2026-07-13 (6 separate bad points across one day, likely
// home-internet instability — see brokerService.getRecentActivity). N=5 let 3 clustered
// bad points dominate a later point's "before" reference; N=10 fixed that but then hit an
// exact 5-good/5-bad tie for a different point, where a plain median averages the two
// disagreeing sides into a meaningless midpoint instead of picking one. N=15 breaks that
// tie decisively (10 good vs 5 bad) — good readings still vastly outnumber bad ones over
// any window wide enough, so a large enough N always resolves in their favor eventually.
const OUTLIER_REFERENCE_MAX_CANDIDATES = 15;

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function filterOutlierSnapshots(snapshots) {
    if (!Array.isArray(snapshots) || snapshots.length < 3) return snapshots;

    return snapshots.filter((snap, i) => {
        const val = Number(snap.totalPortfolioValue || 0);
        if (val <= 0) return true; // let existing zero/negative handling elsewhere deal with this

        const t = new Date(snap.capturedAt).getTime();

        // Robust reference: median of up to 5 points at least 1hr away on each side, not
        // just the single nearest one. Confirmed 2026-07-13: when bad points cluster within
        // a couple hours of each other, the single nearest "before"/"after" pick can itself
        // land on another bad point — poisoning the reference so the agreement check always
        // fails and neither bad point ever gets filtered. A lone bad point can't dominate a
        // median of several candidates the way it could win a single "nearest" lookup.
        const beforeVals = [...snapshots.slice(0, i)].reverse()
            .filter(s => t - new Date(s.capturedAt).getTime() >= OUTLIER_REFERENCE_WINDOW_MS)
            .slice(0, OUTLIER_REFERENCE_MAX_CANDIDATES)
            .map(s => Number(s.totalPortfolioValue || 0))
            .filter(v => v > 0);
        const afterVals = snapshots.slice(i + 1)
            .filter(s => new Date(s.capturedAt).getTime() - t >= OUTLIER_REFERENCE_WINDOW_MS)
            .slice(0, OUTLIER_REFERENCE_MAX_CANDIDATES)
            .map(s => Number(s.totalPortfolioValue || 0))
            .filter(v => v > 0);

        // No reference on one side (e.g. near the very start/end of the lookback window) —
        // can't confirm this is transient, so don't filter it.
        if (beforeVals.length === 0 || afterVals.length === 0) return true;

        const beforeVal = median(beforeVals);
        const afterVal = median(afterVals);

        const devFromBefore = Math.abs(val - beforeVal) / beforeVal;
        const devFromAfter = Math.abs(val - afterVal) / afterVal;
        const referencesAgree = Math.abs(beforeVal - afterVal) / beforeVal < OUTLIER_DEVIATION_THRESHOLD;

        const isTransientBlip = devFromBefore > OUTLIER_DEVIATION_THRESHOLD
            && devFromAfter > OUTLIER_DEVIATION_THRESHOLD
            && referencesAgree;

        if (isTransientBlip) {
            logger.debug('[PortfolioHistory] Filtered transient outlier snapshot', {
                capturedAt: snap.capturedAt, value: val, beforeVal, afterVal
            });
        }
        return !isTransientBlip;
    });
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

    // Deliberately NOT calling savePortfolioSnapshot here — this function's only caller
    // (getPortfolioHistory) already calls getPortfolioSummary() just before this, which
    // saves internally through its own sanity guard (median baseline + activity
    // cross-check + skip-if-unresolved). Saving again here with the same summary bypassed
    // that guard entirely — confirmed 2026-07-13: a swing correctly skipped by the guard
    // still got written to history through this second, unconditional save.

    // Outlier detection needs a "before" reference for snapshots right at the start of the
    // range, or a blip there has nothing earlier to compare against and slips through
    // unfiltered — it would become the period's "first value" and corrupt the whole return
    // figure. A fixed time buffer isn't reliable here: this account has genuine multi-hour
    // gaps in snapshot history (no one had the app open), so fetch the single nearest real
    // snapshot before the range instead of guessing how far back to look (found 2026-07-11:
    // a ~41h gap meant a 1h buffer still found nothing, and the blip right after the gap
    // went unfiltered). A single anchor point isn't enough on its own, though — every
    // request's start boundary slides forward (e.g. "1D" is a rolling 24h window, not a
    // calendar day), so a bad point sitting just past that boundary can end up with only
    // one or two anchor candidates once the good history before it ages out of range —
    // too few for a robust median (confirmed 2026-07-14). Fetch a real pool of anchor
    // points instead of just the nearest one.
    const anchorSnapshots = await getSnapshotsBeforeDate(userId, startDate, OUTLIER_REFERENCE_MAX_CANDIDATES);
    const rawSnapshots = await getSnapshotsInRange(userId, startDate, endDate);
    const withAnchor = [...anchorSnapshots, ...rawSnapshots];
    const snapshots = filterOutlierSnapshots(withAnchor).filter(s => new Date(s.capturedAt).getTime() >= startDate.getTime());
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