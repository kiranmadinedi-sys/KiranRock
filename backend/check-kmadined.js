require('dotenv').config();
const { query } = require('./src/config/database');

const userId = 'ca632c53-8798-46f4-be94-29be0fede7f2';

(async () => {
    // All trades today
    const trades = await query(
        `SELECT id, symbol, action, quantity, price, total, trade_date, executed_by, status, pnl, notes
         FROM trades WHERE user_id=$1 ORDER BY trade_date DESC LIMIT 50`,
        [userId]
    );
    console.log('\n=== ALL TRADES (latest 50) ===');
    console.log(JSON.stringify(trades.rows, null, 2));

    // All holdings
    const holdings = await query(
        `SELECT symbol, quantity, average_price, current_price, purchase_date FROM holdings WHERE user_id=$1`,
        [userId]
    );
    console.log('\n=== HOLDINGS ===');
    console.log(JSON.stringify(holdings.rows, null, 2));

    // Account balance
    const acct = await query(
        `SELECT balance, initial_balance, created_at, updated_at FROM trading_accounts WHERE user_id=$1`,
        [userId]
    );
    console.log('\n=== ACCOUNT ===');
    console.log(JSON.stringify(acct.rows, null, 2));

    // Check Alpaca positions via brokerService
    try {
        const brokerService = require('./src/services/brokerService');
        const positions = await brokerService.getPositions(userId);
        console.log('\n=== ALPACA POSITIONS ===');
        console.log(JSON.stringify(positions, null, 2));
    } catch(e) {
        console.log('\n=== ALPACA POSITIONS ERROR ===', e.message);
    }

    // Check Alpaca orders placed today via Alpaca API directly
    try {
        const Alpaca = require('@alpacahq/alpaca-trade-api');
        const alpaca = new Alpaca({
            keyId: process.env.ALPACA_KEY_ID,
            secretKey: process.env.ALPACA_SECRET_KEY,
            paper: true
        });
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const orders = await alpaca.getOrders({ status: 'all', after: today.toISOString(), limit: 50 });
        console.log('\n=== ALPACA ORDERS TODAY ===', orders.length);
        console.log(JSON.stringify(orders.map(o => ({
            symbol: o.symbol, side: o.side, qty: o.qty, status: o.status,
            type: o.type, filled_qty: o.filled_qty, filled_avg_price: o.filled_avg_price,
            submitted_at: o.submitted_at, filled_at: o.filled_at
        })), null, 2));
    } catch(e) {
        console.log('\n=== ALPACA ORDERS ERROR ===', e.message);
    }

    process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
