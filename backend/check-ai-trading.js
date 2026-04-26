const { Pool } = require('pg');

const pool = new Pool({
    host: 'localhost',
    port: 5432,
    database: 'kiranrock_trading',
    user: 'postgres',
    password: 'admin'
});

(async () => {
    try {
        console.log('========================================');
        console.log('AI TRADING DIAGNOSTIC FOR USER: user');
        console.log('========================================\n');

        // 1. Check user AI trading configuration
        const userRes = await pool.query(`
            SELECT username, ai_trading_enabled 
            FROM users 
            WHERE username = 'user'
        `);
        
        console.log('1. User AI Trading Config:');
        if (userRes.rows.length === 0) {
            console.log('  ERROR: User not found!');
            process.exit(1);
        }
        console.log('  AI Trading Enabled:', userRes.rows[0].ai_trading_enabled);
        console.log('');

        // 2. Check trading account balance
        const accountRes = await pool.query(`
            SELECT ta.balance 
            FROM trading_accounts ta 
            JOIN users u ON ta.user_id = u.id 
            WHERE u.username = 'user'
        `);
        
        console.log('2. Trading Account:');
        if (accountRes.rows.length === 0) {
            console.log('  ERROR: No trading account found!');
        } else {
            console.log('  Balance: $' + accountRes.rows[0].balance);
        }
        console.log('');

        // 3. Check current holdings
        const holdingsRes = await pool.query(`
            SELECT h.symbol, h.quantity, h.average_price, h.current_price 
            FROM holdings h 
            JOIN users u ON h.user_id = u.id 
            WHERE u.username = 'user'
        `);
        
        console.log('3. Current Holdings:');
        if (holdingsRes.rows.length === 0) {
            console.log('  ❌ No holdings found - Portfolio is EMPTY');
        } else {
            holdingsRes.rows.forEach(h => {
                const value = h.quantity * (h.current_price || h.average_price);
                console.log(`  ${h.symbol}: ${h.quantity} shares @ $${h.average_price} (Current: $${h.current_price || 'N/A'}) = $${value.toFixed(2)}`);
            });
        }
        console.log('');

        // 4. Check AI trading logs (skip if table doesn't exist)
        let logsRes = { rows: [] };
        try {
            logsRes = await pool.query(`
                SELECT * FROM ai_trading_logs 
                WHERE user_id = (SELECT id FROM users WHERE username = 'user')
                ORDER BY created_at DESC 
                LIMIT 10
            `);
            
            console.log('4. Recent AI Trading Logs (Last 10):');
            if (logsRes.rows.length === 0) {
                console.log('  ❌ No AI trading activity found');
            } else {
                logsRes.rows.forEach(log => {
                    console.log(`  [${log.created_at}] ${JSON.stringify(log)}`);
                });
            }
        } catch (e) {
            console.log('4. AI Trading Logs:');
            console.log('  (Logs table not available or empty)');
        }
        console.log('');

        // 5. Check recent trades
        const tradesRes = await pool.query(`
            SELECT action, symbol, quantity, price, executed_by, created_at 
            FROM trades 
            WHERE user_id = (SELECT id FROM users WHERE username = 'user')
            AND executed_by = 'AI_BOT'
            ORDER BY created_at DESC 
            LIMIT 5
        `);
        
        console.log('5. Recent AI Bot Trades (Last 5):');
        if (tradesRes.rows.length === 0) {
            console.log('  ❌ No trades executed by AI bot');
            console.log('  📌 AI bot has not made any buy/sell decisions yet');
        } else {
            tradesRes.rows.forEach(trade => {
                console.log(`  [${trade.created_at.toISOString()}] ${trade.action} ${trade.quantity} ${trade.symbol} @ $${trade.price}`);
            });
        }
        console.log('');

        console.log('========================================');
        console.log('DIAGNOSIS SUMMARY');
        console.log('========================================');
        console.log('');
        
        if (holdingsRes.rows.length === 0 && logsRes.rows.length === 0) {
            console.log('⚠️  AI TRADING IS ENABLED BUT NOT ACTIVE');
            console.log('');
            console.log('Possible Reasons:');
            console.log('  1. Enhanced AI Scheduler may not be running');
            console.log('  2. Backend was just restarted (scheduler runs continuously)');
            console.log('  3. AI bot waiting for optimal market conditions');
            console.log('  4. Check backend logs for scheduler activity');
            console.log('');
            console.log('Next Steps:');
            console.log('  • Check if backend is running: http://localhost:3001');
            console.log('  • Look for "[Enhanced AI Scheduler]" in backend logs');
            console.log('  • AI bot analyzes stocks every few minutes when running');
            console.log('  • First trades may take 5-10 minutes after enabling');
        } else if (holdingsRes.rows.length > 0) {
            console.log('✅ AI Trading is ACTIVE with ' + holdingsRes.rows.length + ' holdings');
        } else {
            console.log('🔄 AI Trading has activity but no current holdings');
        }
        console.log('');

        await pool.end();
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
})();
