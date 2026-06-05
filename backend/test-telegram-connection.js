const TelegramBot = require('node-telegram-bot-api');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEST_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN is not set. Export it before running this script.');
    process.exit(1);
}

async function testConnection() {
    console.log('🔍 Testing Telegram Bot Connection...\n');
    
    try {
        // Initialize bot with proper timeout settings
        const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, {
            polling: false,
            request: {
                agentOptions: {
                    keepAlive: true,
                    keepAliveMsecs: 30000
                },
                timeout: 60000
            }
        });
        
        console.log('✓ Bot initialized');
        
        // Test 1: Get bot info
        console.log('\n📊 Test 1: Getting bot info...');
        const me = await bot.getMe();
        console.log('✓ Bot info retrieved:');
        console.log(`   - Username: @${me.username}`);
        console.log(`   - Name: ${me.first_name}`);
        console.log(`   - ID: ${me.id}`);
        
        // Test 2: Test connection to Telegram API
        console.log('\n📡 Test 2: Testing API connection...');
        const updates = await bot.getUpdates({ limit: 1 });
        console.log('✓ API connection successful');
        console.log(`   - Recent updates: ${updates.length}`);
        
        // Test 3: Send test message
        console.log('\n📨 Test 3: Sending test message...');
        if (TEST_CHAT_ID) {
            const testMessage = '🧪 *Test Message*\n\nConnection test from KiranRock backend.\n\nTimestamp: ' + new Date().toISOString();

            try {
                await bot.sendMessage(TEST_CHAT_ID, testMessage, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                });
                console.log(`✓ Test message sent successfully to ${TEST_CHAT_ID}`);
            } catch (sendError) {
                console.error('✗ Failed to send message:', sendError.message);
                if (sendError.response) {
                    console.error('   Response:', sendError.response.body);
                }
            }
        } else {
            console.log('⚠️  TELEGRAM_CHAT_ID not set. Skipping send-message test.');
        }
        
        console.log('\n✅ All tests completed!');
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.response) {
            console.error('Response:', error.response.body);
        }
        process.exit(1);
    }
}

testConnection().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
