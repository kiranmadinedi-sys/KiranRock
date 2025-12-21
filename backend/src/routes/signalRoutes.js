const express = require('express');
const { getSignal, getHistoricalSignals } = require('../controllers/stockController');
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

// Temporarily disable auth for local development/testing
router.get('/historical/:symbol', noCache, getHistoricalSignals);
router.get('/:symbol', noCache, getSignal);

module.exports = router;
