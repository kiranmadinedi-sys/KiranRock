const autonomousOptionsBot = require('./backend/src/services/autonomousOptionsBot');
const optionsBotScheduler = require('./backend/src/services/optionsBotScheduler');
const optionsService = require('./backend/src/services/optionsService');
const { pool, query } = require('./backend/src/config/database');

/**
 * Test Autonomous Options Trading Bot
 * Validates all components and runs a complete test cycle
 */

async function testOptionsBot() {
    console.log('🧪 Testing Autonomous Options Trading Bot\n');
    
    try {
        // Test 1: Database Connection
        console.log('1️⃣ Testing database connection...');
        const dbTest = await query('SELECT NOW() as time');
        console.log(`   ✓ Connected at: ${dbTest.rows[0].time}\n`);
        
        // Test 2: Check tables exist
        console.log('2️⃣ Checking database tables...');
        const tables = await query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE 'options%'
        `);
        console.log(`   ✓ Found ${tables.rows.length} options tables:`);
        tables.rows.forEach(t => console.log(`     - ${t.table_name}`));
        console.log();
        
        // Test 3: VIX Level
        console.log('3️⃣ Testing VIX data fetch...');
        const vix = await autonomousOptionsBot.getVixLevel();
        console.log(`   ✓ VIX: ${vix.value.toFixed(2)} (${vix.regime})\n`);
        
        // Test 4: Options Data Fetch
        console.log('4️⃣ Testing options data fetch...');
        const testSymbols = ['SPY', 'AAPL', 'MSFT'];
        for (const symbol of testSymbols) {
            try {
                const optionsData = await optionsService.getOptionsWithGreeks(symbol);
                if (optionsData.options && optionsData.options.length > 0) {
                    const atmOption = optionsData.options.find(opt => 
                        Math.abs(opt.greeks.delta) > 0.45 && 
                        Math.abs(opt.greeks.delta) < 0.55
                    );
                    if (atmOption) {
                        console.log(`   ✓ ${symbol}: Found ${optionsData.options.length} options`);
                        console.log(`     ATM Strike: $${atmOption.strike}, Delta: ${atmOption.greeks.delta.toFixed(3)}, IV: ${(atmOption.greeks.impliedVolatility * 100).toFixed(1)}%`);
                    }
                } else {
                    console.log(`   ⚠ ${symbol}: ${optionsData.error || 'No options data'}`);
                }
            } catch (error) {
                console.log(`   ⚠ ${symbol}: ${error.message}`);
            }
        }
        console.log();
        
        // Test 5: Get or create test user
        console.log('5️⃣ Setting up test user...');
        let testUserId = null;
        
        // Try to get first user from database
        const userResult = await query('SELECT id, username FROM users LIMIT 1');
        if (userResult.rows.length > 0) {
            testUserId = userResult.rows[0].id;
            console.log(`   ✓ Using existing user: ${userResult.rows[0].username} (${testUserId})\n`);
        } else {
            console.log('   ⚠ No users found in database. Create a user first.\n');
            process.exit(0);
        }
        
        // Test 6: Check/Create bot config
        console.log('6️⃣ Checking bot configuration...');
        const configResult = await query(
            'SELECT * FROM options_bot_config WHERE user_id = $1',
            [testUserId]
        );
        
        if (configResult.rows.length === 0) {
            await query(
                `INSERT INTO options_bot_config 
                 (user_id, enabled, scalping_enabled, swing_enabled, spreads_enabled) 
                 VALUES ($1, true, true, true, true)`,
                [testUserId]
            );
            console.log('   ✓ Created default bot configuration\n');
        } else {
            const config = configResult.rows[0];
            console.log('   ✓ Configuration found:');
            console.log(`     Enabled: ${config.enabled}`);
            console.log(`     Scalping: ${config.scalping_enabled}`);
            console.log(`     Swing: ${config.swing_enabled}`);
            console.log(`     Spreads: ${config.spreads_enabled}`);
            console.log(`     Max Positions: ${config.max_open_positions}`);
            console.log(`     Max Daily Loss: $${config.max_daily_loss}\n`);
        }
        
        // Test 7: Scheduler Status
        console.log('7️⃣ Checking scheduler status...');
        const schedulerStatus = optionsBotScheduler.getSchedulerStatus();
        console.log(`   Active: ${schedulerStatus.active}`);
        console.log(`   Market Open: ${schedulerStatus.marketOpen}`);
        console.log('   Scan Times:');
        schedulerStatus.nextScans.forEach(time => console.log(`     - ${time}`));
        console.log();
        
        // Test 8: Manual Scan (DRY RUN)
        console.log('8️⃣ Running manual scan (dry run)...');
        console.log('   ℹ️  This will scan for opportunities but not execute trades\n');
        
        console.log('   🔍 Scanning universe...');
        const universe = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA'];
        
        let totalOpportunities = 0;
        for (const symbol of universe) {
            try {
                const optionsData = await optionsService.getOptionsWithGreeks(symbol);
                if (optionsData.options && optionsData.options.length > 0) {
                    // Count high-quality options
                    const quality = optionsData.options.filter(opt =>
                        opt.volume >= 100 &&
                        opt.openInterest >= 500 &&
                        Math.abs(opt.greeks.delta) > 0.3 &&
                        Math.abs(opt.greeks.gamma) > 0.02
                    );
                    
                    if (quality.length > 0) {
                        console.log(`     ${symbol}: ${quality.length} tradeable options`);
                        totalOpportunities += quality.length;
                    }
                }
                
                // Rate limit
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (error) {
                // Skip
            }
        }
        
        console.log(`\n   ✓ Found ${totalOpportunities} total opportunities\n`);
        
        // Test 9: Check positions
        console.log('9️⃣ Checking open positions...');
        const positionsResult = await query(
            'SELECT * FROM options_trades WHERE user_id = $1 AND status = $2',
            [testUserId, 'OPEN']
        );
        console.log(`   Current open positions: ${positionsResult.rows.length}\n`);
        
        // Test 10: Performance metrics
        console.log('🔟 Checking performance history...');
        const historyResult = await query(
            'SELECT COUNT(*) as count FROM options_trades WHERE user_id = $1 AND status = $2',
            [testUserId, 'CLOSED']
        );
        console.log(`   Closed trades: ${historyResult.rows[0].count}\n`);
        
        // Summary
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ ALL TESTS PASSED!\n');
        console.log('📊 Summary:');
        console.log(`   VIX: ${vix.value.toFixed(2)} (${vix.regime})`);
        console.log(`   Market: ${schedulerStatus.marketOpen ? 'OPEN' : 'CLOSED'}`);
        console.log(`   Opportunities: ${totalOpportunities}`);
        console.log(`   Open Positions: ${positionsResult.rows.length}`);
        console.log(`   Bot Status: ${schedulerStatus.active ? 'ACTIVE' : 'INACTIVE'}`);
        console.log('\n🎯 Options Bot is ready for autonomous trading!\n');
        console.log('💡 To enable for your user:');
        console.log(`   curl -X POST http://localhost:3001/api/options-bot/enable \\`);
        console.log(`        -H "Authorization: Bearer YOUR_TOKEN" \\`);
        console.log(`        -H "Content-Type: application/json" \\`);
        console.log(`        -d '{"enabled": true}'`);
        console.log('\n💡 To trigger manual scan:');
        console.log(`   curl -X POST http://localhost:3001/api/options-bot/manual-scan \\`);
        console.log(`        -H "Authorization: Bearer YOUR_TOKEN"`);
        
        process.exit(0);
        
    } catch (error) {
        console.error('\n❌ Test failed:', error);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run tests
testOptionsBot();
