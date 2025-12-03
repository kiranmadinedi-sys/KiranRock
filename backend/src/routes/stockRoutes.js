const express = require('express');
const { getStockData, getAvailableStocks, searchStocks, addStockSymbol, getStockPrice } = require('../controllers/stockController');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

// Middleware to disable caching
const noCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};


// router.get('/symbols', protect, getAvailableStocks);
// router.post('/symbols', protect, addStockSymbol);
// router.get('/search', protect, searchStocks);
// router.get('/:symbol', protect, getStockData);
// router.get('/price/:symbol', protect, getStockPrice);

const { removeStockSymbol } = require('../controllers/stockController');
router.delete('/symbols/:symbol', removeStockSymbol);

// Temporarily disable auth for testing
router.get('/symbols', noCache, getAvailableStocks);
router.post('/symbols', addStockSymbol);
router.get('/search', noCache, searchStocks);
router.get('/:symbol', noCache, getStockData);
router.get('/price/:symbol', noCache, getStockPrice);

module.exports = router;
