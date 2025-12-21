/**
 * Get Telegram Chat ID Utility
 * This script helps you find the correct chat ID for your Telegram group/channel
 * 
 * Steps:
 * 1. Make sure your bot is added to the group
 * 2. Send a message in the group (mention the bot or just any message)
 * 3. Run this script
 * 4. It will show you the correct chat_id to use
 */

const TelegramBot = require('node-telegram-bot-api');
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8520099950:AAFAAZrQCEK9B6wARjpoYDiqP3zNsaMz52Q';

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

console.log('🔍 Fetching recent updates from Telegram...\n');

bot.getUpdates()
  .then(updates => {
    if (updates.length === 0) {
      console.log('❌ No updates found.');
      console.log('\n💡 To fix this:');
      console.log('   1. Make sure your bot (@KiranTradePro_bot) is added to your group');
      console.log('   2. Send a message in the group');
      console.log('   3. Run this script again\n');
      process.exit(0);
    }

    console.log(`✅ Found ${updates.length} update(s)\n`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    // Show all unique chats
    const chats = new Map();
    
    updates.forEach(update => {
      const chat = update.message?.chat || update.channel_post?.chat;
      if (chat) {
        if (!chats.has(chat.id)) {
          chats.set(chat.id, chat);
        }
      }
    });

    chats.forEach((chat, chatId) => {
      console.log('📱 Chat Found:');
      console.log(`   Type: ${chat.type}`);
      console.log(`   Title: ${chat.title || 'N/A'}`);
      console.log(`   Username: ${chat.username || 'N/A'}`);
      console.log(`   ✅ Chat ID: ${chatId}`);
      console.log('');
    });

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log('📋 Copy the Chat ID above and use it in your configuration\n');

    // Show the most recent group/supergroup
    const groupChats = Array.from(chats.values()).filter(c => 
      c.type === 'group' || c.type === 'supergroup'
    );

    if (groupChats.length > 0) {
      const targetChat = groupChats[0];
      console.log('💡 Suggested configuration for telegramService.js:\n');
      console.log('   async function getChatIdByPhone(phone) {');
      console.log(`       return ${targetChat.id}; // ${targetChat.title}`);
      console.log('   }\n');
    }

    process.exit(0);
  })
  .catch(err => {
    console.error('❌ Error:', err.message);
    console.log('\n💡 Make sure:');
    console.log('   1. Your bot token is correct');
    console.log('   2. Your bot has permissions to read messages');
    console.log('   3. You have sent at least one message after adding the bot\n');
    process.exit(1);
  });
