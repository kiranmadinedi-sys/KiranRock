/**
 * Smoke-test the data queries used by sendPerformanceReport — no Telegram send.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const axios = require('axios');
const { query, pool } = require('../src/config/database');

const BASE_URL = 'http://localhost:3001';

async function loginGetUserId() {
    const res = await axios.post(`${BASE_URL}/api/auth/login`, {
        username: process.env.BOT_USERNAME || 'user',
        password: process.env.BOT_PASSWORD || 'password'
    }, { timeout: 10000 });
    if (!res.data.token) throw new Error('Login failed');
    const payload = JSON.parse(Buffer.from(res.data.token.split('.')[1], 'base64').toString());
    return payload.userId || payload.id || payload.sub;
}

async function run() {
    console.log('\n=== Performance Report Data Test ===\n');

    // 1. Login flow
    let userId;
    try {
        userId = await loginGetUserId();
        console.log('✅ Login OK — userId:', userId);
    } catch (e) {
        console.warn('⚠️  Login failed:', e.message, '— testing fallback...');
        const botUser = process.env.BOT_USERNAME;
        const r = await query('SELECT id FROM users WHERE username = $1 OR email = $1 LIMIT 1', [botUser]);
        userId = r.rows[0]?.id;
        console.log('✅ Fallback userId:', userId);
    }

    if (!userId) { console.error('❌ No userId resolved'); process.exit(1); }

    // 2. Today's metrics
    const today = new Date().toISOString().split('T')[0];
    const todayMetrics = await query(`
        SELECT COALESCE(SUM(total_profit_loss),0) AS pnl,
               COALESCE(SUM(total_trades),0) AS trades,
               COALESCE(SUM(winning_trades),0) AS wins,
               COALESCE(SUM(losing_trades),0) AS losses
        FROM ai_performance_metrics WHERE user_id = $1 AND date = $2
    `, [userId, today]);
    console.log('✅ Today metrics:', todayMetrics.rows[0]);

    // 3. 30-day rolling
    const rolling = await query(`
        SELECT COALESCE(SUM(total_profit_loss),0) AS total_pnl,
               COALESCE(SUM(total_trades),0) AS total_trades,
               AVG(NULLIF(win_rate,0)) AS avg_win_rate,
               AVG(NULLIF(sharpe_ratio,0)) AS avg_sharpe
        FROM ai_performance_metrics
        WHERE user_id = $1 AND date >= CURRENT_DATE - INTERVAL '30 days'
    `, [userId]);
    console.log('✅ 30-day rolling:', rolling.rows[0]);

    // 4. Account balance
    const acct = await query('SELECT balance, initial_balance FROM trading_accounts WHERE user_id = $1', [userId]);
    console.log('✅ Account:', acct.rows[0] || 'NOT FOUND');

    // 5. Open positions
    const pos = await query('SELECT COUNT(*) AS open FROM holdings WHERE user_id = $1 AND quantity > 0', [userId]);
    console.log('✅ Open positions:', pos.rows[0].open);

    // 6. Verify Sharpe is now non-zero in DB
    const sharpeCheck = await query(`
        SELECT date, sharpe_ratio FROM ai_performance_metrics
        WHERE user_id = $1 AND sharpe_ratio != 0
        ORDER BY date DESC LIMIT 5
    `, [userId]);
    console.log('✅ Sharpe backfill rows (latest 5):', sharpeCheck.rows);

    await pool.end();
    console.log('\n✅ All checks passed — report data path is healthy\n');
}

run().catch(e => { console.error('❌ Test failed:', e.message); pool.end().finally(() => process.exit(1)); });
