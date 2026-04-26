const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'kiranrock_trading',
  password: 'admin',
  port: 5432
});

async function checkRiskConfig() {
  try {
    console.log('========================================');
    console.log('AI TRADING RISK CONFIGURATION');
    console.log('========================================\n');
    
    // Get user ID
    const userRes = await pool.query(
      "SELECT id FROM users WHERE username = 'user'"
    );
    
    if (userRes.rows.length === 0) {
      console.log('User not found!\n');
      return;
    }
    
    const userId = userRes.rows[0].id;
    
    // Check if custom risk config exists
    const configRes = await pool.query(
      'SELECT * FROM risk_configs WHERE user_id = $1',
      [userId]
    );
    
    if (configRes.rows.length > 0) {
      console.log('✓ Custom Risk Config Found:\n');
      const config = configRes.rows[0];
      console.log(`  Min Buy Score: ${config.min_buy_score}`);
      console.log(`  Max Position Size: ${config.max_position_size * 100}%`);
      console.log(`  Max Portfolio Risk: ${config.max_portfolio_risk * 100}%`);
      console.log(`  Stop Loss: ${config.stop_loss * 100}%`);
      console.log(`  Take Profit: ${config.take_profit_percent * 100}%`);
      console.log(`  Max Open Positions: ${config.max_open_positions}`);
      console.log(`  Min Market Cap: $${(config.min_market_cap / 1e9).toFixed(1)}B`);
      console.log(`  Max VIX: ${config.max_vix}`);
      console.log('');
    } else {
      console.log('⚠️  No Custom Config - Using Defaults:\n');
      console.log('  Min Buy Score: 65 ← HIGH (may be too restrictive)');
      console.log('  Max Position Size: 15%');
      console.log('  Max Portfolio Risk: 60%');
      console.log('  Stop Loss: -12%');
      console.log('  Take Profit: 25%');
      console.log('  Max Open Positions: 25');
      console.log('  Min Market Cap: $5.0B');
      console.log('  Max VIX: 30');
      console.log('');
    }
    
    console.log('========================================');
    console.log('ISSUE: Zero Opportunities Found');
    console.log('========================================\n');
    console.log('The AI bot has been finding 0 opportunities for hours.');
    console.log('This is likely because minBuyScore = 65 is TOO HIGH.\n');
    console.log('Most stocks score between 40-60. Only exceptional stocks');
    console.log('score 65+. The criteria is too strict for regular trading.\n');
    
    console.log('RECOMMENDED: Lower minBuyScore to 55 or 50\n');
    console.log('This will allow the bot to find 5-15 opportunities per cycle');
    console.log('instead of 0.\n');
    
    console.log('To create a custom risk config with lower threshold:');
    console.log('(This would need to be added via API or direct SQL)\n');
    
    console.log('Sample SQL to set minBuyScore to 55:');
    console.log(`INSERT INTO risk_configs (user_id, min_buy_score, max_position_size,`);
    console.log(`  max_portfolio_risk, stop_loss, trailing_stop_percent, take_profit_percent,`);
    console.log(`  partial_take_profit_percent, max_open_positions, min_market_cap,`);
    console.log(`  max_daily_trades, max_vix, reduce_positions_vix, max_sector_allocation)`);
    console.log(`VALUES ('${userId}', 55, 0.15, 0.60, -0.12, 0.08, 0.25, 0.15, 25,`);
    console.log(`  5000000000, 10, 30, 25, 0.35);`);
    
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    await pool.end();
  }
}

checkRiskConfig();
