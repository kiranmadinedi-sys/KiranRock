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
        console.log('Creating trade_lots table');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS trade_lots (
                id SERIAL PRIMARY KEY,
                trade_id INTEGER REFERENCES trades(id) ON DELETE SET NULL,
                user_id VARCHAR(50) NOT NULL,
                symbol VARCHAR(10) NOT NULL,
                quantity INTEGER NOT NULL,
                remaining_quantity INTEGER NOT NULL,
                price DECIMAL(10,2) NOT NULL,
                commission DECIMAL(10,2) DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await pool.end();
        console.log('trade_lots table created');
    } catch (err) {
        console.error('Failed to create trade_lots table:', err.message);
        process.exit(1);
    }
})();
