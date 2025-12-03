const { sendTelegramMessage } = require('./services/telegramService');
const users = require('../users.json');

async function testTelegramHello() {
  // Find main user with phone
  const user = users.find(u => u.username === 'user' && u.phone);
  if (!user) throw new Error('User with phone not found');
  try {
    const result = await sendTelegramMessage(user.phone, 'Hello');
    console.log('Telegram message sent:', result);
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
  }
}

// Run test
if (require.main === module) {
  testTelegramHello();
}
