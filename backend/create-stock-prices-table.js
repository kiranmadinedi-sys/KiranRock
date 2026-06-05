// create-stock-prices-table.js
// Node.js script to create the stock_prices table in PostgreSQL

const { query, connect, disconnect } = require('./src/config/database');

const createTableSQL = `
CREATE TABLE IF NOT EXISTS stock_prices (
    id SERIAL PRIMARY KEY,
    symbol VARCHAR(16) NOT NULL,
    date DATE NOT NULL,
    open NUMERIC(18,6),
    high NUMERIC(18,6),
    low NUMERIC(18,6),
    close NUMERIC(18,6),
    volume BIGINT,
    UNIQUE(symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_stock_prices_symbol_date ON stock_prices(symbol, date);
`;

(async () => {
  try {
    await connect();
    await query(createTableSQL);
    console.log('stock_prices table created or already exists.');
  } catch (e) {
    console.error('Error creating stock_prices table:', e);
  } finally {
    await disconnect();
  }
})();
