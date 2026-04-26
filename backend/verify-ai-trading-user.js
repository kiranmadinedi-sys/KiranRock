const { query } = require('./src/config/database');

async function verifyUserAITrading() {
    try {
        console.log('=== Verifying AI Trading Setup for User "user" ===\n');

        // 1. Check user and AI Trading status
        console.log('1. Checking User & AI Trading Status...');
        const userResult = await query(
            'SELECT id, username, email, ai_trading_enabled, created_at FROM users WHERE username = $1',
            ['user']
        );

        if (userResult.rows.length === 0) {
            console.log('❌ User not found');
            process.exit(1);
        }

        const user = userResult.rows[0];
        console.log('✓ User Found:');
        console.log('   Username:', user.username);
        console.log('   Email:', user.email);
        console.log('   AI Trading Enabled:', user.ai_trading_enabled ? '✅ YES' : '❌ NO');
        console.log('   User ID:', user.id);

        // 2. Check trading account balance
        console.log('\n2. Checking Trading Account...');
        const accountResult = await query(
            'SELECT balance FROM trading_accounts WHERE user_id = $1',
            [user.id]
        );

        if (accountResult.rows.length === 0) {
            console.log('❌ No trading account found');
            process.exit(1);
        }

        const account = accountResult.rows[0];
        const balance = parseFloat(account.balance);
        console.log('✓ Trading Account:');
        console.log('   Balance: $' + balance.toFixed(2));
        console.log('   Status:', balance >= 100 ? '✅ Sufficient funds' : '⚠️  Need at least $100');

        // 3. Check current portfolio holdings
        console.log('\n3. Checking Current Portfolio...');
        const portfolioResult = await query(
            'SELECT symbol, quantity, average_price, current_price, market_value, gain_loss_percent, purchase_date FROM holdings WHERE user_id = $1 ORDER BY purchase_date DESC',
            [user.id]
        );

        if (portfolioResult.rows.length === 0) {
            console.log('   Portfolio: Empty (AI will initialize on first run)');
        } else {
            console.log(`   Holdings: ${portfolioResult.rows.length} positions`);
            let totalValue = 0;
            portfolioResult.rows.forEach(holding => {
                const value = parseFloat(holding.market_value || 0);
                totalValue += value;
                const pnl = parseFloat(holding.gain_loss_percent || 0);
                console.log(`   - ${holding.symbol}: ${holding.quantity} shares @ $${parseFloat(holding.average_price).toFixed(2)} | Current: $${parseFloat(holding.current_price || holding.average_price).toFixed(2)} | Value: $${value.toFixed(2)} | P/L: ${pnl.toFixed(2)}%`);
            });
            console.log(`   Total Portfolio Value: $${totalValue.toFixed(2)}`);
        }

        // 4. Summary and expectations
        console.log('\n' + '='.repeat(70));
        console.log('📊 AI TRADING STATUS SUMMARY');
        console.log('='.repeat(70));
        
        if (user.ai_trading_enabled && balance >= 100) {
            console.log('\n✅ AI Trading is READY TO RUN!\n');
            console.log('📅 Next Actions (Monday during market hours 9:30 AM - 4:00 PM ET):');
            console.log('   1. AI bot runs every 5 minutes automatically');
            
            if (portfolioResult.rows.length === 0) {
                console.log('   2. FIRST RUN: AI will invest $' + balance.toFixed(2) + ' across 10 stocks');
                console.log('      - Max 20% per stock (~$' + (balance * 0.2).toFixed(2) + ' each)');
                console.log('      - 10% cash reserve (~$' + (balance * 0.1).toFixed(2) + ' kept in balance)');
                console.log('      - Diversified across sectors');
            } else {
                console.log('   2. MONITOR existing positions for stop-loss/take-profit');
                console.log('   3. REBALANCE based on AI signals');
            }
            
            console.log('   3. AUTO-SELL if stock drops -12% to -15% (stop-loss)');
            console.log('   4. AUTO-SELL if stock gains +25% to +30% (take-profit)');
            console.log('   5. REBALANCE portfolio based on AI predictions');
            console.log('   6. BUY new stocks if signals are strong');
            console.log('\n📈 Results Visible On:');
            console.log('   • Portfolio Page: Real-time holdings and P/L');
            console.log('   • AI Trading Page (/ai-trading): Decision logs and history');
            console.log('\n⏰ Bot Schedule:');
            console.log('   • Runs: Every 5 minutes');
            console.log('   • Active: Monday-Friday, 9:30 AM - 4:00 PM ET');
            console.log('   • Idle: Outside market hours (no trades executed)');
            
        } else if (!user.ai_trading_enabled) {
            console.log('\n⚠️  AI Trading is DISABLED');
            console.log('   → Go to Profile page and toggle ON to enable');
        } else if (balance < 100) {
            console.log('\n⚠️  Insufficient Balance');
            console.log('   → Need at least $100 to start AI Trading');
            console.log('   → Current: $' + balance.toFixed(2));
        }

        console.log('\n' + '='.repeat(70));
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

verifyUserAITrading();
