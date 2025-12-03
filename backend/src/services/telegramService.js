const TelegramBot = require('node-telegram-bot-api');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '<YOUR_TELEGRAM_BOT_TOKEN>';
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

/**
 * Send a message to a user's phone number via Telegram
 * @param {string} phone - User's phone number
 * @param {string} message - Message to send
 */
async function sendTelegramMessage(phone, message) {
    // You need to map phone numbers to Telegram user IDs (chat_id)
    // This is a placeholder for demo purposes
    // In production, you should have a mapping of phone -> chat_id
    const chatId = await getChatIdByPhone(phone);
    if (!chatId) throw new Error('No Telegram chat ID found for this phone number');
    return bot.sendMessage(chatId, message);
}

/**
 * Placeholder: Map phone number to Telegram chat ID
 * In production, implement a proper mapping (e.g., user registration with Telegram)
 */
async function getChatIdByPhone(phone) {
    // Use provided chat_id for your phone number
    const demoPhone = '6504830983';
    const supergroupChatId = '-1003406286106';
    if (phone === demoPhone) return supergroupChatId;
    return null;
}

module.exports = { sendTelegramMessage };
