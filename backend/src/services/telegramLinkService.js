/**
 * Telegram Account Linking
 *
 * Lets a user connect their own Telegram chat to their KiranRock account via a
 * one-time deep link (t.me/<bot>?start=<code>), so per-user trade alerts reach
 * that user's own chat instead of nobody's (most non-admin users currently have
 * no telegram_chat_id at all, so telegramAlertService's per-user sends silently
 * no-op for them).
 *
 * Uses long-polling on its own bot instance. Telegram only allows a single
 * getUpdates() session per bot token, so startTelegramLinkListener() must only
 * ever run in ONE process — called from worker.js after leadership election,
 * never from app.js (which only ever sends messages, it never polls).
 */

const crypto = require('crypto');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_USERNAME       = process.env.TELEGRAM_BOT_USERNAME || 'KiranTradePro_bot';
const LINK_CODE_TTL_MS   = 15 * 60 * 1000; // 15 minutes

let _bot = null;
let _healthCheckTimer = null;
let _consecutiveErrors = 0;
let _lastSeenUpdateAt = 0;

const POLL_INTERVAL_BASE_MS = 300;   // library default
const POLL_INTERVAL_MAX_MS  = 30000; // cap during a sustained outage
const BACKOFF_AFTER_ERRORS  = 5;     // don't slow down on a single blip

/**
 * Generates a one-time linking code for this user and returns the deep link.
 * Overwrites any previous unused code for this user.
 */
async function generateLinkCode(userId) {
    const code      = crypto.randomBytes(4).toString('hex'); // 8 hex chars — deep-link payloads only allow [A-Za-z0-9_-]
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MS);

    await query(
        'UPDATE users SET telegram_link_code = $1, telegram_link_expires_at = $2 WHERE id = $3',
        [code, expiresAt, userId]
    );

    return {
        code,
        deepLink:  `https://t.me/${BOT_USERNAME}?start=${code}`,
        expiresAt
    };
}

/**
 * Atomically matches and consumes a link code, binding the chat to that user.
 * The expiry check in the WHERE clause and clearing the code in the same
 * UPDATE make this safe against a code being used twice or after expiry.
 */
async function consumeLinkCode(code, chatId) {
    const result = await query(
        `UPDATE users
         SET telegram_chat_id = $1, telegram_link_code = NULL, telegram_link_expires_at = NULL
         WHERE telegram_link_code = $2 AND telegram_link_expires_at > NOW()
         RETURNING username`,
        [String(chatId), code]
    );
    return result.rows[0]?.username || null;
}

function startTelegramLinkListener() {
    if (_bot) return; // already started
    if (!TELEGRAM_BOT_TOKEN) {
        logger.warn('[TelegramLink] TELEGRAM_BOT_TOKEN not set — linking listener disabled');
        return;
    }

    const TelegramBot = require('node-telegram-bot-api');
    _bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

    _bot.onText(/\/start(?:\s+(\S+))?/, async (msg, match) => {
        const chatId = msg.chat.id;
        const code   = match && match[1];

        if (!code) {
            await _bot.sendMessage(chatId,
                'Hi! To connect your KiranRock account, use the "Connect Telegram" button on your Profile page — ' +
                'it gives you a link that opens this bot with a one-time code.'
            ).catch(() => {});
            return;
        }

        try {
            const username = await consumeLinkCode(code, chatId);
            if (username) {
                await _bot.sendMessage(chatId,
                    `✅ Connected! This chat is now linked to KiranRock account "${username}".\n\n` +
                    `You'll get your own trade alerts here from now on.`
                ).catch(() => {});
                logger.info('[TelegramLink] Account linked', { username, chatId });
            } else {
                await _bot.sendMessage(chatId,
                    '⚠️ That link has expired or was already used. Go back to your Profile page and generate a new one.'
                ).catch(() => {});
            }
        } catch (err) {
            logger.error('[TelegramLink] Failed to consume link code', { err: err.message });
            await _bot.sendMessage(chatId, '⚠️ Something went wrong linking your account — please try again.').catch(() => {});
        }
    });

    // The library retries getUpdates() every 300ms with no backoff, so a real
    // outage (DNS down, 401, etc.) hammers the network and the log at 3+/sec
    // instead of a handful of times total. Slow the retry cadence the longer
    // the outage runs, and collapse the log spam to occasional lines — same
    // self-healing behavior, just quieter and gentler on a sustained failure.
    _bot.on('polling_error', (err) => {
        _consecutiveErrors++;
        if (_consecutiveErrors === 1 || _consecutiveErrors % 20 === 0) {
            logger.warn('[TelegramLink] Polling error', { err: err.message, consecutiveErrors: _consecutiveErrors });
        }
        if (_consecutiveErrors >= BACKOFF_AFTER_ERRORS && _bot && _bot._polling) {
            const backoffSteps = Math.min(_consecutiveErrors - BACKOFF_AFTER_ERRORS, 6);
            _bot._polling.options.interval = Math.min(
                POLL_INTERVAL_BASE_MS * (2 ** backoffSteps),
                POLL_INTERVAL_MAX_MS
            );
        }
    });

    _lastSeenUpdateAt = 0;
    _healthCheckTimer = setInterval(() => {
        if (!_bot || !_bot._polling) return;
        const lastUpdate = _bot._polling._lastUpdate || 0;
        if (lastUpdate > _lastSeenUpdateAt) {
            _lastSeenUpdateAt = lastUpdate;
            if (_consecutiveErrors > 0) {
                logger.info('[TelegramLink] Polling recovered', { afterConsecutiveErrors: _consecutiveErrors });
                _consecutiveErrors = 0;
                _bot._polling.options.interval = POLL_INTERVAL_BASE_MS;
            }
        }
    }, 10000);

    logger.info('[TelegramLink] Listening for /start <code> messages');
}

function stopTelegramLinkListener() {
    if (_healthCheckTimer) {
        clearInterval(_healthCheckTimer);
        _healthCheckTimer = null;
    }
    if (_bot) {
        _bot.stopPolling().catch(() => {});
        _bot = null;
    }
    _consecutiveErrors = 0;
}

module.exports = { generateLinkCode, startTelegramLinkListener, stopTelegramLinkListener };
