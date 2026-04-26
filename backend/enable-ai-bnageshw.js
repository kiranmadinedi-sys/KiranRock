const { query } = require('./src/config/database');

async function enableAI() {
    try {
        console.log('=== Enabling AI Trading for bnageshw ===\n');

        // Look up user
        console.log('1. Looking up user "bnageshw"...');
        const userResult = await query(
            'SELECT id, username, ai_trading_enabled FROM users WHERE username = $1',
            ['bnageshw']
        );

        if (userResult.rows.length === 0) {
            console.log('❌ User not found');
            process.exit(1);
        }

        const user = userResult.rows[0];
        console.log('✓ User found:');
        console.log('   ID:', user.id);
        console.log('   Username:', user.username);
        console.log('   Current AI Trading:', user.ai_trading_enabled);

        // Enable AI Trading
        console.log('\n2. Enabling AI Trading...');
        const updateResult = await query(
            'UPDATE users SET ai_trading_enabled = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, ai_trading_enabled, updated_at',
            [true, user.id]
        );

        const updated = updateResult.rows[0];
        console.log('✓ Update successful:');
        console.log('   AI Trading:', updated.ai_trading_enabled);
        console.log('   Updated At:', updated.updated_at);

        // Verify
        console.log('\n3. Verifying...');
        const verifyResult = await query(
            'SELECT username, ai_trading_enabled FROM users WHERE id = $1',
            [user.id]
        );

        console.log('✓ Verified:');
        console.log('   Username:', verifyResult.rows[0].username);
        console.log('   AI Trading:', verifyResult.rows[0].ai_trading_enabled);

        console.log('\n✅ SUCCESS! AI Trading is now enabled for bnageshw.');
        console.log('\nNote: The AI Trading bot will:');
        console.log('- Monitor market every 5 minutes during trading hours (9:30 AM - 4:00 PM ET)');
        console.log('- Execute trades automatically based on AI predictions');
        console.log('- Apply stop-loss (-12%) and take-profit (+25%) rules');
        console.log('- Rebalance portfolio to maintain risk levels');

        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

enableAI();
