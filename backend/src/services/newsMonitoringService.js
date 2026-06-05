const { getAggregatedNews } = require('./newsAggregationService');
const { getTrackedSymbols } = require('./stockSignalAnalysisService');
const { isXConfigured } = require('./xNewsService');
const { query } = require('../config/database');

const CHECK_INTERVAL = 5 * 60 * 1000; // Check every 5 minutes
const MAX_NEWS_SYMBOLS_PER_CYCLE = Math.max(6, Number.parseInt(process.env.NEWS_MONITOR_MAX_SYMBOLS || '20', 10) || 20);
const MAX_NEWS_AGE_HOURS = Math.max(1, Number.parseInt(process.env.NEWS_MONITOR_MAX_AGE_HOURS || '30', 10) || 30);
const DEDUPE_LOOKBACK_DAYS = Math.max(1, Number.parseInt(process.env.NEWS_MONITOR_DEDUPE_LOOKBACK_DAYS || '7', 10) || 7);

let monitoringInterval = null;
let watchedSymbols = new Set();
let newsAlertsSchemaReady = null;
let monitorRunInProgress = false;
let lastRunStartedAt = null;
let lastRunFinishedAt = null;
let lastRunSummary = null;
let lastRunError = null;
let totalRuns = 0;

function ensureNewsAlertsSchema() {
    if (!newsAlertsSchemaReady) {
        newsAlertsSchemaReady = (async () => {
            await query(`
                ALTER TABLE news_alerts
                    ADD COLUMN IF NOT EXISTS impact VARCHAR(20),
                    ADD COLUMN IF NOT EXISTS severity VARCHAR(20),
                    ADD COLUMN IF NOT EXISTS sentiment_impact VARCHAR(30),
                    ADD COLUMN IF NOT EXISTS sentiment_score DECIMAL(6, 4),
                    ADD COLUMN IF NOT EXISTS keywords JSONB DEFAULT '[]'::jsonb,
                    ADD COLUMN IF NOT EXISTS viewed BOOLEAN DEFAULT false
            `);
            await query(`
                CREATE TABLE IF NOT EXISTS news_monitor_runs (
                    id SERIAL PRIMARY KEY,
                    started_at TIMESTAMP,
                    finished_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    monitored_symbols INTEGER DEFAULT 0,
                    raw_articles INTEGER DEFAULT 0,
                    recent_articles INTEGER DEFAULT 0,
                    matched_articles INTEGER DEFAULT 0,
                    saved_alerts INTEGER DEFAULT 0,
                    duplicate_skips INTEGER DEFAULT 0,
                    quality_skips INTEGER DEFAULT 0,
                    no_ticker_match_skips INTEGER DEFAULT 0,
                    stale_skips INTEGER DEFAULT 0,
                    error TEXT,
                    sources JSONB DEFAULT '{}'::jsonb
                )
            `);
            await query(`
                CREATE INDEX IF NOT EXISTS idx_news_monitor_runs_finished_at
                ON news_monitor_runs(finished_at DESC)
            `);
        })().catch((error) => {
            newsAlertsSchemaReady = null;
            throw error;
        });
    }

    return newsAlertsSchemaReady;
}

function getConfiguredSources() {
    return {
        yahoo: true,
        alphaVantage: Boolean(process.env.ALPHA_VANTAGE_KEY),
        finnhub: Boolean(process.env.FINNHUB_KEY),
        newsApi: Boolean(process.env.NEWSAPI_KEY),
        x: isXConfigured()
    };
}

async function recordMonitoringRun(summary, error = null) {
    await ensureNewsAlertsSchema();
    await query(`
        INSERT INTO news_monitor_runs (
            started_at,
            finished_at,
            monitored_symbols,
            raw_articles,
            recent_articles,
            matched_articles,
            saved_alerts,
            duplicate_skips,
            quality_skips,
            no_ticker_match_skips,
            stale_skips,
            error,
            sources
        ) VALUES (
            $1,
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
            $13::jsonb
        )
    `, [
        lastRunStartedAt,
        lastRunFinishedAt,
        summary?.monitoredSymbols || 0,
        summary?.rawArticles || 0,
        summary?.recentArticles || 0,
        summary?.matchedArticles || 0,
        summary?.savedAlerts || 0,
        summary?.duplicateSkips || 0,
        summary?.qualitySkips || 0,
        summary?.noTickerMatchSkips || 0,
        summary?.staleSkips || 0,
        error,
        JSON.stringify(getConfiguredSources())
    ]);
}

async function getRecentMonitoringRuns(limit = 8) {
    await ensureNewsAlertsSchema();
    const result = await query(`
        SELECT id, started_at, finished_at, monitored_symbols, raw_articles, recent_articles,
               matched_articles, saved_alerts, duplicate_skips, quality_skips,
               no_ticker_match_skips, stale_skips, error, sources
        FROM news_monitor_runs
        ORDER BY finished_at DESC, id DESC
        LIMIT $1
    `, [limit]);

    return result.rows.map((row) => ({
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        monitoredSymbols: Number(row.monitored_symbols || 0),
        rawArticles: Number(row.raw_articles || 0),
        recentArticles: Number(row.recent_articles || 0),
        matchedArticles: Number(row.matched_articles || 0),
        savedAlerts: Number(row.saved_alerts || 0),
        duplicateSkips: Number(row.duplicate_skips || 0),
        qualitySkips: Number(row.quality_skips || 0),
        noTickerMatchSkips: Number(row.no_ticker_match_skips || 0),
        staleSkips: Number(row.stale_skips || 0),
        error: row.error || null,
        sources: row.sources || {}
    }));
}

/**
 * News Impact Monitoring Service
 * Real-time monitoring of major news with impact analysis
 */

/**
 * Analyze news impact severity
 */
function analyzeNewsImpact(article, sentiment) {
    let impact = 'Low';
    let severity = 'Low';
    
    const title = article.title?.toLowerCase() || '';
    const summary = article.summary?.toLowerCase() || '';
    const text = title + ' ' + summary;
    
    // High impact keywords
    const highImpactKeywords = [
        'earnings', 'acquisition', 'merger', 'fda approval', 'fda rejection',
        'bankruptcy', 'lawsuit', 'investigation', 'recall', 'ceo', 'restructuring',
        'dividend', 'stock split', 'buyback', 'guidance', 'partnership'
    ];
    
    // Medium impact keywords
    const mediumImpactKeywords = [
        'analyst upgrade', 'analyst downgrade', 'price target', 'revenue',
        'contract', 'expansion', 'layoff', 'hiring', 'product launch'
    ];
    
    // Check for high impact
    const hasHighImpact = highImpactKeywords.some(keyword => text.includes(keyword));
    const hasMediumImpact = mediumImpactKeywords.some(keyword => text.includes(keyword));
    
    if (hasHighImpact) {
        impact = 'High';
        severity = 'High';
    } else if (hasMediumImpact) {
        impact = 'Medium';
        severity = 'Medium';
    }
    
    // Adjust based on sentiment
    let sentimentImpact = 'Neutral';
    if (sentiment.score > 0.3) {
        sentimentImpact = sentiment.score > 0.6 ? 'Very Positive' : 'Positive';
    } else if (sentiment.score < -0.3) {
        sentimentImpact = sentiment.score < -0.6 ? 'Very Negative' : 'Negative';
    }
    
    return {
        impact,
        severity,
        sentimentImpact,
        sentimentScore: sentiment.score,
        keywords: highImpactKeywords.filter(k => text.includes(k))
            .concat(mediumImpactKeywords.filter(k => text.includes(k)))
    };
}

function normalizeTimestamp(value) {
    if (!value) {
        return null;
    }

    if (value instanceof Date && Number.isFinite(value.getTime())) {
        return value.toISOString();
    }

    const raw = String(value).trim();
    if (!raw) {
        return null;
    }

    if (/^\d{8}T\d{6}$/.test(raw)) {
        const normalized = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
        const parsed = new Date(normalized);
        return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    }

    const parsed = new Date(raw);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeArticle(article) {
    return {
        title: article?.title || article?.headline || '',
        summary: article?.summary || article?.description || article?.title || article?.headline || '',
        link: article?.link || article?.url || null,
        source: article?.source || article?.publisher || null,
        publishedAt: normalizeTimestamp(article?.publishedAt || article?.published_at || article?.pubDate),
        tickers: Array.isArray(article?.tickers)
            ? article.tickers.map((ticker) => String(ticker || '').toUpperCase()).filter(Boolean)
            : [],
        sentimentScore: Number.isFinite(Number(article?.sentiment)) ? Number(article.sentiment) : 0,
        marketImpact: Number.isFinite(Number(article?.market_impact)) ? Number(article.market_impact) : 0
    };
}

function isRecentArticle(article) {
    if (!article.publishedAt) {
        return false;
    }

    const publishedAtMs = new Date(article.publishedAt).getTime();
    if (!Number.isFinite(publishedAtMs)) {
        return false;
    }

    return (Date.now() - publishedAtMs) <= (MAX_NEWS_AGE_HOURS * 60 * 60 * 1000);
}

function shouldPersistAlert(article, analysis) {
    if (!article.title || article.title.length < 12) {
        return false;
    }

    if (!article.source) {
        return false;
    }

    if (analysis.severity !== 'Low') {
        return true;
    }

    return Math.abs(Number(analysis.sentimentScore || 0)) >= 0.65 || article.marketImpact >= 4;
}

function getMatchedSymbols(article, trackedSymbols) {
    // Suppress matches when the source explicitly flagged low ticker confidence
    // (e.g. Yahoo articles that don't actually mention the queried symbol).
    if (article.tickerConfidence === 'none') return [];
    const articleSymbols = new Set(article.tickers || []);
    return trackedSymbols.filter((symbol) => articleSymbols.has(symbol));
}

async function getMonitoredSymbols(seedSymbols = []) {
    const symbolSet = new Set([...seedSymbols].map((symbol) => String(symbol || '').toUpperCase()).filter(Boolean));

    try {
        const result = await query(`
            SELECT id
            FROM users
            WHERE is_active = true
            ORDER BY created_at ASC
        `);

        const symbolGroups = await Promise.all(result.rows.map(async (row) => {
            try {
                return await getTrackedSymbols(row.id);
            } catch (error) {
                console.warn('[News Monitor] Failed to load tracked symbols for user:', row.id, error.message);
                return [];
            }
        }));

        for (const symbols of symbolGroups) {
            for (const symbol of symbols) {
                symbolSet.add(String(symbol || '').toUpperCase());
            }
        }
    } catch (error) {
        console.warn('[News Monitor] Failed to expand watched symbols from active users:', error.message);
    }

    return Array.from(symbolSet).filter(Boolean).slice(0, MAX_NEWS_SYMBOLS_PER_CYCLE);
}

async function hasRecentDuplicate(symbol, article) {
    const normalizedTitle = String(article.title || '').trim();
    const normalizedLink = article.link || null;
    const result = await query(`
        SELECT id
        FROM news_alerts
        WHERE symbol = $1
          AND (
                ($2::text IS NOT NULL AND url = $2)
                OR LOWER(title) = LOWER($3)
              )
          AND COALESCE(published_at, created_at) >= CURRENT_TIMESTAMP - ($4::text || ' days')::interval
        LIMIT 1
    `, [symbol, normalizedLink, normalizedTitle, String(DEDUPE_LOOKBACK_DAYS)]);

    return result.rowCount > 0;
}

/**
 * Create news alert
 */
async function createNewsAlert(symbol, article, analysis) {
    await ensureNewsAlertsSchema();

    const alert = {
        symbol,
        title: article.title,
        summary: article.summary || article.title,
        link: article.link || article.url,
        source: article.source || null,
        publishedAt: article.publishedAt || article.published_at || article.pubDate,
        impact: analysis.impact,
        severity: analysis.severity,
        sentimentImpact: analysis.sentimentImpact,
        sentimentScore: analysis.sentimentScore,
        keywords: analysis.keywords,
        createdAt: new Date().toISOString(),
        read: false
    };
    
    // Save alert
    const savedAlert = await saveNewsAlert(alert);
    
    console.log(`[News Alert] ${analysis.severity.toUpperCase()} impact for ${symbol}: ${article.title}`);
    
    return savedAlert;
}

/**
 * Save news alert to database
 */
async function saveNewsAlert(alert) {
    try {
        await ensureNewsAlertsSchema();

        const result = await query(`
            INSERT INTO news_alerts (
                symbol,
                title,
                summary,
                url,
                source,
                sentiment,
                published_at,
                impact,
                severity,
                sentiment_impact,
                sentiment_score,
                keywords,
                viewed
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, false)
            ON CONFLICT (symbol, LOWER(REGEXP_REPLACE(TRIM(title), '\\s+', ' ', 'g')))
            DO UPDATE SET
                summary          = COALESCE(EXCLUDED.summary, news_alerts.summary),
                url              = COALESCE(EXCLUDED.url, news_alerts.url),
                source           = COALESCE(EXCLUDED.source, news_alerts.source),
                severity         = GREATEST(EXCLUDED.severity, news_alerts.severity),
                sentiment_score  = COALESCE(EXCLUDED.sentiment_score, news_alerts.sentiment_score)
            RETURNING id, symbol, title, summary, url, source, published_at, impact, severity,
                      sentiment_impact, sentiment_score, keywords, created_at, viewed
        `, [
            alert.symbol,
            alert.title,
            alert.summary,
            alert.link || null,
            alert.source || null,
            alert.sentimentImpact || null,
            alert.publishedAt || null,
            alert.impact || null,
            alert.severity || null,
            alert.sentimentImpact || null,
            alert.sentimentScore ?? null,
            JSON.stringify(alert.keywords || [])
        ]);

        return mapNewsAlertRow(result.rows[0]);
    } catch (error) {
        console.error('[News Alert] Error saving alert:', error);
        throw error;
    }
}

function mapNewsAlertRow(row) {
    return {
        id: row.id,
        symbol: row.symbol,
        title: row.title,
        summary: row.summary,
        link: row.url,
        source: row.source,
        publishedAt: row.published_at,
        impact: row.impact,
        severity: row.severity,
        sentimentImpact: row.sentiment_impact,
        sentimentScore: row.sentiment_score === null ? null : Number(row.sentiment_score),
        keywords: Array.isArray(row.keywords) ? row.keywords : [],
        createdAt: row.created_at,
        read: Boolean(row.viewed)
    };
}

/**
 * Get news alerts
 */
async function getNewsAlerts(options = {}) {
    try {
        await ensureNewsAlertsSchema();

        const { symbol, severity, unreadOnly, limit = 50 } = options;

        const conditions = [];
        const params = [];

        if (symbol) {
            params.push(symbol.toUpperCase());
            conditions.push(`symbol = $${params.length}`);
        }

        if (severity) {
            params.push(severity);
            conditions.push(`severity = $${params.length}`);
        }

        if (unreadOnly) {
            conditions.push('COALESCE(viewed, false) = false');
        }

        params.push(limit);

        const result = await query(`
            SELECT id, symbol, title, summary, url, source, published_at, impact, severity,
                   sentiment_impact, sentiment_score, keywords, created_at, viewed
            FROM news_alerts
            ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
            ORDER BY created_at DESC
            LIMIT $${params.length}
        `, params);

        return result.rows.map(mapNewsAlertRow);
    } catch (error) {
        console.error('[News Alert] Error getting alerts:', error.message);
        return [];
    }
}

/**
 * Mark alert as read
 */
async function markAlertRead(alertId) {
    try {
        await ensureNewsAlertsSchema();

        await query(`
            UPDATE news_alerts
            SET viewed = true
            WHERE id = $1
        `, [alertId]);
    } catch (error) {
        console.error('[News Alert] Error marking alert as read:', error);
    }
}

/**
 * Monitor news for symbols
 */
async function monitorNews(symbols) {
    if (monitorRunInProgress) {
        return [];
    }

    monitorRunInProgress = true;
    lastRunStartedAt = new Date().toISOString();
    lastRunError = null;

    try {
        const trackedSymbols = await getMonitoredSymbols(symbols || Array.from(watchedSymbols));
        console.log(`[News Monitor] Checking news for ${trackedSymbols.length} symbols...`);

        if (trackedSymbols.length === 0) {
            lastRunFinishedAt = new Date().toISOString();
            lastRunSummary = {
                monitoredSymbols: 0,
                rawArticles: 0,
                recentArticles: 0,
                matchedArticles: 0,
                savedAlerts: 0,
                duplicateSkips: 0,
                qualitySkips: 0,
                noTickerMatchSkips: 0,
                staleSkips: 0
            };
            totalRuns += 1;
            await recordMonitoringRun(lastRunSummary, null);
            return [];
        }

        const aggregatedNews = await getAggregatedNews(trackedSymbols, false);
        const alerts = [];
        let recentArticles = 0;
        let matchedArticles = 0;
        let duplicateSkips = 0;
        let qualitySkips = 0;
        let noTickerMatchSkips = 0;
        let staleSkips = 0;

        for (const rawArticle of aggregatedNews) {
            const article = normalizeArticle(rawArticle);
            if (!isRecentArticle(article)) {
                staleSkips += 1;
                continue;
            }
            recentArticles += 1;

            const matchedSymbols = getMatchedSymbols(article, trackedSymbols);
            if (matchedSymbols.length === 0) {
                noTickerMatchSkips += 1;
                continue;
            }
            matchedArticles += 1;

            const analysis = analyzeNewsImpact({
                title: article.title,
                summary: article.summary
            }, {
                score: article.sentimentScore
            });

            if (!shouldPersistAlert(article, analysis)) {
                qualitySkips += 1;
                continue;
            }

            for (const symbol of matchedSymbols) {
                const duplicate = await hasRecentDuplicate(symbol, article);
                if (duplicate) {
                    duplicateSkips += 1;
                    continue;
                }

                const savedAlert = await createNewsAlert(symbol, article, analysis);
                alerts.push(savedAlert);
            }
        }

        if (alerts.length > 0) {
            console.log(`[News Monitor] Saved ${alerts.length} fresh news alert(s)`);
        }

        lastRunFinishedAt = new Date().toISOString();
        lastRunSummary = {
            monitoredSymbols: trackedSymbols.length,
            rawArticles: aggregatedNews.length,
            recentArticles,
            matchedArticles,
            savedAlerts: alerts.length,
            duplicateSkips,
            qualitySkips,
            noTickerMatchSkips,
            staleSkips
        };
        totalRuns += 1;
        await recordMonitoringRun(lastRunSummary, null);

        return alerts;
    } catch (error) {
        console.error('[News Monitor] Failed to ingest news:', error.message);
        lastRunFinishedAt = new Date().toISOString();
        lastRunError = error.message;
        if (!lastRunSummary) {
            lastRunSummary = {
                monitoredSymbols: 0,
                rawArticles: 0,
                recentArticles: 0,
                matchedArticles: 0,
                savedAlerts: 0,
                duplicateSkips: 0,
                qualitySkips: 0,
                noTickerMatchSkips: 0,
                staleSkips: 0
            };
        }
        await recordMonitoringRun(lastRunSummary, error.message);
        return [];
    } finally {
        monitorRunInProgress = false;
    }
}

async function getMonitoringStatus() {
    await ensureNewsAlertsSchema();

    const [recentResult, unreadResult, runCountResult, recentRuns] = await Promise.all([
        query(`
            SELECT COUNT(*)::int AS count
            FROM news_alerts
            WHERE COALESCE(published_at, created_at) >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
        `),
        query(`
            SELECT COUNT(*)::int AS count
            FROM news_alerts
            WHERE COALESCE(viewed, false) = false
              AND COALESCE(published_at, created_at) >= CURRENT_TIMESTAMP - INTERVAL '24 hours'
        `),
        query(`
            SELECT COUNT(*)::int AS count
            FROM news_monitor_runs
        `),
        getRecentMonitoringRuns(8)
    ]);

    return {
        running: Boolean(monitoringInterval),
        inProgress: monitorRunInProgress,
        checkIntervalMinutes: Math.round(CHECK_INTERVAL / 60000),
        watchedSymbols: Array.from(watchedSymbols),
        watchedSymbolCount: watchedSymbols.size,
        lastRunStartedAt,
        lastRunFinishedAt,
        lastRunSummary,
        lastRunError,
        totalRuns: runCountResult.rows[0]?.count ?? totalRuns,
        recentAlerts24h: recentResult.rows[0]?.count || 0,
        unreadAlerts24h: unreadResult.rows[0]?.count || 0,
        sources: getConfiguredSources(),
        recentRuns
    };
}

/**
 * Refresh the news watchlist from three live sources (union, deduplicated):
 *   1. HERMES stock universe — top RS-scored stocks being actively analyzed
 *   2. User holdings       — stocks users actually own (highest priority)
 *   3. Seed symbols        — baseline passed at startup (never dropped)
 *
 * Capped at MAX_NEWS_SYMBOLS_PER_CYCLE so the monitor stays fast.
 * Silently falls back to the existing watchedSymbols on any error.
 */
async function refreshWatchlistFromUniverse(seedSymbols = []) {
    try {
        const merged = new Set(seedSymbols.map(s => s.toUpperCase()));

        // 1. User holdings — most important: owners need news on their stocks
        try {
            const { query: dbQuery } = require('../config/database');
            const held = await dbQuery(`
                SELECT DISTINCT symbol FROM holdings
                WHERE symbol IS NOT NULL AND symbol <> ''
                LIMIT 100
            `);
            held.rows.forEach(r => merged.add(r.symbol));
        } catch (_) {}

        // 2. HERMES universe — RS-sorted, already filtered for quality
        try {
            const marketScreenerService = require('./marketScreenerService');
            const universe = await marketScreenerService.getStockUniverse();
            // Take top symbols by RS score (universe is already sorted RS DESC)
            universe.slice(0, MAX_NEWS_SYMBOLS_PER_CYCLE).forEach(s => merged.add(s.symbol));
        } catch (_) {}

        if (merged.size === 0) return;

        // Cap total watchlist
        const capped = Array.from(merged).slice(0, MAX_NEWS_SYMBOLS_PER_CYCLE);
        const added   = capped.filter(s => !watchedSymbols.has(s)).length;
        watchedSymbols = new Set(capped);

        if (added > 0) {
            console.log(`[News Monitor] Watchlist refreshed from universe: ${watchedSymbols.size} symbols (${added} new)`);
        }
    } catch (err) {
        console.warn('[News Monitor] refreshWatchlistFromUniverse failed, keeping current watchlist:', err.message);
    }
}

const WATCHLIST_REFRESH_INTERVAL = 30 * 60 * 1000; // 30 minutes
let watchlistRefreshTimer = null;

/**
 * Start news monitoring
 */
function startNewsMonitoring(symbols) {
    if (monitoringInterval) {
        console.log('[News Monitor] Already running');
        return;
    }

    watchedSymbols = new Set((symbols || []).map(s => s.toUpperCase()));
    console.log(`[News Monitor] Starting monitoring for ${watchedSymbols.size} seed symbols`);

    // Immediately refresh from HERMES + holdings so we don't wait 30 min
    refreshWatchlistFromUniverse(symbols).then(() => {
        monitorNews(Array.from(watchedSymbols));
    }).catch(() => {
        monitorNews(Array.from(watchedSymbols));
    });

    // Regular news checks
    monitoringInterval = setInterval(() => {
        monitorNews(Array.from(watchedSymbols));
    }, CHECK_INTERVAL);

    // Periodic watchlist refresh (every 30 min) — picks up new HERMES picks
    watchlistRefreshTimer = setInterval(() => {
        refreshWatchlistFromUniverse(symbols).catch(() => {});
    }, WATCHLIST_REFRESH_INTERVAL);
}

/**
 * Stop news monitoring
 */
function stopNewsMonitoring() {
    if (monitoringInterval) {
        clearInterval(monitoringInterval);
        monitoringInterval = null;
    }
    if (watchlistRefreshTimer) {
        clearInterval(watchlistRefreshTimer);
        watchlistRefreshTimer = null;
    }
    console.log('[News Monitor] Stopped');
}

/**
 * Add symbols to watch
 */
function addSymbolsToWatch(symbols) {
    symbols.forEach(s => watchedSymbols.add(s));
    console.log(`[News Monitor] Now watching ${watchedSymbols.size} symbols`);
}

/**
 * Remove symbols from watch
 */
function removeSymbolsFromWatch(symbols) {
    symbols.forEach(s => watchedSymbols.delete(s));
    console.log(`[News Monitor] Now watching ${watchedSymbols.size} symbols`);
}

/**
 * One-time cleanup: mark all synthetic test alerts as read so they stop appearing.
 * Runs at startup; safe to call multiple times (UPDATE affects 0 rows after first run).
 */
async function cleanupTestAlerts() {
    try {
        await ensureNewsAlertsSchema();
        const result = await query(`
            UPDATE news_alerts
            SET viewed = true
            WHERE title = 'Apple Announces Major Product Launch'
              AND COALESCE(viewed, false) = false
        `);
        if (result.rowCount > 0) {
            console.log(`[News Monitor] Cleaned up ${result.rowCount} stale test alert(s)`);
        }
    } catch (err) {
        console.warn('[News Monitor] cleanupTestAlerts skipped:', err.message);
    }
}

// Run cleanup immediately on module load
cleanupTestAlerts();

module.exports = {
    monitorNews,
    getNewsAlerts,
    getMonitoringStatus,
    markAlertRead,
    startNewsMonitoring,
    stopNewsMonitoring,
    addSymbolsToWatch,
    removeSymbolsFromWatch,
    cleanupTestAlerts
};
