const { query } = require('./src/config/database');

async function checkUser() {
    try {
        console.log('=== Checking User: bnageshw ===\n');

        const result = await query(
            'SELECT id, username, email, ai_trading_enabled, created_at FROM users WHERE username = $1',
            ['bnageshw']
        );

        if (result.rows.length === 0) {
            console.log('❌ User not found');
            process.exit(1);
        }

        const user = result.rows[0];
        console.log('✓ User Found:');
        console.log('   ID:', user.id);
        console.log('   Username:', user.username);
        console.log('   Email:', user.email);
        console.log('   AI Trading:', user.ai_trading_enabled ? 'ENABLED' : 'DISABLED');
        console.log('   Created:', user.created_at);

        console.log('\n📋 SOLUTION:');
        console.log('   The 401 error means the JWT token expired or is invalid.');
        console.log('   User "bnageshw" needs to:');
        console.log('   1. Logout completely (clear all cookies/localStorage)');
        console.log('   2. Login again with credentials');
        console.log('   3. Then try toggling AI Trading');
        console.log('\n   JWT tokens expire after 1 hour by default.');

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkUser();
