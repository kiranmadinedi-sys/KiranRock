const { query } = require('./src/config/database');

async function checkUser() {
    try {
        console.log('=== Checking User: bnageshw ===\n');

        // Look up user
        console.log('1. Looking up user "bnageshw"...');
        const userResult = await query(
            'SELECT id, username, email, ai_trading_enabled, created_at FROM users WHERE username = $1',
            ['bnageshw']
        );

        if (userResult.rows.length === 0) {
            console.log('❌ User "bnageshw" not found in database');
            process.exit(1);
        }

        const user = userResult.rows[0];
        console.log('✓ User found:');
        console.log('   ID:', user.id);
        console.log('   Username:', user.username);
        console.log('   Email:', user.email);
        console.log('   AI Trading Enabled:', user.ai_trading_enabled);
        console.log('   Created:', user.created_at);

        // Check trading account
        console.log('\n2. Checking trading account...');
        const accountResult = await query(
            'SELECT balance FROM trading_accounts WHERE user_id = $1',
            [user.id]
        );

        if (accountResult.rows.length > 0) {
            const account = accountResult.rows[0];
            console.log('✓ Trading Account:');
            console.log('   Balance: $' + parseFloat(account.balance).toFixed(2));
        } else {
            console.log('⚠️  No trading account found for this user');
        }

        // Check if user has any AI trading positions
        console.log('\n3. Checking AI trading positions...');
        const positionsResult = await query(
            'SELECT COUNT(*) as count FROM ai_trading_positions WHERE user_id = $1',
            [user.id]
        );
        console.log('   Active Positions:', positionsResult.rows[0].count);

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkUser();
