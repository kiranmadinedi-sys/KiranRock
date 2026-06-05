// backfill-stock-prices.js
// Fetches historical OHLCV data for all tickers and stores in stock_prices table

const { getStockUniverse } = require('./src/services/stockUniverseService');
const { getStockData } = require('./src/services/stockDataService');
const { query, connect, disconnect } = require('./src/config/database');

async function upsertPrice(symbol, candle) {
  const sql = `
    INSERT INTO stock_prices (symbol, date, open, high, low, close, volume)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (symbol, date) DO UPDATE SET
      open = EXCLUDED.open,
      high = EXCLUDED.high,
      low = EXCLUDED.low,
      close = EXCLUDED.close,
      volume = EXCLUDED.volume;
  `;
  const params = [
    symbol,
    new Date(candle.time * 1000).toISOString().slice(0, 10),
    candle.open,
    candle.high,
    candle.low,
    candle.close,
    candle.volume
  ];
  await query(sql, params);
}

(async () => {
  await connect();
  const tickers = await getStockUniverse();
  for (const symbol of tickers) {
    console.log(`Fetching data for ${symbol}...`);
    try {
      const candles = await getStockData(symbol, '1d');
      if (candles && candles.length > 0) {
        for (const candle of candles) {
          await upsertPrice(symbol, candle);
        }
        console.log(`  → ${candles.length} days upserted for ${symbol}`);
      } else {
        console.log(`  → No data for ${symbol}`);
      }
    } catch (e) {
      console.error(`  → Error for ${symbol}:`, e.message);
    }
  }
  await disconnect();
  console.log('Backfill complete.');
})();
