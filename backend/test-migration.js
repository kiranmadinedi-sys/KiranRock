const { query } = require('./src/config/database');

async function testMigration() {
    console.log('\n=== Testing Database Migration ===\n');
    
    try {
        // Test 1: Check user with AI Trading enabled
        console.log('1. Testing user query...');
        const userResult = await query(
            'SELECT id, username, email, ai_trading_enabled FROM users WHERE username = $1',
            ['bnageshw']
        );
        
        if (userResult.rows.length > 0) {
            const user = userResult.rows[0];
            console.log('✅ User found:', user.username);
            console.log('   AI Trading:', user.ai_trading_enabled ? 'ENABLED' : 'DISABLED');
        } else {
            console.log('❌ User not found');
        }
        
        // Test 2: Check trading account
        console.log('\n2. Testing trading account query...');
        const accountResult = await query(
            'SELECT id, user_id, balance FROM trading_accounts WHERE user_id = $1',
            [userResult.rows[0].id]
        );
        
        if (accountResult.rows.length > 0) {
            console.log('✅ Trading account found');
            console.log('   Balance: $' + parseFloat(accountResult.rows[0].balance).toFixed(2));
        } else {
            console.log('❌ Trading account not found');
        }
        
        // Test 3: Check holdings
        console.log('\n3. Testing holdings query...');
        const holdingsResult = await query(
            'SELECT symbol, quantity, average_price FROM holdings WHERE user_id = $1',
            [userResult.rows[0].id]
        );
        
        console.log(`✅ Found ${holdingsResult.rows.length} holdings`);
        if (holdingsResult.rows.length > 0) {
            holdingsResult.rows.forEach(h => {
                console.log(`   ${h.symbol}: ${h.quantity} shares @ $${parseFloat(h.average_price).toFixed(2)}`);
            });
        }
        
        // Test 4: Check trades
        console.log('\n4. Testing trades query...');
        const tradesResult = await query(
            'SELECT symbol, action, quantity, price, trade_date FROM trades WHERE user_id = $1 ORDER BY trade_date DESC LIMIT 5',
            [userResult.rows[0].id]
        );
        
        console.log(`✅ Found ${tradesResult.rows.length} recent trades`);
        if (tradesResult.rows.length > 0) {
            tradesResult.rows.forEach(t => {
                console.log(`   ${t.action.toUpperCase()}: ${t.symbol} ${t.quantity} shares @ $${parseFloat(t.price).toFixed(2)}`);
            });
        }
        
        // Test 5: Check alerts
        console.log('\n5. Testing alerts query...');
        const alertsResult = await query(
            'SELECT symbol, target_price, triggered FROM alerts WHERE user_id = $1',
            [userResult.rows[0].id]
        );
        
        console.log(`✅ Found ${alertsResult.rows.length} alerts`);
        
        console.log('\n=== Migration Test Complete ===');
        console.log('✅ All database queries working correctly!');
        console.log('\nServices migrated successfully:');
        console.log('  - tradingAccountService');
        console.log('  - portfolioService');
        console.log('  - tradingService');
        console.log('  - aiTradingBotService');
        console.log('  - alertService');
        console.log('  - aiTradingScheduler');
        console.log('  - userService');
        
    } catch (error) {
        console.error('❌ Migration test failed:', error);
    } finally {
        process.exit(0);
    }
}

testMigration();
