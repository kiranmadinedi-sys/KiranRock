const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'kiranrock_trading',
  password: 'admin',
  port: 5432
});

async function checkSchedulerActivity() {
  try {
    console.log('========================================');
    console.log('AI TRADING SCHEDULER ACTIVITY CHECK');
    console.log('========================================\n');
    
    // Check ai_trading_logs table structure
    console.log('1. Checking ai_trading_logs table structure...');
    const columns = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'ai_trading_logs' 
      ORDER BY ordinal_position
    `);
    
    if (columns.rows.length === 0) {
      console.log('❌ ai_trading_logs table does not exist!\n');
      console.log('This means the Enhanced AI Scheduler has no place to log activity.');
      console.log('The scheduler may be running but not logging, or not running at all.\n');
    } else {
      console.log('✓ ai_trading_logs table exists with columns:');
      columns.rows.forEach(col => {
        console.log(`  - ${col.column_name} (${col.data_type})`);
      });
      console.log('');
      
      // Check for any logs
      console.log('2. Checking for AI trading activity logs...');
      const logs = await pool.query(`
        SELECT * FROM ai_trading_logs 
        ORDER BY id DESC 
        LIMIT 10
      `);
      
      if (logs.rows.length === 0) {
        console.log('❌ No AI trading logs found!\n');
        console.log('This indicates:');
        console.log('  - Enhanced AI Scheduler has NOT executed any trading cycles');
        console.log('  - The scheduler may not be starting properly');
        console.log('  - There may be errors preventing execution\n');
      } else {
        console.log(`✓ Found ${logs.rows.length} recent log entries:\n`);
        logs.rows.forEach((log, idx) => {
          console.log(`${idx + 1}. Log ID: ${log.id}`);
          console.log(`   User ID: ${log.user_id}`);
          console.log(`   Success: ${log.success}`);
          console.log(`   Message: ${log.message}`);
          console.log(`   Trades: ${log.trades_executed || 0}`);
          console.log('');
        });
      }
    }
    
    // Check trades table
    console.log('3. Checking trades table for AI_BOT trades...');
    const trades = await pool.query(`
      SELECT COUNT(*) as count,
             MIN(timestamp) as first_trade,
             MAX(timestamp) as last_trade
      FROM trades 
      WHERE executed_by = 'AI_BOT'
    `);
    
    const tradeCount = parseInt(trades.rows[0].count);
    if (tradeCount === 0) {
      console.log('❌ No AI_BOT trades found in trades table\n');
    } else {
      console.log(`✓ Found ${tradeCount} AI_BOT trades`);
      console.log(`  First trade: ${trades.rows[0].first_trade}`);
      console.log(`  Last trade: ${trades.rows[0].last_trade}\n`);
    }
    
    // Check user config
    console.log('4. Checking your AI trading configuration...');
    const userConfig = await pool.query(`
      SELECT id, username, ai_trading_enabled 
      FROM users 
      WHERE username = 'user'
    `);
    
    if (userConfig.rows.length > 0) {
      const user = userConfig.rows[0];
      console.log(`✓ User: ${user.username} (ID: ${user.id})`);
      console.log(`  AI Trading Enabled: ${user.ai_trading_enabled}\n`);
      
      if (!user.ai_trading_enabled) {
        console.log('❌ AI Trading is DISABLED for this user!\n');
      }
    } else {
      console.log('❌ User "user" not found!\n');
    }
    
    console.log('========================================');
    console.log('DIAGNOSIS');
    console.log('========================================');
    console.log('');
    console.log('Based on the analysis above:');
    console.log('');
    if (columns.rows.length === 0) {
      console.log('❌ CRITICAL: ai_trading_logs table missing');
      console.log('   Action: Create the table or check database schema');
    } else if (tradeCount === 0) {
      console.log('❌ Enhanced AI Scheduler has NOT executed any trades');
      console.log('   Possible causes:');
      console.log('   1. Scheduler not starting (check app.js line 157)');
      console.log('   2. Errors in enhancedAITradingBot.js preventing execution');
      console.log('   3. Yahoo Finance errors blocking stock analysis');
      console.log('   4. Backend needs restart to load fixes');
      console.log('');
      console.log('   RECOMMENDED ACTION:');
      console.log('   1. Stop backend: Get-Process node | Stop-Process -Force');
      console.log('   2. Restart backend: .\\start.ps1');
      console.log('   3. Watch for "[Enhanced AI Scheduler]" in console output');
      console.log('   4. Check for any error messages');
    } else {
      console.log('✓ Scheduler appears to be working');
      console.log('  Check console output for recent activity');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkSchedulerActivity();
