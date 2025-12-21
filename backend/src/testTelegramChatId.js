/**
 * Test Telegram Message Sending
 * Try different chat ID formats to find the working one
 */

const TelegramBot = require('node-telegram-bot-api');
const token = '8520099950:AAFAAZrQCEK9B6wARjpoYDiqP3zNsaMz52Q';
const bot = new TelegramBot(token);

async function testChatIds() {
  const testMessage = '🧪 Test message from KiranRock Trading Platform';
  
  // Different chat ID formats to try
  const chatIdsToTry = [
    '-5063427459',           // Original
    -5063427459,             // Number format
    '-1005063427459',        // Supergroup format (add -100 prefix)
    -1005063427459,          // Supergroup number format
  ];

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
