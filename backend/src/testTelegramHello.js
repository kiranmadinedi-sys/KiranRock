const { sendTelegramMessage, getPrimaryTelegramRecipient } = require('./services/telegramService');

async function testTelegramHello() {
  const user = await getPrimaryTelegramRecipient('user');
  if (!user || (!user.telegram_chat_id && !user.phone)) {
    throw new Error('User with Telegram recipient details not found');
  }
  try {
    const result = await sendTelegramMessage(user.telegram_chat_id || user.phone, 'Hello');
    console.log('Telegram message sent:', result);
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
  }
}

// Run test
if (require.main === module) {
  testTelegramHello();
}
