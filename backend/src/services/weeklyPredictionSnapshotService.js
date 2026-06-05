const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SNAPSHOT_BASE_DIR = process.env.WEEKLY_PREDICTION_SNAPSHOT_DIR
    ? path.resolve(process.env.WEEKLY_PREDICTION_SNAPSHOT_DIR)
    : path.join(__dirname, '../config/cache/weekly-predictions');

function ensureSnapshotDir() {
    fs.mkdirSync(SNAPSHOT_BASE_DIR, { recursive: true });
}

function getSnapshotPath(cacheKey) {
    const digest = crypto.createHash('sha1').update(cacheKey).digest('hex');
    return path.join(SNAPSHOT_BASE_DIR, `${digest}.json`);
}

function loadWeeklyPredictionSnapshot(cacheKey, maxAgeMs = null) {
    try {
        const filePath = getSnapshotPath(cacheKey);
        if (!fs.existsSync(filePath)) {
            return null;
        }

        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!parsed || !parsed.payload || !parsed.createdAt) {
            return null;
        }

        const ageMs = Date.now() - new Date(parsed.createdAt).getTime();
        if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && ageMs > maxAgeMs) {
            return null;
        }

        return {
            payload: parsed.payload,
            createdAt: parsed.createdAt,
            ageMs,
            cacheKey: parsed.cacheKey || cacheKey
        };
    } catch (error) {
        console.error('[Weekly Snapshot] Failed to read snapshot:', error.message);
        return null;
    }
}

function saveWeeklyPredictionSnapshot(cacheKey, payload) {
    try {
        ensureSnapshotDir();
        const filePath = getSnapshotPath(cacheKey);
        fs.writeFileSync(filePath, JSON.stringify({
            cacheKey,
            createdAt: new Date().toISOString(),
            payload
        }, null, 2));
    } catch (error) {
        console.error('[Weekly Snapshot] Failed to write snapshot:', error.message);
    }
}

function getWeeklyPredictionSnapshotStatus(cacheKey, maxAgeMs = null) {
    const snapshot = loadWeeklyPredictionSnapshot(cacheKey, null);
    if (!snapshot) {
        return {
            present: false,
            fresh: false,
            cacheKey,
            createdAt: null,
            ageMs: null,
            maxAgeMs: Number.isFinite(maxAgeMs) ? maxAgeMs : null
        };
    }

    const fresh = Number.isFinite(maxAgeMs) ? snapshot.ageMs <= maxAgeMs : true;

    return {
        present: true,
        fresh,
        cacheKey,
        createdAt: snapshot.createdAt,
        ageMs: snapshot.ageMs,
        maxAgeMs: Number.isFinite(maxAgeMs) ? maxAgeMs : null
    };
}

module.exports = {
    SNAPSHOT_BASE_DIR,
    getSnapshotPath,
    getWeeklyPredictionSnapshotStatus,
    loadWeeklyPredictionSnapshot,
    saveWeeklyPredictionSnapshot
};