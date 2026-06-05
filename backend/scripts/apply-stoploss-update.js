/**
 * One-shot: update existing risk_configs rows to tighter stop-loss values.
 * Run after restarting the platform.
 *
 * Usage: node backend/scripts/apply-stoploss-update.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { query, pool } = require('../src/config/database');

async function run() {
    const result = await query(`
        UPDATE risk_configs
        SET stop_loss           = -0.07,
            trailing_stop_percent = 0.05,
            updated_at          = NOW()
        WHERE stop_loss <= -0.12
           OR trailing_stop_percent >= 0.08
        RETURNING user_id, stop_loss, trailing_stop_percent
    `);
    if (result.rows.length === 0) {
        console.log('No rows needed updating (already at target values).');
    } else {
        console.log(`Updated ${result.rows.length} risk_config row(s):`);
        result.rows.forEach(r =>
            console.log(`  user=${r.user_id}  stop_loss=${r.stop_loss}  trailing=${r.trailing_stop_percent}`)
        );
    }
    await pool.end();
}

run().catch(e => { console.error('Failed:', e.message); pool.end().finally(() => process.exit(1)); });
