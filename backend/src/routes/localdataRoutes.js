// backend/src/routes/localdataRoutes.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/database');

// GET /api/localdata/tickers — returns loaded tickers from stock_prices
router.get('/localdata/tickers', async (req, res) => {
  try {
    const result = await query('SELECT DISTINCT symbol FROM stock_prices ORDER BY symbol ASC');
    res.json({ tickers: result.rows.map(r => r.symbol) });
  } catch (e) {
    res.status(500).json({ tickers: [], error: e.message });
  }
});

module.exports = router;
