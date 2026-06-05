const { query } = require('../config/database');
const { buildSwingFeedItem, getTrackedSymbols } = require('./stockSignalAnalysisService');

const MARKET_FRESHNESS_MS = Math.max(5 * 60 * 1000, Number.parseInt(process.env.STOCK_SIGNAL_SNAPSHOT_MARKET_FRESHNESS_MS || `${15 * 60 * 1000}`, 10) || (15 * 60 * 1000));
const OFF_HOURS_FRESHNESS_MS = Math.max(15 * 60 * 1000, Number.parseInt(process.env.STOCK_SIGNAL_SNAPSHOT_OFF_HOURS_FRESHNESS_MS || `${60 * 60 * 1000}`, 10) || (60 * 60 * 1000));

let snapshotSchemaReady = null;

function isMarketHours() {
    const now = new Date();
    const marketTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day = marketTime.getDay();
    const minutes = marketTime.getHours() * 60 + marketTime.getMinutes();

    if (day === 0 || day === 6) {
        return false;
    }

    return minutes >= (9 * 60 + 30) && minutes <= (16 * 60);
}

function getFreshnessMs() {
    return isMarketHours() ? MARKET_FRESHNESS_MS : OFF_HOURS_FRESHNESS_MS;
}

function snapshotExpirySql() {
    return isMarketHours()
        ? "CURRENT_TIMESTAMP + INTERVAL '12 hours'"
        : "CURRENT_TIMESTAMP + INTERVAL '36 hours'";
}

function mapSnapshotRow(row) {
    const payload = row.payload || {};
    return {
        id: `swing:${row.item_key}`,
        type: 'swing',
        symbol: row.symbol,
        title: row.title,
        summary: row.summary,
        link: null,
        sourceLabel: row.source_label,
        signal: row.signal,
        severity: null,
        impact: null,
        sentimentImpact: null,
        sentimentScore: row.sentiment_score === null ? null : Number(row.sentiment_score),
        priorityScore: row.priority_score === null ? 0 : Number(row.priority_score),
        popupEligible: Boolean(row.popup_eligible),
        read: false,
        createdAt: row.created_at,
        analyzedAt: row.analyzed_at,
        dismissalKey: row.item_key,
        recommendation: row.recommendation,
        meta: {
            ...payload,
            analyzedAt: row.analyzed_at,
            freshnessMinutes: Math.max(0, Math.round((Date.now() - new Date(row.analyzed_at).getTime()) / 60000))
        }
    };
}

async function ensureSnapshotSchema() {
    if (!snapshotSchemaReady) {
        snapshotSchemaReady = (async () => {
            await query(`
                CREATE TABLE IF NOT EXISTS stock_signal_snapshots (
                    id SERIAL PRIMARY KEY,
                    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    item_type VARCHAR(20) NOT NULL DEFAULT 'swing',
                    item_key VARCHAR(200) NOT NULL,
                    symbol VARCHAR(10) NOT NULL,
                    title TEXT NOT NULL,
                    summary TEXT,
                    signal VARCHAR(30),
                    recommendation VARCHAR(20),
                    source_label VARCHAR(100),
                    priority_score INTEGER,
                    popup_eligible BOOLEAN DEFAULT false,
                    sentiment_score DECIMAL(6, 2),
                    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    analyzed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP,
                    payload JSONB DEFAULT '{}'::jsonb,
                    UNIQUE(user_id, item_type, item_key),
                    CHECK (item_type IN ('swing'))
                )
            `);
            await query(`
                CREATE INDEX IF NOT EXISTS idx_stock_signal_snapshots_user_recent
                ON stock_signal_snapshots(user_id, item_type, analyzed_at DESC)
            `);
            await query(`
                CREATE INDEX IF NOT EXISTS idx_stock_signal_snapshots_active
                ON stock_signal_snapshots(user_id, item_type, expires_at DESC)
            `);
        })().catch((error) => {
            snapshotSchemaReady = null;
            throw error;
        });
    }

    return snapshotSchemaReady;
}

async function cleanupExpiredSnapshots() {
    await ensureSnapshotSchema();
    await query(`
        DELETE FROM stock_signal_snapshots
        WHERE expires_at IS NOT NULL
          AND expires_at <= CURRENT_TIMESTAMP
    `);
}

async function getLatestAnalyzedAt(userId) {
    await ensureSnapshotSchema();
    const result = await query(`
        SELECT MAX(analyzed_at) AS last_analyzed_at
        FROM stock_signal_snapshots
        WHERE user_id = $1
          AND item_type = 'swing'
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `, [userId]);

    return result.rows[0]?.last_analyzed_at ? new Date(result.rows[0].last_analyzed_at) : null;
}

async function refreshUserSwingSnapshots(userId, options = {}) {
    await ensureSnapshotSchema();
    await cleanupExpiredSnapshots();

    const latestAnalyzedAt = await getLatestAnalyzedAt(userId);
    if (!options.force && latestAnalyzedAt && (Date.now() - latestAnalyzedAt.getTime()) < getFreshnessMs()) {
        return { refreshed: false, reason: 'fresh' };
    }

    const trackedSymbols = await getTrackedSymbols(userId);
    const swingItems = (await Promise.all(trackedSymbols.map((symbol) => buildSwingFeedItem(symbol))))
        .filter(Boolean);

    const activeKeys = swingItems.map((item) => item.dismissalKey || String(item.id).replace(/^swing:/, ''));

    for (const item of swingItems) {
        const itemKey = item.dismissalKey || String(item.id).replace(/^swing:/, '');
        await query(`
            INSERT INTO stock_signal_snapshots (
                user_id,
                item_type,
                item_key,
                symbol,
                title,
                summary,
                signal,
                recommendation,
                source_label,
                priority_score,
                popup_eligible,
                sentiment_score,
                created_at,
                analyzed_at,
                expires_at,
                payload
            ) VALUES (
                $1,
                'swing',
                $2,
                $3,
                $4,
                $5,
                $6,
                $7,
                $8,
                $9,
                $10,
                $11,
                $12,
                CURRENT_TIMESTAMP,
                ${snapshotExpirySql()},
                $13::jsonb
            )
            ON CONFLICT (user_id, item_type, item_key) DO UPDATE
            SET symbol = EXCLUDED.symbol,
                title = EXCLUDED.title,
                summary = EXCLUDED.summary,
                signal = EXCLUDED.signal,
                recommendation = EXCLUDED.recommendation,
                source_label = EXCLUDED.source_label,
                priority_score = EXCLUDED.priority_score,
                popup_eligible = EXCLUDED.popup_eligible,
                sentiment_score = EXCLUDED.sentiment_score,
                created_at = EXCLUDED.created_at,
                analyzed_at = CURRENT_TIMESTAMP,
                expires_at = EXCLUDED.expires_at,
                payload = EXCLUDED.payload
        `, [
            userId,
            itemKey,
            item.symbol,
            item.title,
            item.summary,
            item.signal,
            item.recommendation || null,
            item.sourceLabel || null,
            Number.isFinite(item.priorityScore) ? Math.round(item.priorityScore) : null,
            Boolean(item.popupEligible),
            item.sentimentScore === null || item.sentimentScore === undefined ? null : Number(item.sentimentScore),
            item.createdAt || new Date().toISOString(),
            JSON.stringify(item.meta || {})
        ]);
    }

    if (activeKeys.length > 0) {
        await query(`
            DELETE FROM stock_signal_snapshots
            WHERE user_id = $1
              AND item_type = 'swing'
              AND item_key <> ALL($2::text[])
        `, [userId, activeKeys]);
    } else {
        await query(`
            DELETE FROM stock_signal_snapshots
            WHERE user_id = $1
              AND item_type = 'swing'
        `, [userId]);
    }

    return {
        refreshed: true,
        trackedSymbols,
        snapshotCount: swingItems.length
    };
}

async function getUserSwingSnapshots(userId, options = {}) {
    const { limit = 25, refreshIfStale = false } = options;
    await ensureSnapshotSchema();

    if (refreshIfStale) {
        await refreshUserSwingSnapshots(userId);
    }

    const result = await query(`
        SELECT item_key, symbol, title, summary, signal, recommendation, source_label,
               priority_score, popup_eligible, sentiment_score, created_at, analyzed_at, payload
        FROM stock_signal_snapshots
        WHERE user_id = $1
          AND item_type = 'swing'
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
        ORDER BY priority_score DESC NULLS LAST, created_at DESC
        LIMIT $2
    `, [userId, limit]);

    return result.rows.map(mapSnapshotRow);
}

async function getActiveSnapshotUsers() {
    await ensureSnapshotSchema();
    const result = await query(`
        SELECT id, username
        FROM users
        WHERE is_active = true
        ORDER BY created_at ASC
    `);
    return result.rows;
}

module.exports = {
    getActiveSnapshotUsers,
    getUserSwingSnapshots,
    refreshUserSwingSnapshots
};