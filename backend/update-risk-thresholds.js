require('dotenv').config({ path: '.env' });
const { query } = require('./src/config/database');

async function updateRiskConfigs() {
  // Update ALL users risk configs with improved thresholds
  const result = await query(
    'UPDATE risk_configs SET ' +
    '  min_buy_score = GREATEST(min_buy_score, 70), ' +
    '  stop_loss = GREATEST(stop_loss, -0.03), ' +
    '  trailing_stop_percent = LEAST(trailing_stop_percent, 0.03) ' +
    'WHERE min_buy_score < 70 OR stop_loss < -0.03 OR trailing_stop_percent > 0.03'
  );
  console.log('Updated rows:', result.rowCount);

  const rows = await query(
    'SELECT user_id, min_buy_score, stop_loss, trailing_stop_percent FROM risk_configs'
  );
  console.log('Current risk_configs:');
  rows.rows.forEach(r => console.log(JSON.stringify(r)));
  process.exit(0);
}

updateRiskConfigs().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
