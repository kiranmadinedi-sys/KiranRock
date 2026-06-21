require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/database');
const Alpaca = require('@alpacahq/alpaca-trade-api');

const USER = 'ca632c53-8798-46f4-be94-29be0fede7f2';
const SYMBOLS = ['CEVA', 'ALGM'];

async function getAlpacaCreds() {
    const r = await query(`SELECT alpaca_key_id, alpaca_secret_key, alpaca_paper FROM users WHERE id=$1`, [USER]);
    const row = r.rows[0];
    return { keyId: row.alpaca_key_id, secretKey: row.alpaca_secret_key, paper: row.alpaca_paper };
}

async function getAuditCols() {
    const r = await query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, ['order_audit_log']);
    return r.rows.map(c => c.column_name);
}
async function getReconCols() {
    const r = await query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, ['position_reconciliation_log']);
    return r.rows.map(c => c.column_name);
}

async function main() {
    const creds = await getAlpacaCreds();
    const alpaca = new Alpaca({
        keyId: creds.keyId,
        secretKey: creds.secretKey,
        paper: !!creds.paper,
        baseUrl: creds.paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets',
    });

    const auditCols = await getAuditCols();
    const reconCols = await getReconCols();

    for (const sym of SYMBOLS) {
        console.log('\n' + '='.repeat(60));
        console.log('  INVESTIGATION: ' + sym);
        console.log('='.repeat(60));

        // 1. DB trades
        const trades = await query(
            `SELECT action, price, quantity, pnl, pnl_percent, ai_score, status,
                    executed_by, notes, trade_date
             FROM trades
             WHERE user_id=$1 AND symbol=$2
             ORDER BY trade_date DESC LIMIT 10`,
            [USER, sym]
        );
        console.log('\n[DB trades]');
        if (trades.rows.length === 0) console.log('  (none)');
        trades.rows.forEach(t => {
            const pct = t.pnl_percent != null ? (parseFloat(t.pnl_percent)*100).toFixed(2) + '%' : 'n/a';
            console.log('  ' + (t.action||'').padEnd(4) + ' ' + (t.trade_date||'').toString().slice(0,16)
                + '  price=$' + (t.price||'?')
                + '  qty=' + t.quantity
                + '  pnl=$' + (t.pnl||'0') + ' (' + pct + ')'
                + '  score=' + (t.ai_score||'?')
                + '  status=' + (t.status||'?')
                + '  exec=' + (t.executed_by||'?')
                + (t.notes ? '  notes=' + t.notes : '')
            );
        });

        // 2. DB holdings
        const holdings = await query(
            `SELECT quantity, average_price, current_price, gain_loss_percent, sector, purchase_date
             FROM holdings WHERE user_id=$1 AND symbol=$2`,
            [USER, sym]
        );
        console.log('\n[DB holdings]');
        if (holdings.rows.length === 0) console.log('  (none — position is closed)');
        holdings.rows.forEach(h => {
            console.log('  qty=' + h.quantity + '  avg_entry=$' + h.average_price
                + '  current=$' + (h.current_price||'?')
                + '  pnl%=' + (h.gain_loss_percent != null ? (parseFloat(h.gain_loss_percent)*100).toFixed(2)+'%' : 'n/a')
                + '  sector=' + (h.sector||'Unknown')
                + '  since=' + (h.purchase_date||'?').toString().slice(0,10)
            );
        });

        // 3. Reconciliation log
        if (reconCols.length > 0) {
            const dateCol = reconCols.includes('reconciled_at') ? 'reconciled_at' : reconCols.find(c=>c.includes('at'))||'created_at';
            const recon = await query(
                `SELECT * FROM position_reconciliation_log WHERE user_id=$1 AND symbol=$2 ORDER BY ${dateCol} DESC LIMIT 10`,
                [USER, sym]
            );
            console.log('\n[Reconciliation log] (cols: ' + reconCols.join(', ') + ')');
            if (recon.rows.length === 0) console.log('  (none)');
            recon.rows.forEach(r => {
                console.log('  ' + JSON.stringify(r));
            });
        } else {
            console.log('\n[Reconciliation log] table not found');
        }

        // 4. Order audit log
        if (auditCols.length > 0) {
            const dateCol = auditCols.includes('created_at') ? 'created_at' : auditCols.find(c=>c.includes('at'))||'id';
            const audit = await query(
                `SELECT * FROM order_audit_log WHERE user_id=$1 AND symbol=$2 ORDER BY ${dateCol} DESC LIMIT 15`,
                [USER, sym]
            );
            console.log('\n[Order audit log] (cols: ' + auditCols.join(', ') + ')');
            if (audit.rows.length === 0) console.log('  (none)');
            audit.rows.forEach(a => {
                console.log('  ' + JSON.stringify(a));
            });
        } else {
            console.log('\n[Order audit log] table not found');
        }

        // 5. Alpaca orders for this symbol
        try {
            const orders = await alpaca.getOrders({ status: 'all', limit: 100, direction: 'desc' });
            const symOrders = orders.filter(o => o.symbol === sym);
            console.log('\n[Alpaca orders for ' + sym + '] (' + symOrders.length + ' found)');
            if (symOrders.length === 0) console.log('  (none in last 100 orders)');
            symOrders.forEach(o => {
                console.log('  ' + (o.submitted_at||o.created_at||'').slice(0,16)
                    + '  ' + (o.side||'').padEnd(4)
                    + '  type=' + (o.order_type||'').padEnd(18)
                    + '  qty=' + o.qty
                    + '  filled=' + (o.filled_qty||0)
                    + '  limit=$' + (o.limit_price||'-')
                    + '  stop=$' + (o.stop_price||'-')
                    + '  trail=' + (o.trail_percent ? o.trail_percent+'%' : '-')
                    + '  status=' + o.status
                    + '  filled_avg=$' + (o.filled_avg_price||'-')
                );
            });
        } catch(e) { console.log('\n[Alpaca orders] ERROR: ' + e.message); }

        // 6. Alpaca FILL activities
        try {
            const activities = await alpaca.getAccountActivities({ activity_types: 'FILL', after: '2026-06-01' });
            const symActs = activities.filter(a => a.symbol === sym);
            console.log('\n[Alpaca FILL activities for ' + sym + '] (' + symActs.length + ' found)');
            if (symActs.length === 0) console.log('  (none since Jun 1)');
            symActs.forEach(a => {
                console.log('  ' + (a.transaction_time||'').slice(0,16)
                    + '  side=' + (a.side||'?').padEnd(5)
                    + '  qty=' + a.qty
                    + '  price=$' + a.price
                    + '  cum_qty=' + (a.cum_qty||'?')
                    + '  order_id=' + (a.order_id||'?')
                );
            });
        } catch(e) { console.log('\n[Alpaca activities] ERROR: ' + e.message); }
    }

    process.exit(0);
}
main().catch(function(e){ console.error(e.message, e.stack); process.exit(1); });
