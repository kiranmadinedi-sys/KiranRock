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

    _bot.on('polling_error', (err) => {
        logger.warn('[TelegramLink] Polling error', { err: err.message });
    });

    logger.info('[TelegramLink] Listening for /start <code> messages');
}

function stopTelegramLinkListener() {
    if (_bot) {
        _bot.stopPolling().catch(() => {});
        _bot = null;
    }
}

module.exports = { generateLinkCode, startTelegramLinkListener, stopTelegramLinkListener };
