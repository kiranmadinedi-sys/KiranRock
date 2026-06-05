const { query } = require('./src/config/database');

async function checkUser() {
    try {
        console.log('=== Checking User: "user" ===\n');

        const result = await query(
            'SELECT id, username, ai_trading_enabled, updated_at FROM users WHERE username = $1',
            ['user']
        );

        if (result.rows.length === 0) {
            console.log('❌ User not found');
            process.exit(1);
        }

        const user = result.rows[0];
        console.log('✓ User found:');
        console.log('   ID:', user.id);
        console.log('   Username:', user.username);
        console.log('   AI Trading Enabled:', user.ai_trading_enabled);
        console.log('   Last Updated:', user.updated_at);

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkUser();
