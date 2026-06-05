require('dotenv').config();
const { query } = require('./src/config/database');

const userId = 'ca632c53-8798-46f4-be94-29be0fede7f2';

(async () => {
    // Check risk_configs for kmadined
    const rc = await query(
        'SELECT * FROM risk_configs WHERE user_id=$1',
        [userId]
    );
    console.log('\n=== RISK CONFIG ===');
    console.log(JSON.stringify(rc.rows, null, 2));

    // Check ai_trading_configs table if it exists
    try {
        const aitbl = await query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='ai_trading_configs' ORDER BY ordinal_position"
        );
        console.log('\nai_trading_configs columns:', aitbl.rows.map(r=>r.column_name));
        const aic = await query('SELECT * FROM ai_trading_configs WHERE user_id=$1', [userId]);
        console.log('ai_trading_configs row:', JSON.stringify(aic.rows, null, 2));
    } catch(e) { console.log('ai_trading_configs:', e.message); }

    // Check users table for ai_trading_enabled
    const u = await query(
        "SELECT id, username, ai_trading_enabled FROM users WHERE id=$1",
        [userId]
    );
    console.log('\n=== USER ROW ===');
    console.log(JSON.stringify(u.rows, null, 2));

    // Check daily_universe_analysis signals available
    const sig = await query(
        `SELECT COUNT(*) as total, 
                SUM(CASE WHEN passed_prescreen=true THEN 1 ELSE 0 END) as passed,
                MAX(analysis_date) as latest_date
         FROM daily_universe_analysis`
    );
    console.log('\n=== SIGNALS AVAILABLE ===');
    console.log(JSON.stringify(sig.rows, null, 2));

    // Top signals for today
    const topSig = await query(
        `SELECT symbol, ai_score, recommendation, analysis_date
         FROM daily_universe_analysis
         WHERE passed_prescreen=true
         ORDER BY analysis_date DESC, ai_score DESC
         LIMIT 15`
    );
    console.log('\n=== TOP 15 SIGNALS ===');
    console.log(JSON.stringify(topSig.rows, null, 2));

    // Check how the bot actually did its last buy decision - look at buy cooldowns
    try {
        const cooldown = await query(
            "SELECT column_name FROM information_schema.columns WHERE table_name='buy_cooldowns' ORDER BY ordinal_position"
        );
        if (cooldown.rows.length > 0) {
            console.log('\nbuy_cooldowns columns:', cooldown.rows.map(r=>r.column_name));
            const cd = await query('SELECT * FROM buy_cooldowns WHERE user_id=$1', [userId]);
            console.log('buy_cooldowns:', JSON.stringify(cd.rows, null, 2));
        }
    } catch(e) {}

    // Check all active_ai_users query the scheduler uses
    const activeUsers = await query(
        "SELECT id, username, ai_trading_enabled FROM users WHERE ai_trading_enabled=true"
    );
    console.log('\n=== ACTIVE AI USERS ===');
    console.log(JSON.stringify(activeUsers.rows, null, 2));

    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
