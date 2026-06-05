const crypto = require('crypto');
const { query } = require('../config/database');
const stockFeedService = require('./stockFeedService');
const stockSignalSnapshotService = require('./stockSignalSnapshotService');
const { sendTelegramMessage } = require('./telegramService');

const MARKET_INTERVAL_MS = Math.max(60 * 1000, Number.parseInt(process.env.STOCK_SIGNAL_MARKET_INTERVAL_MS || `${5 * 60 * 1000}`, 10) || (5 * 60 * 1000));
const OFF_HOURS_INTERVAL_MS = Math.max(5 * 60 * 1000, Number.parseInt(process.env.STOCK_SIGNAL_OFF_HOURS_INTERVAL_MS || `${30 * 60 * 1000}`, 10) || (30 * 60 * 1000));
const MAX_SIGNALS_PER_USER_PER_CYCLE = Math.max(1, Number.parseInt(process.env.STOCK_SIGNAL_MAX_PER_USER || '3', 10) || 3);

let schedulerTimer = null;
let schedulerActive = false;
let runInProgress = false;
let lastRunStartedAt = null;
let lastRunFinishedAt = null;
let lastRunSummary = null;

function getFrontendBaseUrl() {
    const explicit = process.env.FRONTEND_BASE_URL || process.env.PUBLIC_APP_URL;
    if (explicit) {
        return explicit.replace(/\/$/, '');
    }

    const origins = String(process.env.CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (origins.length > 0) {
        return origins[0].replace(/\/$/, '');
    }

    return 'http://localhost:3000';
}

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

function getNextIntervalMs() {
    return isMarketHours() ? MARKET_INTERVAL_MS : OFF_HOURS_INTERVAL_MS;
}

function formatTimestampForTelegram(timestamp) {
    const date = new Date(timestamp || Date.now());
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: false
    }).format(date) + ' ET';
}

/**
 * Stable content fingerprint for a news/signal item.
 * Uses symbol + normalized title so the same story with different DB IDs
 * is still recognised as a duplicate.
 */
function contentFingerprint(item) {
    const normalized = `${(item.symbol || '').toUpperCase()}:${String(item.title || '').toLowerCase().replace(/\s+/g, ' ').trim()}`;
    return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 20);
}

function trimText(value, maxLength = 220) {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 1)}…`;
}

function getDeliveryExpiry(item) {
    if (item.type === 'news') {
        return "CURRENT_TIMESTAMP + INTERVAL '7 days'";
    }

    return "CURRENT_TIMESTAMP + INTERVAL '24 hours'";
}

async function ensureSignalSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS stock_signal_telegram_events (
            id SERIAL PRIMARY KEY,
            user_id VARCHAR(50) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            channel VARCHAR(30) NOT NULL DEFAULT 'telegram',
            item_type VARCHAR(20) NOT NULL,
            item_key VARCHAR(200) NOT NULL,
            symbol VARCHAR(10),
            title TEXT,
            priority_score INTEGER,
            delivered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP,
            payload JSONB DEFAULT '{}'::jsonb,
            UNIQUE(user_id, channel, item_type, item_key)
        )
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_stock_signal_telegram_events_active
        ON stock_signal_telegram_events(user_id, channel, expires_at DESC)
    `);
}

async function cleanupExpiredDeliveries() {
    await query(`
        DELETE FROM stock_signal_telegram_events
        WHERE expires_at IS NOT NULL
          AND expires_at <= CURRENT_TIMESTAMP
    `);
}

async function getTelegramUsers(options = {}) {
    const conditions = [
        'is_active = true',
        'telegram_chat_id IS NOT NULL',
        "telegram_chat_id <> ''"
    ];
    const params = [];

    if (options.username) {
        params.push(String(options.username));
        conditions.push(`username = $${params.length}`);
    }

    // DISTINCT ON telegram_chat_id — if multiple user accounts share the same
    // chat (e.g. test accounts, duplicate registrations), send only once.
    // Oldest account (MIN id) is used as the canonical representative.
    const result = await query(`
        SELECT DISTINCT ON (telegram_chat_id)
               id, username, telegram_chat_id
        FROM users
        WHERE ${conditions.join(' AND ')}
        ORDER BY telegram_chat_id, id ASC
    `, params);

    return result.rows;
}

async function wasDelivered(userId, item) {
    const itemKey     = String(item.id).replace(/^(news|swing):/, '');
    const fingerprint = contentFingerprint(item);
    // Three dedup vectors:
    //  1. Exact item_key match (same DB row)
    //  2. Content fingerprint match — catches same story with different IDs
    //  3. Normalised title match (case-insensitive, whitespace-collapsed)
    const result = await query(`
        SELECT 1
        FROM stock_signal_telegram_events
        WHERE user_id = $1
          AND channel  = 'telegram'
          AND item_type = $2
          AND delivered_at > NOW() - INTERVAL '7 days'
          AND (
              item_key = $3
              OR payload->>'contentFingerprint' = $4
              OR (
                  item_type = 'news'
                  AND LOWER(REGEXP_REPLACE(COALESCE(title,''), '\\s+', ' ', 'g'))
                    = LOWER(REGEXP_REPLACE(COALESCE($5,''), '\\s+', ' ', 'g'))
              )
          )
        LIMIT 1
    `, [userId, item.type, itemKey, fingerprint, item.title || '']);

    return result.rowCount > 0;
}

async function recordDelivered(userId, item) {
    const itemKey = String(item.id).replace(/^(news|swing):/, '');
    await query(`
        INSERT INTO stock_signal_telegram_events (
            user_id,
            channel,
            item_type,
            item_key,
            symbol,
            title,
            priority_score,
            expires_at,
            payload
        ) VALUES (
            $1,
            'telegram',
            $2,
            $3,
            $4,
            $5,
            $6,
            ${getDeliveryExpiry(item)},
            $7::jsonb
        )
        ON CONFLICT (user_id, channel, item_type, item_key) DO UPDATE
        SET symbol = EXCLUDED.symbol,
            title = EXCLUDED.title,
            priority_score = EXCLUDED.priority_score,
            delivered_at = CURRENT_TIMESTAMP,
            expires_at = EXCLUDED.expires_at,
            payload = EXCLUDED.payload
    `, [
        userId,
        item.type,
        itemKey,
        item.symbol || null,
        item.title || null,
        Number.isFinite(item.priorityScore) ? Math.round(item.priorityScore) : null,
        JSON.stringify({
            summary: item.summary || null,
            signal: item.signal || null,
            createdAt: item.createdAt || null,
            sourceLabel: item.sourceLabel || null,
            contentFingerprint: contentFingerprint(item)
        })
    ]);
}

function buildTelegramMessage(item) {
    if (item.type === 'news') {
        const headline = trimText(item.title, 120);
        const summaryText = item.summary && item.summary !== item.title
            ? trimText(item.summary, 240)
            : null;
        return [
            '📰 AI News Catalyst',
            `Symbol: ${item.symbol}`,
            `Impact: ${item.severity || 'News'} | Priority: ${Math.round(item.priorityScore || 0)}/100`,
            `Time: ${formatTimestampForTelegram(item.createdAt)}`,
            '',
            headline,
            summaryText,
            item.sentimentImpact ? `Sentiment: ${item.sentimentImpact}` : null,
            item.sourceLabel ? `Source: ${item.sourceLabel}` : null
        ].filter(Boolean).join('\n');
    }

    const currentPrice = item.meta?.currentPrice;
    const breakoutPrice = item.meta?.breakoutPrice;
    const distanceFromEma = item.meta?.distanceFromEma;

    return [
        '🚨 AI Swing Signal',
        `Symbol: ${item.symbol}`,
        `Signal: ${item.signal || 'WATCH'} | Action: ${item.recommendation || 'WATCH'} | Priority: ${Math.round(item.priorityScore || 0)}/100`,
        item.meta?.qualityTier ? `Quality: ${item.meta.qualityTier} (${Math.round(item.meta.qualityScore || 0)}/100)` : null,
        `Time: ${formatTimestampForTelegram(item.createdAt)}`,
        currentPrice ? `Current Price: $${Number(currentPrice).toFixed(2)}` : null,
        breakoutPrice ? `Breakout Level: $${Number(breakoutPrice).toFixed(2)}` : null,
        distanceFromEma ? `Distance vs EMA9: ${distanceFromEma}` : null,
        '',
        trimText(item.title, 120),
        trimText(item.summary, 240),
        item.meta?.holdingPeriod ? `Holding Window: ${item.meta.holdingPeriod}` : null,
        item.meta?.alignment ? `Alignment: ${item.meta.alignment}` : null
    ].filter(Boolean).join('\n');
}

function buildTelegramOptions(item) {
    const frontendBaseUrl = getFrontendBaseUrl();
    const buttons = [[{ text: 'Open Alerts', url: `${frontendBaseUrl}/alerts` }]];

    if (item.link) {
        buttons[0].push({ text: 'Open Source', url: item.link });
    }

    if (item.type === 'swing') {
        buttons.push([{ text: `View ${item.symbol}`, url: `${frontendBaseUrl}/swing-trading` }]);
    }

    return {
        reply_markup: {
            inline_keyboard: buttons
        }
    };
}

async function sendItemToTelegram(user, item) {
    const message = buildTelegramMessage(item);
    await sendTelegramMessage(user.telegram_chat_id, message, buildTelegramOptions(item));
    // Record after successful send — isolated so a DB error never causes a re-send
    try {
        await recordDelivered(user.id, item);
    } catch (dbErr) {
        console.error('[Stock Signal Scheduler] recordDelivered failed (message was already sent)', {
            userId: user.id,
            symbol: item.symbol,
            itemKey: String(item.id),
            error: dbErr.message
        });
    }
}

function buildPreviewItem(item) {
    return {
        id: item.id,
        type: item.type,
        symbol: item.symbol,
        title: item.title,
        priorityScore: Math.round(item.priorityScore || 0),
        recommendation: item.recommendation || null,
        qualityScore: Number(item.meta?.qualityScore || 0),
        freshnessState: item.meta?.freshnessState || null
    };
}

async function processUserSignals(userId, options = {}) {
    const result = await query(`
        SELECT id, username, telegram_chat_id
        FROM users
        WHERE id = $1
          AND is_active = true
          AND telegram_chat_id IS NOT NULL
          AND telegram_chat_id <> ''
        LIMIT 1
    `, [userId]);

    const user = result.rows[0];
    if (!user) {
        return { username: userId, delivered: 0, skipped: 0, reason: 'user-not-eligible' };
    }

    await stockSignalSnapshotService.refreshUserSwingSnapshots(user.id);
    const feed = await stockFeedService.getStockFeed({ userId: user.id, limit: 12, popupOnly: true, refreshSnapshots: false });
    let delivered = 0;
    let skipped = 0;
    const preview = [];
    // In-cycle dedup: catches identical items returned twice in the same feed
    // before wasDelivered() can see the DB row written by the first send.
    const sentThisCycle = new Set();

    for (const item of feed.items) {
        if (delivered >= MAX_SIGNALS_PER_USER_PER_CYCLE) {
            break;
        }

        if (item.type === 'swing' && (item.recommendation !== 'BUY' || Number(item.meta?.qualityScore || 0) < 75)) {
            skipped += 1;
            continue;
        }

        if (item.type === 'news' && (!item.meta?.fresh || Number(item.meta?.qualityScore || 0) < 68)) {
            skipped += 1;
            continue;
        }

        // In-cycle fingerprint check (fast, no DB round-trip)
        const fp = contentFingerprint(item);
        if (sentThisCycle.has(fp)) {
            skipped += 1;
            continue;
        }

        if (await wasDelivered(user.id, item)) {
            skipped += 1;
            continue;
        }

        // Claim the slot BEFORE attempting send so that:
        //   a) same-cycle duplicates are blocked even if sendItemToTelegram throws
        //   b) a Telegram API blip doesn't cause a second send of the same story
        sentThisCycle.add(fp);

        try {
            if (options.dryRun) {
                preview.push(buildPreviewItem(item));
            } else {
                await sendItemToTelegram(user, item);
            }
            delivered += 1;
        } catch (error) {
            console.error('[Stock Signal Scheduler] Failed to send Telegram signal', {
                userId: user.id,
                symbol: item.symbol,
                itemType: item.type,
                error: error.message
            });
        }
    }

    return {
        username: user.username,
        delivered,
        skipped,
        candidates: feed.items.length,
        dryRun: Boolean(options.dryRun),
        preview
    };
}

async function runSignalCycle(options = {}) {
    if (runInProgress) {
        return { skipped: true, reason: 'already-running' };
    }

    runInProgress = true;
    lastRunStartedAt = new Date().toISOString();

    try {
        await ensureSignalSchema();
        if (!options.dryRun) {
            await cleanupExpiredDeliveries();
        }

        const users = await getTelegramUsers(options);
        const results = [];
        let deliveredTotal = 0;

        for (const user of users) {
            const userResult = await processUserSignals(user.id, options);
            deliveredTotal += userResult.delivered || 0;
            results.push(userResult);
        }

        lastRunFinishedAt = new Date().toISOString();
        lastRunSummary = {
            deliveredTotal,
            usersProcessed: users.length,
            results,
            manual: Boolean(options.manual),
            dryRun: Boolean(options.dryRun),
            username: options.username || null
        };

        return {
            skipped: false,
            deliveredTotal,
            usersProcessed: users.length,
            results,
            dryRun: Boolean(options.dryRun),
            username: options.username || null
        };
    } catch (error) {
        lastRunFinishedAt = new Date().toISOString();
        lastRunSummary = {
            error: error.message,
            manual: Boolean(options.manual),
            dryRun: Boolean(options.dryRun),
            username: options.username || null
        };
        throw error;
    } finally {
        runInProgress = false;
    }
}

function scheduleNextRun() {
    if (!schedulerActive) {
        return;
    }

    const delay = getNextIntervalMs();
    schedulerTimer = setTimeout(async () => {
        try {
            await runSignalCycle();
        } catch (error) {
            console.error('[Stock Signal Scheduler] Scheduled cycle failed:', error.message);
        } finally {
            scheduleNextRun();
        }
    }, delay);

    if (typeof schedulerTimer.unref === 'function') {
        schedulerTimer.unref();
    }
}

function startStockSignalScheduler() {
    if (schedulerActive) {
        return;
    }

    schedulerActive = true;
    runSignalCycle().catch((error) => {
        console.error('[Stock Signal Scheduler] Initial cycle failed:', error.message);
    }).finally(() => {
        scheduleNextRun();
    });
}

function stopStockSignalScheduler() {
    schedulerActive = false;
    if (schedulerTimer) {
        clearTimeout(schedulerTimer);
        schedulerTimer = null;
    }
}

function getSchedulerStatus() {
    return {
        active: schedulerActive,
        inProgress: runInProgress,
        marketIntervalMs: MARKET_INTERVAL_MS,
        offHoursIntervalMs: OFF_HOURS_INTERVAL_MS,
        runningMode: isMarketHours() ? 'market-hours' : 'off-hours',
        lastRunStartedAt,
        lastRunFinishedAt,
        lastRunSummary
    };
}

module.exports = {
    getSchedulerStatus,
    processUserSignals,
    runSignalCycle,
    startStockSignalScheduler,
    stopStockSignalScheduler
};