const dotenv = require('dotenv');
const { query } = require('./src/config/database');
const tradingAccountService = require('./src/services/tradingAccountService');
const optionsBotScheduler = require('./src/services/optionsBotScheduler');

dotenv.config();

async function enableOptionsBot() {
    const username = process.env.BOT_USERNAME || 'user';
    const runScanNow = process.argv.includes('--scan-now');
    const minScoreArg = process.argv.find((arg) => arg.startsWith('--min-score='));
    const minOpportunityScore = Number(minScoreArg?.split('=')[1] || process.env.MIN_OPTIONS_OPPORTUNITY_SCORE || 70);

    try {
        const userResult = await query(
            'SELECT id, username FROM users WHERE username = $1 LIMIT 1',
            [username]
        );

        if (userResult.rows.length === 0) {
            throw new Error(`User "${username}" not found`);
        }

        const user = userResult.rows[0];
        const account = await tradingAccountService.getTradingAccount(user.id);

        await query(
            `INSERT INTO options_bot_config (
                user_id,
                enabled,
                scalping_enabled,
                swing_enabled,
                spreads_enabled,
                hedging_enabled,
                max_position_risk,
                max_account_risk,
                max_open_positions,
                max_daily_loss,
                position_size_method,
                fixed_contracts,
                take_profit_percent,
                stop_loss_percent,
                trailing_stop_percent,
                trading_start_time,
                trading_end_time,
                min_liquidity_score,
                min_opportunity_score,
                updated_at
            ) VALUES (
                $1, true, true, true, true, false,
                0.015, 0.08, 3, 500,
                'greeks', 1,
                35, 20, 12,
                '09:45:00', '15:30:00',
                60, $2, NOW()
            )
            ON CONFLICT (user_id) DO UPDATE SET
                enabled = true,
                scalping_enabled = true,
                swing_enabled = true,
                spreads_enabled = true,
                hedging_enabled = false,
                max_position_risk = 0.015,
                max_account_risk = 0.08,
                max_open_positions = 3,
                max_daily_loss = 500,
                position_size_method = 'greeks',
                fixed_contracts = 1,
                take_profit_percent = 35,
                stop_loss_percent = 20,
                trailing_stop_percent = 12,
                trading_start_time = '09:45:00',
                trading_end_time = '15:30:00',
                min_liquidity_score = 60,
                min_opportunity_score = $2,
                updated_at = NOW()`,
            [user.id, minOpportunityScore]
        );

        console.log(`✅ Options Bot enabled for ${user.username}`);
        console.log(`   User ID: ${user.id}`);
        console.log(`   Paper balance: $${Number(account.balance || 0).toFixed(2)}`);
        console.log('   Professional defaults:');
        console.log('   - Max open positions: 3');
        console.log('   - Max position risk: 1.5%');
        console.log('   - Max account risk: 8%');
        console.log('   - Daily loss cap: $500');
        console.log('   - Take profit: 35%');
        console.log('   - Stop loss: 20%');
        console.log('   - Min liquidity score: 60');
        console.log(`   - Min opportunity score: ${minOpportunityScore}`);

        if (runScanNow) {
            await optionsBotScheduler.manualTrigger(user.id);
            console.log('⚡ Manual paper-trading scan completed.');
        } else {
            console.log('ℹ️ Use --scan-now to trigger an immediate paper-trading scan.');
            console.log('ℹ️ Use --min-score=NUMBER to tune signal cadence.');
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Failed to enable Options Bot:', error.message);
        process.exit(1);
    }
}

enableOptionsBot();
