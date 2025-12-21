const TelegramBot = require('node-telegram-bot-api');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8520099950:AAFAAZrQCEK9B6wARjpoYDiqP3zNsaMz52Q';

// Only initialize bot if token is valid
let bot;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== '<YOUR_TELEGRAM_BOT_TOKEN>') {
    bot = new TelegramBot(TELEGRAM_BOT_TOKEN);
    console.log('✓ Telegram bot initialized (@KiranTradePro_bot)');
} else {
    console.warn('⚠️  Telegram bot token not configured. Set TELEGRAM_BOT_TOKEN environment variable.');
}

/**
 * Send a message to a user's phone number via Telegram
 * @param {string} phone - User's phone number
 * @param {string} message - Message to send
 * @param {object} options - Additional options (e.g., parse_mode: 'Markdown')
 */
async function sendTelegramMessage(phone, message, options = {}) {
    // Check if bot is initialized
    if (!bot) {
        throw new Error('Telegram bot not configured. Please set TELEGRAM_BOT_TOKEN environment variable.');
    }
    
    // You need to map phone numbers to Telegram user IDs (chat_id)
    // This is a placeholder for demo purposes
    // In production, you should have a mapping of phone -> chat_id
    const chatId = await getChatIdByPhone(phone);
    if (!chatId) throw new Error('No Telegram chat ID found for this phone number');
    return bot.sendMessage(chatId, message, options);
}

/**
 * Placeholder: Map phone number to Telegram chat ID
 * In production, implement a proper mapping (e.g., user registration with Telegram)
 */
async function getChatIdByPhone(phone) {
    // Map phone numbers to Telegram chat IDs
    // Supergroup chat_id: -1003406286106 (TradePro supergroup)
    const phoneToChat = {
        '6504830983': '-1003406286106',  // Your phone -> TradePro supergroup
    };
    return phoneToChat[phone] || '-1003406286106'; // Default to TradePro supergroup
}

module.exports = { sendTelegramMessage };
