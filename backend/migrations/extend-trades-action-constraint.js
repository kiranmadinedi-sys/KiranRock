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
        console.log('Extending trades.action check constraint to include DEPOSIT/WITHDRAWAL');

        // Drop existing constraint if exists
        try {
            await pool.query(`ALTER TABLE trades DROP CONSTRAINT IF EXISTS trades_action_check`);
            console.log('Dropped old constraint (if existed)');
        } catch (e) {
            console.warn('Could not drop constraint:', e.message);
        }

        // Add new constraint allowing more action types
        await pool.query(`ALTER TABLE trades ADD CONSTRAINT trades_action_check CHECK (action IN ('BUY','SELL','DEPOSIT','WITHDRAWAL'))`);
        console.log('Added new constraint');

        await pool.end();
        console.log('Constraint update complete');
    } catch (err) {
        console.error('Constraint update failed:', err.message);
        process.exit(1);
    }
})();
