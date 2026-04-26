const { query } = require('./src/config/database');

async function testToggleAI() {
    try {
        console.log('\n=== Testing AI Trading Toggle ===\n');
        
        // 1. Find the user
        console.log('1. Looking up user "user"...');
        const userResult = await query(
            'SELECT id, username, email, ai_trading_enabled FROM users WHERE username = $1',
            ['user']
        );
        
        if (userResult.rows.length === 0) {
            console.error('❌ User not found');
            process.exit(1);
        }
        
        const user = userResult.rows[0];
        console.log('✓ User found:');
        console.log(`   ID: ${user.id}`);
        console.log(`   Username: ${user.username}`);
        console.log(`   Current AI Trading: ${user.ai_trading_enabled}`);
        console.log('');
        
        // 2. Toggle AI trading to true
        console.log('2. Enabling AI Trading...');
        const updateResult = await query(
            'UPDATE users SET ai_trading_enabled = $1, updated_at = NOW() WHERE id = $2 RETURNING id, username, ai_trading_enabled, updated_at',
            [true, user.id]
        );
        
        if (updateResult.rows.length === 0) {
            console.error('❌ Update failed');
            process.exit(1);
        }
        
        const updated = updateResult.rows[0];
        console.log('✓ Update successful:');
        console.log(`   AI Trading: ${updated.ai_trading_enabled}`);
        console.log(`   Updated At: ${updated.updated_at}`);
        console.log('');
        
        // 3. Verify the change
        console.log('3. Verifying...');
        const verifyResult = await query(
            'SELECT id, username, ai_trading_enabled FROM users WHERE id = $1',
            [user.id]
        );
        
        const verified = verifyResult.rows[0];
        console.log('✓ Verified:');
        console.log(`   AI Trading: ${verified.ai_trading_enabled}`);
        console.log('');
        
        if (verified.ai_trading_enabled) {
            console.log('✅ SUCCESS! AI Trading is now enabled in the database.');
        } else {
            console.log('❌ FAILED! AI Trading is still disabled.');
        }
        
        console.log('');
        process.exit(0);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Full error:', error);
        process.exit(1);
    }
}

testToggleAI();
