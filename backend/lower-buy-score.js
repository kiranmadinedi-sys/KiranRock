const { Pool } = require('pg');

const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'kiranrock_trading',
  password: 'admin',
  port: 5432
});

async function lowerMinBuyScore() {
  try {
    console.log('========================================');
    console.log('LOWERING MIN BUY SCORE');
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
    console.log(`User ID: ${userId}\n`);
    
    // Insert custom risk config with minBuyScore = 55
    console.log('Creating custom risk config...');
    console.log('  Min Buy Score: 65 → 55 (more realistic)');
    console.log('  Keeping all other defaults same\n');
    
    await pool.query(`
      INSERT INTO risk_configs (
        user_id, min_buy_score, max_position_size,
        max_portfolio_risk, stop_loss, trailing_stop_percent, 
        take_profit_percent, partial_take_profit_percent, 
        max_open_positions, min_market_cap,
        max_daily_trades, max_vix, reduce_positions_vix, 
        max_sector_allocation
      ) VALUES (
        $1, 55, 0.15, 0.60, -0.12, 0.08, 0.25, 0.15, 25,
        5000000000, 10, 30, 25, 0.35
      )
      ON CONFLICT (user_id) DO UPDATE SET
        min_buy_score = 55
    `, [userId]);
    
    console.log('✓ Risk config updated successfully!\n');
    
    console.log('========================================');
    console.log('NEW CONFIGURATION');
    console.log('========================================\n');
    console.log('  Min Buy Score: 55 (was 65)');
    console.log('  Effect: Will accept stocks with AI score ≥55');
    console.log('  Expected: 5-15 opportunities per trading cycle');
    console.log('  Next cycle: Within 5 minutes\n');
    
    console.log('The Enhanced AI Scheduler will use this new threshold');
    console.log('on the next cycle. No restart needed!\n');
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error(error);
  } finally {
    await pool.end();
  }
}

lowerMinBuyScore();
