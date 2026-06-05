const TelegramBot = require('node-telegram-bot-api');
const { query } = require('../config/database');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';

// Only initialize bot if token is valid
let bot;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== '<YOUR_TELEGRAM_BOT_TOKEN>') {
    // Configure bot with better timeout and connection options
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
        polling: false, // Disable polling to avoid connection issues
        request: {
            agentOptions: {
                keepAlive: true,
                keepAliveMsecs: 30000
            },
            timeout: 60000 // 60 second timeout for API requests
        }
    });
    console.log('✓ Telegram bot initialized (@KiranTradePro_bot)');
} else {
    console.warn('⚠️  Telegram bot token not configured. Set TELEGRAM_BOT_TOKEN environment variable.');
}

/**
 * Send a Telegram message to a chat ID, username, user ID, or phone number.
 * @param {string} target - Telegram chat ID or user identifier
 * @param {string} message - Message to send
 * @param {object} options - Additional options (e.g., parse_mode: 'Markdown')
 */
async function sendTelegramMessage(target, message, options = {}) {
    // Check if bot is initialized
    if (!bot) {
        throw new Error('Telegram bot not configured. Please set TELEGRAM_BOT_TOKEN environment variable.');
    }

    const chatId = await resolveTelegramChatId(target);
    if (!chatId) throw new Error('No Telegram chat ID found for this phone number');
    
    // Retry logic with exponential backoff
    const maxRetries = 3;
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await bot.sendMessage(chatId, message, {
                ...options,
                disable_web_page_preview: true // Prevent preview loading issues
            });
        } catch (error) {
            lastError = error;
            console.error(`[Telegram] Send attempt ${attempt}/${maxRetries} failed:`, error.message);
            
            // Don't retry on permanent errors
            if (error.response && error.response.statusCode === 403) {
                throw new Error('Bot blocked by user or chat not found');
            }
            
            // Exponential backoff before retry
            if (attempt < maxRetries) {
                const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
                console.log(`[Telegram] Retrying after ${backoffMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }
    
    throw lastError;
}

/**
 * Resolve a Telegram chat ID from explicit chat ID or user metadata in PostgreSQL.
 */
async function resolveTelegramChatId(target) {
    if (!target) {
        return process.env.TELEGRAM_CHAT_ID || null;
    }

    if (typeof target === 'string' && /^-?\d+$/.test(target.trim())) {
        return target.trim();
    }

    try {
        const result = await query(
            `SELECT telegram_chat_id
             FROM users
             WHERE id = $1 OR username = $1 OR phone = $1
             LIMIT 1`,
            [target]
        );

        return result.rows[0]?.telegram_chat_id || process.env.TELEGRAM_CHAT_ID || null;
    } catch (error) {
        console.error('[Telegram] Failed to resolve chat ID:', error.message);
        return process.env.TELEGRAM_CHAT_ID || null;
    }
}

async function getPrimaryTelegramRecipient(username = 'user') {
    try {
        const result = await query(
            `SELECT id, username, phone, telegram_chat_id
             FROM users
             WHERE username = $1
             LIMIT 1`,
            [username]
        );

        return result.rows[0] || null;
    } catch (error) {
        console.error('[Telegram] Failed to fetch primary recipient:', error.message);
        return null;
    }
}

async function getAllTelegramRecipients() {
    try {
        const result = await query(
            `SELECT id, username, phone, telegram_chat_id
             FROM users
             WHERE telegram_chat_id IS NOT NULL
               AND telegram_chat_id <> ''`
        );

        return result.rows;
    } catch (error) {
        console.error('[Telegram] Failed to fetch Telegram recipients:', error.message);
        return [];
    }
}

module.exports = {
    sendTelegramMessage,
    resolveTelegramChatId,
    getPrimaryTelegramRecipient,
    getAllTelegramRecipients
};
