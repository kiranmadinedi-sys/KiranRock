const TelegramBot = require('node-telegram-bot-api');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8520099950:AAFAAZrQCEK9B6wARjpoYDiqP3zNsaMz52Q';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

console.log('✓ Telegram bot listening for messages...');
console.log('📝 Send a message to @KiranTradePro_bot from your group to get the chat ID');
console.log('⌨️  Type anything in the Telegram group and the chat ID will appear here');
console.log('⏹️  Press Ctrl+C to stop\n');

// Listen for any message
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const chatType = msg.chat.type;
    const chatTitle = msg.chat.title || msg.chat.first_name;
    const text = msg.text || '[non-text message]';
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📨 New message received!');
    console.log('🆔 Chat ID:', chatId);
    console.log('📝 Chat Type:', chatType);
    console.log('👥 Chat Title/Name:', chatTitle);
    console.log('💬 Message:', text);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    if (chatType === 'group' || chatType === 'supergroup') {
        console.log(`✅ Use this chat ID in telegramService.js: '${chatId}'\n`);
    }
});

// Handle errors
bot.on('polling_error', (error) => {
    console.log('❌ Polling error:', error.message);
});
