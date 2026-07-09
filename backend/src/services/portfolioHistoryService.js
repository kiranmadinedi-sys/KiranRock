const {
    savePortfolioSnapshot,
    getSnapshotsInRange
} = require('./portfolioSnapshotService');
const brokerService = require('./brokerService');
const { logger } = require('../utils/logger');

const RANGE_CONFIG = {
    '1D': { lookbackMs: 24 * 60 * 60 * 1000, bucketMs: 60 * 60 * 1000 },
    '1W': { lookbackMs: 7 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
    '1M': { lookbackMs: 30 * 24 * 60 * 60 * 1000, bucketMs: 24 * 60 * 60 * 1000 },
    '3M': { lookbackMs: 90 * 24 * 60 * 60 * 1000, bucketMs: 7 * 24 * 60 * 60 * 1000 },
    'YTD': { lookbackMs: null, bucketMs: 30 * 24 * 60 * 60 * 1000 },
    '1Y': { lookbackMs: 365 * 24 * 60 * 60 * 1000, bucketMs: 30 * 24 * 60 * 60 * 1000 }
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

    // Raw value delta conflates deposits/withdrawals during the period with actual
    // investment gain — a deposit made mid-period would otherwise read as "return".
    // Strip out net cash flow within [startDate, endDate] so changePercent reflects
    // real portfolio performance only (found 2026-07-08: a $5,000 deposit spread across
    // 3 days was showing as +990% "3M return").
    let netDepositsInPeriod = 0;
    try {
        const { totalDeposited, totalWithdrawn } = await brokerService.getNetDepositsInRange(
            userId, startDate.toISOString(), endDate.toISOString()
        );
        if (totalDeposited != null && totalWithdrawn != null) {
            netDepositsInPeriod = totalDeposited - totalWithdrawn;
        }
    } catch (err) {
        logger.debug('[PortfolioHistory] Failed to fetch net deposits in range — reporting raw change', { userId, range: normalizedRange, error: err.message });
    }

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

    return {
        history,
        changeValue,
        changePercent,
        source: 'portfolio-snapshots'
    };
}

module.exports = {
    buildPortfolioHistory
};