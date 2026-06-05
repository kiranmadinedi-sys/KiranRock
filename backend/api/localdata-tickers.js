// backend/api/localdata-tickers.js
// Express-style endpoint for loaded tickers
const express = require('express');
const router = express.Router();
const { query, connect, disconnect } = require('../src/config/database');

router.get('/localdata/tickers', async (req, res) => {
  try {
    await connect();
    const result = await query('SELECT DISTINCT symbol FROM stock_prices ORDER BY symbol ASC');
    await disconnect();
    res.json({ tickers: result.rows.map(r => r.symbol) });
  } catch (e) {
    res.status(500).json({ tickers: [], error: e.message });
  }
});

module.exports = router;
