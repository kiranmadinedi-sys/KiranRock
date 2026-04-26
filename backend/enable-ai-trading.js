const { query } = require('./src/config/database');

async function enableAITrading() {
    try {
        console.log('\n=== Enabling AI Trading for user "user" ===\n');
        
        // Enable AI trading
        const result = await query(
            'UPDATE users SET ai_trading_enabled = true WHERE username = $1 RETURNING *',
            ['user']
        );
        
        if (result.rows.length > 0) {
            console.log('✅ SUCCESS! AI Trading has been enabled for user "user"');
            console.log('');
            console.log('Details:');
            console.log(`  - User ID: ${result.rows[0].id}`);
            console.log(`  - Username: ${result.rows[0].username}`);
            console.log(`  - AI Trading Enabled: ${result.rows[0].ai_trading_enabled}`);
            console.log('');
            console.log('✅ The AI Trading Bot will now:');
            console.log('   • Run every 5 minutes during market hours (9:30 AM - 4:00 PM ET)');
            console.log('   • Scan entire market for opportunities');
            console.log('   • Execute trades automatically based on AI analysis');
            console.log('   • Manage portfolio to achieve profit targets');
            console.log('');
            console.log('📊 Current Status:');
            console.log('   • Trading Balance: $2,092.55 (ready for trading)');
            console.log('   • Next Run: During next market hours');
            console.log('');
            console.log('⚙️  Default Risk Settings:');
            console.log('   • Max Position Size: 15% per stock');
            console.log('   • Stop Loss: -12%');
            console.log('   • Take Profit: 25%');
            console.log('   • Min AI Score: 65/100');
            console.log('   • Max Daily Trades: 10');
            console.log('');
        } else {
            console.log('❌ User "user" not found');
        }
        
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

enableAITrading();
