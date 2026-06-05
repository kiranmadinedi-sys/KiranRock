/**
 * Test Telegram Message Sending
 * Try different chat ID formats to find the working one
 */

const TelegramBot = require('node-telegram-bot-api');
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set. Export it before running this script.');
  process.exit(1);
}

const bot = new TelegramBot(token);

const baseChatId = process.argv[2] || process.env.TELEGRAM_CHAT_ID;

if (!baseChatId) {
  console.error('Provide a candidate chat ID via TELEGRAM_CHAT_ID or as the first CLI argument.');
  process.exit(1);
}

async function testChatIds() {
  const testMessage = '🧪 Test message from KiranRock Trading Platform';
  const normalizedChatId = String(baseChatId).trim();
  const unsignedChatId = normalizedChatId.replace(/^-100/, '').replace(/^-/, '');
  
  // Different chat ID formats to try
  const chatIdsToTry = [...new Set([
    normalizedChatId,
    Number(normalizedChatId),
    `-${unsignedChatId}`,
    Number(`-${unsignedChatId}`),
    `-100${unsignedChatId}`,
    Number(`-100${unsignedChatId}`)
  ].filter(chatId => String(chatId) !== 'NaN'))];

  console.log('🧪 Testing different chat ID formats...\n');

  for (const chatId of chatIdsToTry) {
    console.log(`Trying chat_id: ${chatId}`);
    try {
      await bot.sendMessage(chatId, testMessage);
      console.log(`✅ SUCCESS! Chat ID ${chatId} works!\n`);
      console.log(`Use this in your configuration:`);
      console.log(`   TELEGRAM_CHAT_ID="${chatId}"\n`);
      process.exit(0);
    } catch (err) {
      console.log(`❌ Failed: ${err.message}\n`);
    }
  }

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('\n⚠️  None of the chat IDs worked. Please:');
  console.log('   1. Make sure the bot is added to your group');
  console.log('   2. Send a message in the group');
  console.log('   3. Run: node src/getTelegramChatId.js');
  console.log('   4. Go to your TradePro group and send a message');
  console.log('   5. Run getTelegramChatId.js again to get the correct ID\n');
  
  process.exit(1);
}

testChatIds();
