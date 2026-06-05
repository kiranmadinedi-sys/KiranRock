const { query } = require('./src/config/database');
const { ensurePhase0Schema } = require('./src/services/tradingControlService');

async function main() {
    const command = (process.argv[2] || '').toLowerCase();
    const reason = process.argv.slice(3).join(' ').trim() || null;

    if (!['on', 'off', 'status'].includes(command)) {
        console.log('Usage:');
        console.log('  node set-global-trading-kill-switch.js on [reason]');
        console.log('  node set-global-trading-kill-switch.js off [reason]');
        console.log('  node set-global-trading-kill-switch.js status');
        process.exit(1);
    }

    await ensurePhase0Schema();

    if (command === 'status') {
        const result = await query('SELECT global_trading_enabled, kill_switch_reason, updated_at FROM system_controls WHERE id = 1');
        console.log(result.rows[0]);
        return;
    }

    const globalTradingEnabled = command === 'off';

    const result = await query(`
        UPDATE system_controls
        SET global_trading_enabled = $1,
            kill_switch_reason = $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = 1
        RETURNING global_trading_enabled, kill_switch_reason, updated_at
    `, [globalTradingEnabled, reason]);

    console.log(result.rows[0]);
}

main().catch((error) => {
    console.error('Failed to update global trading kill switch:', error.message);
    process.exit(1);
});