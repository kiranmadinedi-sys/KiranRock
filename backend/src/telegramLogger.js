const TelegramBot = require('node-telegram-bot-api');

// Simple Telegram logger to capture incoming messages and chat IDs.
// Usage (PowerShell):
//   $env:TELEGRAM_BOT_TOKEN = "<your-bot-token>"; node backend/src/telegramLogger.js

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set.');
  console.error('Set it in PowerShell like: $env:TELEGRAM_BOT_TOKEN = "<your-bot-token>"');
  console.error('Then run: node backend/src/telegramLogger.js');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

console.log('Telegram logger started (polling). Send a message to your bot now.');

bot.on('message', (msg) => {
  const payload = {
    receivedAt: new Date().toISOString(),
    chat: {
      id: msg.chat.id,
      type: msg.chat.type,
      title: msg.chat.title || null,
      username: msg.chat.username || null
    },
    from: {
      id: msg.from ? msg.from.id : null,
      username: msg.from ? msg.from.username : null,
      first_name: msg.from ? msg.from.first_name : null,
      last_name: msg.from ? msg.from.last_name : null
    },
    text: msg.text || null,
    raw: msg
  };

  console.log('Incoming Telegram message:');
  console.log(JSON.stringify(payload, null, 2));

  // Friendly note to user to confirm we've captured chat id
  try {
    bot.sendMessage(msg.chat.id, "Thanks — I logged your chat id. You can close this chat or continue messaging.");
  } catch (err) {
    // ignore send errors here
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err && err.message ? err.message : err);
});

process.on('SIGINT', () => {
  console.log('\nStopping Telegram logger...');
  bot.stopPolling();
  process.exit(0);
});

// Helper to send a message to a specific chat id
// Usage: sendTelegramMessage('your message', chatId)
// If chatId is not provided, use default from env
async function sendTelegramMessage(message, chatId = null) {
  const targetChatId = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!targetChatId) {
    console.error('TELEGRAM_CHAT_ID is not set. Cannot send message.');
    return;
  }
  try {
    await bot.sendMessage(targetChatId, message);
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
  }
}

module.exports = bot;
module.exports.sendTelegramMessage = sendTelegramMessage;
