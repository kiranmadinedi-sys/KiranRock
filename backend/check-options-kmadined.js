require('dotenv').config();
const { query } = require('./src/config/database');

(async () => {
    // Check options_open_positions for kmadined
    try {
        const pos = await query(`SELECT * FROM options_open_positions WHERE user_id = 'kmadined' ORDER BY opened_at DESC LIMIT 10`);
        console.log('\n=== options_open_positions for kmadined ===');
        console.log('Count:', pos.rows.length);
        pos.rows.forEach(r => console.log(JSON.stringify(r)));
    } catch(e) { console.log('options_open_positions error:', e.message); }

    // Check options_trades columns + data for kmadined
    try {
        const cols = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='options_trades' ORDER BY ordinal_position`);
        console.log('\n=== options_trades columns ===', cols.rows.map(r=>r.column_name).join(', '));

        const tr = await query(`SELECT * FROM options_trades WHERE user_id = 'kmadined' ORDER BY id DESC LIMIT 10`);
        console.log('=== options_trades for kmadined === Count:', tr.rows.length);
        tr.rows.forEach(r => console.log(JSON.stringify(r)));
    } catch(e) { console.log('options_trades error:', e.message); }

    // Check trades table columns + data
    try {
        const cols = await query(`SELECT column_name FROM information_schema.columns WHERE table_name='trades' ORDER BY ordinal_position`);
        console.log('\n=== trades columns ===', cols.rows.map(r=>r.column_name).join(', '));

        const tr = await query(`SELECT * FROM trades WHERE user_id = 'kmadined' ORDER BY id DESC LIMIT 10`);
        console.log('=== trades for kmadined === Count:', tr.rows.length);
        tr.rows.forEach(r => console.log(JSON.stringify(r)));
    } catch(e) { console.log('trades error:', e.message); }

    // Check options_alerts for kmadined
    try {
        const al = await query(`SELECT * FROM options_alerts WHERE user_id = 'kmadined' ORDER BY id DESC LIMIT 10`);
        console.log('\n=== options_alerts for kmadined === Count:', al.rows.length);
        al.rows.forEach(r => console.log(JSON.stringify(r)));
    } catch(e) { console.log('options_alerts error:', e.message); }

    // Check options_bot_config for kmadined
    try {
        const cfg = await query(`SELECT * FROM options_bot_config WHERE user_id = 'kmadined'`);
        console.log('\n=== options_bot_config for kmadined === Count:', cfg.rows.length);
        cfg.rows.forEach(r => console.log(JSON.stringify(r)));
    } catch(e) { console.log('options_bot_config error:', e.message); }

    // Check options_performance for kmadined
    try {
        const perf = await query(`SELECT * FROM options_performance WHERE user_id = 'kmadined' ORDER BY id DESC LIMIT 5`);
        console.log('\n=== options_performance for kmadined === Count:', perf.rows.length);
        perf.rows.forEach(r => console.log(JSON.stringify(r)));
    } catch(e) { console.log('options_performance error:', e.message); }

    process.exit(0);
})().catch(err => { console.error(err); process.exit(1); });
