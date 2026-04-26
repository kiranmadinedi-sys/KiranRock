const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'kiranrock_trading',
  password: 'admin',
  port: 5432
});

async function checkUserLogs() {
  try {
    console.log('========================================');
    console.log('USER AI TRADING ACTIVITY');
    console.log('========================================\n');
    
    // Get user ID for 'user'
    const userQuery = await pool.query(`
      SELECT id, username, ai_trading_enabled 
      FROM users 
      WHERE username = 'user'
    `);
    
    if (userQuery.rows.length === 0) {
      console.log('❌ User "user" not found!\n');
      return;
    }
    
    const user = userQuery.rows[0];
    console.log(`User: ${user.username}`);
    console.log(`User ID: ${user.id}`);
    console.log(`AI Trading Enabled: ${user.ai_trading_enabled}\n`);
    
    if (!user.ai_trading_enabled) {
      console.log('❌ AI Trading is DISABLED!\n');
      console.log('Enable it in the UI to start trading.\n');
      return;
    }
    
    // Get logs for this user
    console.log('Recent AI Trading Logs for this user:\n');
    const logs = await pool.query(`
      SELECT id, timestamp, success, trades_executed, 
             capital_deployed, opportunities_found, message
      FROM ai_trading_logs 
      WHERE user_id = $1
      ORDER BY timestamp DESC 
      LIMIT 20
    `, [user.id]);
    
    if (logs.rows.length === 0) {
      console.log('❌ No logs found for this user!\n');
      console.log('The scheduler may not be processing your account.\n');
    } else {
      logs.rows.forEach((log, idx) => {
        console.log(`${idx + 1}. ${log.timestamp}`);
        console.log(`   Success: ${log.success}`);
        console.log(`   Message: ${log.message}`);
        console.log(`   Trades Executed: ${log.trades_executed}`);
        console.log(`   Capital Deployed: $${log.capital_deployed}`);
        console.log(`   Opportunities Found: ${log.opportunities_found}`);
        console.log('');
      });
      
      console.log('========================================');
      console.log('ANALYSIS');
      console.log('========================================\n');
      
      const allNoOpportunities = logs.rows.every(log => 
        log.message === 'No opportunities meet criteria'
      );
      
      if (allNoOpportunities) {
        console.log('❌ ISSUE FOUND: "No opportunities meet criteria"\n');
        console.log('This means the AI bot is running but finding NO stocks');
        console.log('that meet your buying criteria. Possible causes:\n');
        console.log('1. Buy score threshold too high (default: 65)');
        console.log('   - Most stocks may not meet the minimum AI score');
        console.log('   - Try lowering the threshold in risk config\n');
        console.log('2. Market conditions not favorable');
        console.log('   - VIX too high (max: 30)');
        console.log('   - Market volatility preventing buys\n');
        console.log('3. Yahoo Finance errors preventing stock analysis');
        console.log('   - Check backend console for rate limit (429) errors');
        console.log('   - Need to restart backend to apply fixes\n');
        console.log('RECOMMENDED ACTION:');
        console.log('1. Restart backend to apply Yahoo Finance fixes');
        console.log('2. Check console for stock analysis logs');
        console.log('3. Consider lowering minBuyScore in risk config');
      }
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkUserLogs();
