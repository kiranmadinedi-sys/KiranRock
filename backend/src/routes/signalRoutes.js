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

router.get('/historical/:symbol', protect, noCache, getHistoricalSignals);
router.get('/:symbol', protect, noCache, getSignal);

module.exports = router;
