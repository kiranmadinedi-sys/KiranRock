const { query } = require('../config/database');
const newsMonitoringService = require('./newsMonitoringService');
const stockSignalAnalysisService = require('./stockSignalAnalysisService');
const stockSignalSnapshotService = require('./stockSignalSnapshotService');
const DEFAULT_POPUP_PREFERENCES = {
    popupMode: 'both',
    popupMinPriority: 72
};

let stockFeedSchemaReady = null;

function ensureStockFeedSchema() {
    if (!stockFeedSchemaReady) {
        stockFeedSchemaReady = (async () => {
            await query(`
                CREATE TABLE IF NOT EXISTS stock_feed_popup_preferences (
                    user_id VARCHAR(50) PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                    popup_mode VARCHAR(20) NOT NULL DEFAULT 'both',
                    popup_min_priority INTEGER NOT NULL DEFAULT 72,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    CHECK (popup_mode IN ('off', 'news', 'swing', 'both')),
                    CHECK (popup_min_priority BETWEEN 0 AND 100)
                )
            `);
            await query(`
                CREATE TABLE IF NOT EXISTS stock_feed_dismissals (
                    id SERIAL PRIMARY KEY,
                    user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    item_type VARCHAR(20) NOT NULL,
                    item_key VARCHAR(200) NOT NULL,
                    symbol VARCHAR(10),
                    dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    expires_at TIMESTAMP,
                    UNIQUE(user_id, item_type, item_key),
                    CHECK (item_type IN ('news', 'swing'))
                )
            `);
            await query(`
                CREATE INDEX IF NOT EXISTS idx_stock_feed_dismissals_active
                ON stock_feed_dismissals(user_id, item_type, expires_at DESC)
            `);
        })().catch((error) => {
            stockFeedSchemaReady = null;
            throw error;
        });
    }

    return stockFeedSchemaReady;
}

function sanitizePopupMode(value) {
    return ['off', 'news', 'swing', 'both'].includes(value) ? value : DEFAULT_POPUP_PREFERENCES.popupMode;
}

function sanitizePopupPriority(value) {
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_POPUP_PREFERENCES.popupMinPriority;
    }

    return Math.min(100, Math.max(0, parsed));
}

function getNewsPriority(alert) {
    const severityWeight = {
        High: 90,
        Medium: 72,
        Low: 55
    };

    const impactWeight = {
        High: 8,
        Medium: 4,
        Low: 1
    };

    return (severityWeight[alert.severity] || 50) + (impactWeight[alert.impact] || 0);
}

function buildNewsQuality(alert) {
    const publishedAt = alert.publishedAt || alert.createdAt;
    const ageMinutes = publishedAt ? Math.max(0, Math.round((Date.now() - new Date(publishedAt).getTime()) / 60000)) : null;
    const fresh = ageMinutes === null ? false : ageMinutes <= 24 * 60;
    const hasSource = Boolean(alert.source);
    const severityBoost = alert.severity === 'High' ? 15 : alert.severity === 'Medium' ? 8 : 0;
    const sentimentBoost = Math.min(10, Math.round(Math.abs(Number(alert.sentimentScore || 0)) * 10));
    const freshnessBoost = ageMinutes === null ? 0 : Math.max(0, 20 - Math.floor(ageMinutes / 90));
    const qualityScore = Math.min(100, 45 + severityBoost + sentimentBoost + freshnessBoost + (hasSource ? 10 : 0));

    let qualityTier = 'Low';
    if (qualityScore >= 80) {
        qualityTier = 'High';
    } else if (qualityScore >= 68) {
        qualityTier = 'Medium';
    }

    return {
        ageMinutes,
        fresh,
        hasSource,
        qualityScore,
        qualityTier
    };
}

function getFreshnessState(ageMinutes, type) {
    if (!Number.isFinite(ageMinutes)) {
        return 'unknown';
    }

    if (type === 'news') {
        if (ageMinutes <= 180) {
            return 'fresh';
        }

        if (ageMinutes <= 24 * 60) {
            return 'aging';
        }

        return 'stale';
    }

    if (ageMinutes <= 30) {
        return 'fresh';
    }

    if (ageMinutes <= 4 * 60) {
        return 'aging';
    }

    return 'stale';
}

function decorateFeedItem(item) {
    if (item.type === 'news') {
        const newsQuality = buildNewsQuality(item);
        const freshnessState = getFreshnessState(newsQuality.ageMinutes, 'news');
        return {
            ...item,
            popupEligible: Boolean(item.popupEligible && newsQuality.fresh && newsQuality.qualityScore >= 68),
            meta: {
                ...(item.meta || {}),
                freshnessMinutes: newsQuality.ageMinutes,
                freshnessState,
                fresh: newsQuality.fresh,
                hasSource: newsQuality.hasSource,
                qualityScore: newsQuality.qualityScore,
                qualityTier: newsQuality.qualityTier,
                analyzedAt: item.publishedAt || item.createdAt || null
            }
        };
    }

    const freshnessMinutes = item.meta?.freshnessMinutes ?? Math.max(0, Math.round((Date.now() - new Date(item.analyzedAt || item.createdAt).getTime()) / 60000));

    return {
        ...item,
        meta: {
            ...(item.meta || {}),
            qualityScore: item.meta?.qualityScore || item.priorityScore || 0,
            qualityTier: item.meta?.qualityTier || 'Medium',
            freshnessMinutes,
            freshnessState: item.meta?.freshnessState || getFreshnessState(freshnessMinutes, item.type),
            analyzedAt: item.analyzedAt || item.meta?.analyzedAt || item.createdAt
        }
    };
}

function buildFeedSummary(items) {
    return items.reduce((summary, item) => {
        summary.total += 1;

        if (!item.read) {
            summary.unread += 1;
        }

        if (item.popupEligible) {
            summary.popupEligible += 1;
        }

        if (item.type === 'swing' && item.recommendation === 'BUY') {
            summary.actionableBuys += 1;
        }

        const freshnessState = item.meta?.freshnessState || 'unknown';
        if (freshnessState === 'fresh') {
            summary.fresh += 1;
        } else if (freshnessState === 'aging') {
            summary.aging += 1;
        } else if (freshnessState === 'stale') {
            summary.stale += 1;
        } else {
            summary.unknown += 1;
        }

        return summary;
    }, {
        total: 0,
        unread: 0,
        popupEligible: 0,
        actionableBuys: 0,
        fresh: 0,
        aging: 0,
        stale: 0,
        unknown: 0
    });
}

function buildNewsFeedItem(alert) {
    const priorityScore = getNewsPriority(alert);

    return {
        id: `news:${alert.id}`,
        type: 'news',
        symbol: alert.symbol,
        title: alert.title,
        summary: alert.summary || alert.title,
        link: alert.link || null,
        source: alert.source || null,
        sourceLabel: alert.severity ? `${alert.severity} impact news` : 'News catalyst',
        signal: null,
        severity: alert.severity || 'Low',
        impact: alert.impact || 'Low',
        sentimentImpact: alert.sentimentImpact || 'Neutral',
        sentimentScore: alert.sentimentScore,
        priorityScore,
        popupEligible: !alert.read && priorityScore >= 72,
        read: Boolean(alert.read),
        createdAt: alert.publishedAt || alert.createdAt || new Date().toISOString()
    };
}

function mapPopupPreferences(row) {
    return {
        popupMode: sanitizePopupMode(row?.popup_mode),
        popupMinPriority: sanitizePopupPriority(row?.popup_min_priority)
    };
}

async function getPopupPreferences(userId) {
    await ensureStockFeedSchema();

    const result = await query(`
        INSERT INTO stock_feed_popup_preferences (user_id, popup_mode, popup_min_priority)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE
        SET user_id = EXCLUDED.user_id
        RETURNING popup_mode, popup_min_priority
    `, [
        userId,
        DEFAULT_POPUP_PREFERENCES.popupMode,
        DEFAULT_POPUP_PREFERENCES.popupMinPriority
    ]);

    return mapPopupPreferences(result.rows[0]);
}

async function updatePopupPreferences(userId, updates = {}) {
    await ensureStockFeedSchema();

    const popupMode = sanitizePopupMode(updates.popupMode);
    const popupMinPriority = sanitizePopupPriority(updates.popupMinPriority);

    const result = await query(`
        INSERT INTO stock_feed_popup_preferences (user_id, popup_mode, popup_min_priority)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id) DO UPDATE
        SET popup_mode = EXCLUDED.popup_mode,
            popup_min_priority = EXCLUDED.popup_min_priority,
            updated_at = CURRENT_TIMESTAMP
        RETURNING popup_mode, popup_min_priority
    `, [userId, popupMode, popupMinPriority]);

    return mapPopupPreferences(result.rows[0]);
}

async function getActiveDismissalKeys(userId) {
    await ensureStockFeedSchema();

    await query(`
        DELETE FROM stock_feed_dismissals
        WHERE expires_at IS NOT NULL
          AND expires_at <= CURRENT_TIMESTAMP
    `);

    const result = await query(`
        SELECT item_key
        FROM stock_feed_dismissals
        WHERE user_id = $1
          AND item_type = 'swing'
          AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    `, [userId]);

    return new Set(result.rows.map((row) => row.item_key));
}

function supportsPopupMode(itemType, popupMode) {
    if (popupMode === 'off') {
        return false;
    }

    if (popupMode === 'both') {
        return true;
    }

    return popupMode === itemType;
}

async function getStockFeed(options = {}) {
    const { userId, limit = 25, popupOnly = false, refreshSnapshots = false, includeStaleNews = false } = options;
    await ensureStockFeedSchema();
    const trackedSymbols = await stockSignalAnalysisService.getTrackedSymbols(userId);
    const trackedSet = new Set(trackedSymbols);

    const [popupPreferences, dismissedSwingKeys, newsAlerts, swingItems] = await Promise.all([
        getPopupPreferences(userId),
        getActiveDismissalKeys(userId),
        newsMonitoringService.getNewsAlerts({ limit: Math.max(limit, 30) }),
        stockSignalSnapshotService.getUserSwingSnapshots(userId, {
            limit: Math.max(limit, 12),
            refreshIfStale: refreshSnapshots
        })
    ]);

    const newsItems = newsAlerts
        .filter((alert) => trackedSet.has(alert.symbol))
        .map(buildNewsFeedItem);

    const mergedItems = [...newsItems, ...swingItems]
        .map((item) => {
            const isSwingDismissed = item.type === 'swing' && dismissedSwingKeys.has(item.dismissalKey || item.id);
            const decoratedItem = decorateFeedItem(item);
            const popupEligible = Boolean(
                decoratedItem.popupEligible &&
                supportsPopupMode(decoratedItem.type, popupPreferences.popupMode) &&
                decoratedItem.priorityScore >= popupPreferences.popupMinPriority &&
                !isSwingDismissed
            );

            return {
                ...decoratedItem,
                popupEligible,
                read: Boolean(decoratedItem.read || isSwingDismissed)
            };
        })
        .sort((left, right) => {
            if (right.priorityScore !== left.priorityScore) {
                return right.priorityScore - left.priorityScore;
            }

            return new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
        });

    const hiddenStaleNewsCount = includeStaleNews
        ? 0
        : mergedItems.filter((item) => item.type === 'news' && item.meta?.freshnessState === 'stale').length;

    const filteredItems = includeStaleNews
        ? mergedItems
        : mergedItems.filter((item) => item.type !== 'news' || item.meta?.freshnessState !== 'stale');

    const items = popupOnly
        ? filteredItems.filter((item) => item.popupEligible && !item.read)
        : filteredItems;
    const visibleItems = items.slice(0, limit);

    return {
        trackedSymbols,
        preferences: popupPreferences,
        items: visibleItems,
        summary: {
            ...buildFeedSummary(visibleItems),
            hiddenStaleNewsCount,
            includeStaleNews: Boolean(includeStaleNews)
        }
    };
}

async function markFeedItemRead({ itemId, type, userId }) {
    await ensureStockFeedSchema();
    const resolvedType = type || (String(itemId).startsWith('news:') ? 'news' : 'swing');

    if (resolvedType === 'news') {
        const newsId = String(itemId).replace(/^news:/, '');
        await newsMonitoringService.markAlertRead(newsId);
    } else if (resolvedType === 'swing') {
        const itemKey = String(itemId).replace(/^swing:/, '');
        const symbol = itemKey.split(':')[0] || null;

        await query(`
            INSERT INTO stock_feed_dismissals (user_id, item_type, item_key, symbol, expires_at)
            VALUES ($1, 'swing', $2, $3, CURRENT_TIMESTAMP + INTERVAL '7 days')
            ON CONFLICT (user_id, item_type, item_key) DO UPDATE
            SET symbol = EXCLUDED.symbol,
                dismissed_at = CURRENT_TIMESTAMP,
                expires_at = EXCLUDED.expires_at
        `, [userId, itemKey, symbol]);
    }

    return { success: true };
}

module.exports = {
    getStockFeed,
    getPopupPreferences,
    updatePopupPreferences,
    markFeedItemRead
};