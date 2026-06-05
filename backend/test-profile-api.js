const { query } = require('./src/config/database');

async function testProfileAPI() {
    try {
        console.log('=== Testing Profile API for user "user" ===\n');

        // Get user
        const userResult = await query(
            'SELECT id, username, email, full_name, phone, created_at, ai_trading_enabled FROM users WHERE username = $1',
            ['user']
        );

        if (userResult.rows.length === 0) {
            console.log('❌ User not found');
            process.exit(1);
        }

        const user = userResult.rows[0];
        console.log('1. Database Query Result:');
        console.log('   Raw ai_trading_enabled:', user.ai_trading_enabled);
        console.log('   Type:', typeof user.ai_trading_enabled);
        console.log('   Value:', user.ai_trading_enabled);

        // Get trading account
        const accountResult = await query(
            'SELECT balance FROM trading_accounts WHERE user_id = $1',
            [user.id]
        );

        const tradingAccount = accountResult.rows[0] || { balance: 100000 };

        // Split full_name into firstName and lastName
        const nameParts = (user.full_name || '').split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';

        // Simulate what the API returns
        const profile = {
            id: user.id,
            username: user.username,
            firstName: firstName,
            lastName: lastName,
            email: user.email || '',
            phone: user.phone || '',
            createdAt: user.created_at,
            aiTradingEnabled: user.ai_trading_enabled === true,
            tradingAccount: {
                balance: parseFloat(tradingAccount.balance)
            }
        };

        console.log('\n2. API Response Object:');
        console.log('   aiTradingEnabled:', profile.aiTradingEnabled);
        console.log('   Type:', typeof profile.aiTradingEnabled);

        console.log('\n3. JSON Stringified:');
        console.log(JSON.stringify(profile, null, 2));

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

testProfileAPI();
