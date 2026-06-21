require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/database');

async function main() {
    // 1. Options trades from trades table
    const trades = await query(`
        SELECT symbol, action, quantity, price, pnl, pnl_percent,
               ai_score, notes, trade_date, executed_by
        FROM trades
        WHERE trade_date >= NOW() - INTERVAL '30 days'
          AND (executed_by ILIKE '%option%' OR notes ILIKE '%option%'
               OR notes ILIKE '%call%' OR notes ILIKE '%put%')
        ORDER BY trade_date DESC
    `);
    console.log('=== OPTIONS TRADES (last 30d) ===');
    console.log('Count:', trades.rows.length);
    trades.rows.forEach(r => console.log(
        `  ${r.trade_date?.toISOString?.()?.slice(0,10)} ${r.symbol} ${r.action}`
        + ` qty=${r.quantity} price=${r.price} pnl=${r.pnl} pnl%=${r.pnl_percent}`
        + ` score=${r.ai_score} by=${r.executed_by}`
    ));

    // 2. TDJ options entries
    const tdj = await query(`
        SELECT symbol, bot_type, decision_phase, score, confidence, regime,
               pnl, pnl_percent, outcome, setup_family, strategy_family,
               metadata->>'exitReason' as exit_reason,
               metadata->>'sector' as sector,
               opened_at, closed_at
        FROM trade_decision_journal
        WHERE opened_at >= NOW() - INTERVAL '30 days'
          AND (bot_type ILIKE '%option%' OR setup_family ILIKE '%option%'
               OR strategy_family ILIKE '%option%')
        ORDER BY opened_at DESC
    `);
    console.log('\n=== OPTIONS TDJ ENTRIES (last 30d) ===');
    console.log('Count:', tdj.rows.length);
    tdj.rows.forEach(r => console.log(JSON.stringify(r)));

    // 3. All bot_types in TDJ last 30d
    const bots = await query(`
        SELECT bot_type, decision_phase, COUNT(*) as cnt,
               COUNT(*) FILTER (WHERE outcome='win') as wins,
               ROUND(AVG(pnl_percent)::numeric,2) as avg_pct
        FROM trade_decision_journal
        WHERE opened_at >= NOW() - INTERVAL '30 days'
        GROUP BY bot_type, decision_phase
        ORDER BY cnt DESC
    `);
    console.log('\n=== ALL BOT TYPES IN TDJ (last 30d) ===');
    bots.rows.forEach(r => console.log(JSON.stringify(r)));

    // 4. Market regimes active last 30d
    const regimes = await query(`
        SELECT regime, COUNT(*) as cnt
        FROM trade_decision_journal
        WHERE opened_at >= NOW() - INTERVAL '30 days'
        GROUP BY regime ORDER BY cnt DESC
    `);
    console.log('\n=== REGIMES (last 30d) ===');
    regimes.rows.forEach(r => console.log(JSON.stringify(r)));

    // 5. Any options-related notes in trades
    const optNotes = await query(`
        SELECT symbol, action, price, pnl, pnl_percent, trade_date, notes
        FROM trades
        WHERE trade_date >= NOW() - INTERVAL '30 days'
          AND notes IS NOT NULL AND notes != ''
        ORDER BY trade_date DESC LIMIT 20
    `);
    console.log('\n=== RECENT TRADE NOTES (last 30d) ===');
    optNotes.rows.forEach(r => console.log(
        `  ${r.trade_date?.toISOString?.()?.slice(0,10)} ${r.symbol} ${r.action} pnl=${r.pnl} | ${r.notes?.slice(0,100)}`
    ));

    process.exit(0);
}
main().catch(e => { console.error(e.message, e.stack); process.exit(1); });
