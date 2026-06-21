require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/database');

const USER = 'ca632c53-8798-46f4-be94-29be0fede7f2';

async function main() {
    // CEVA: actual Alpaca fill was $49.03 (sell stop, Jun 15)
    // Entry $46.96, 1 share → pnl = +$2.07, pnl_pct = +4.41%
    const cevaFix = await query(`
        UPDATE trades
        SET price = 49.03,
            pnl = 2.07,
            pnl_percent = 4.41,
            notes = 'Stop trailed up by health monitor; actual Alpaca fill $49.03 on 2026-06-15. Originally recorded at stop-order-price $38.63 (reconciler bug — fixed 2026-06-20)'
        WHERE user_id=$1 AND symbol='CEVA' AND action='SELL' AND price=38.63
        RETURNING id, symbol, price, pnl, pnl_percent`,
        [USER]
    );
    if (cevaFix.rows.length > 0) {
        console.log('CEVA corrected:', cevaFix.rows[0]);
    } else {
        console.log('CEVA: no matching SELL at $38.63 found — checking current record...');
        const r = await query(`SELECT id, action, price, pnl, pnl_percent, notes FROM trades WHERE user_id=$1 AND symbol='CEVA' ORDER BY trade_date DESC`, [USER]);
        r.rows.forEach(row => console.log('  ', row));
    }

    // ALGM: actual first Alpaca fill was $55.75 (stop fired Jun 16 14:27)
    // Entry $48.44, 1 share → pnl = +$7.31, pnl_pct = +15.09%
    // (The duplicate short and subsequent cover at $55.44 is a separate issue — net cost -$1.05)
    const algmFix = await query(`
        UPDATE trades
        SET price = 55.75,
            pnl = 7.31,
            pnl_percent = 15.09,
            notes = 'Stop trailed up by health monitor to $55.86; actual Alpaca fill $55.75 on 2026-06-16. Originally recorded at original stop-order-price $40.47 (reconciler bug — fixed 2026-06-20). Note: health monitor placed duplicate stop after close → accidental short at $54.39, covered $55.44, -$1.05 extra cost tracked separately.'
        WHERE user_id=$1 AND symbol='ALGM' AND action='SELL' AND price=40.47
        RETURNING id, symbol, price, pnl, pnl_percent`,
        [USER]
    );
    if (algmFix.rows.length > 0) {
        console.log('ALGM corrected:', algmFix.rows[0]);
    } else {
        console.log('ALGM: no matching SELL at $40.47 found — checking current record...');
        const r = await query(`SELECT id, action, price, pnl, pnl_percent, notes FROM trades WHERE user_id=$1 AND symbol='ALGM' ORDER BY trade_date DESC`, [USER]);
        r.rows.forEach(row => console.log('  ', row));
    }

    // Record the ALGM short/cover as a separate corrective note
    const algmShortNote = await query(`
        INSERT INTO trades (user_id, symbol, action, quantity, price, total, pnl, pnl_percent, status, executed_by, notes, trade_date, sector)
        VALUES ($1, 'ALGM', 'SELL', 1, 54.39, 54.39, -1.05, -1.90, 'CLOSED', 'health_monitor_dup',
            'CORRECTION: duplicate stop by health monitor after position closed → accidental sell_short at $54.39. Covered via buy at $55.44 on 2026-06-17. Net cost -$1.05.',
            '2026-06-16', 'Technology')
        ON CONFLICT DO NOTHING
        RETURNING id`,
        [USER]
    );

    console.log('\nNet P&L impact of corrections:');
    console.log('  CEVA: was -$8.33 → now +$2.07  (swing = +$10.40)');
    console.log('  ALGM: was -$7.86 → now +$7.31  (swing = +$15.17)');
    console.log('  ALGM short dup: -$1.05 (new loss entry)');
    console.log('  Total net correction: +$24.52 added back to P&L');

    process.exit(0);
}
main().catch(e => { console.error(e.message, e.stack); process.exit(1); });
