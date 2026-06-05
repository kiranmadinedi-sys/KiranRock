const {
    savePortfolioSnapshot,
    getSnapshotsInRange
} = require('./portfolioSnapshotService');

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
    const changeValue = lastValue - firstValue;
    const changePercent = firstValue > 0 ? (changeValue / firstValue) * 100 : 0;

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