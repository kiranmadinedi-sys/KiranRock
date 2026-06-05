require('dotenv').config();
const { query } = require('./src/config/database');

(async () => {
    // 0. Get holdings column names
    const hcols = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='holdings' ORDER BY ordinal_position`);
    console.log('holdings columns:', hcols.rows.map(r=>r.column_name).join(', '));

    // 1. Check ALL holdings (all users)
    const h = await query(`SELECT * FROM holdings WHERE quantity > 0 ORDER BY user_id, symbol`);
    console.log('\n=== ALL HOLDINGS (quantity > 0) === Count:', h.rows.length);
    h.rows.forEach(r => console.log(JSON.stringify(r)));

    // 2. Check ALL trades (last 20 across all users)
    const t = await query(`SELECT user_id, symbol, action, quantity, price, trade_date, executed_by, status FROM trades ORDER BY id DESC LIMIT 20`);
    console.log('\n=== ALL TRADES (last 20) === Count:', t.rows.length);
    t.rows.forEach(r => console.log(JSON.stringify(r)));

    // 3. Check trading_accounts for all users
    const ta = await query(`SELECT ta.user_id, u.username, ta.balance, ta.initial_balance FROM trading_accounts ta JOIN users u ON u.id=ta.user_id ORDER BY u.username`);
    console.log('\n=== TRADING ACCOUNTS ===');
    ta.rows.forEach(r => console.log(r.username.padEnd(12), 'balance:', r.balance, 'initial:', r.initial_balance));

    // 4. Check Alpaca paper positions (via DB or broker)
    try {
        const brokerService = require('./src/services/brokerService');
        const positions = await brokerService.getPositions();
        console.log('\n=== ALPACA PAPER POSITIONS ===', positions.length, 'positions');
        positions.forEach(p => console.log(p.symbol, 'qty:', p.qty, 'market_value:', p.market_value));
    } catch(e) { console.log('broker positions error:', e.message); }

    // 5. What users does the scheduler actually trade for?
    const activeUsers = await query(`SELECT id, username, ai_trading_enabled FROM users WHERE ai_trading_enabled = true AND is_active = true ORDER BY username`);
    console.log('\n=== ACTIVE AI TRADING USERS ===');
    activeUsers.rows.forEach(r => console.log(r.username, r.id, 'enabled:', r.ai_trading_enabled));

    process.exit(0);
})().catch(err => { console.error(err.message); process.exit(1); });
