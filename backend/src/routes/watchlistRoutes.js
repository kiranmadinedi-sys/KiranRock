const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/authMiddleware');
const {
    getWatchlist,
    addSymbol,
    removeSymbol,
    updateWatchlist,
    clearWatchlist
} = require('../controllers/watchlistController');

// All routes require authentication
router.use(protect);

// Get user's watchlist
router.get('/', getWatchlist);

// Add symbol to watchlist
router.post('/add', addSymbol);

// Remove symbol from watchlist
router.delete('/remove/:symbol', removeSymbol);

// Update entire watchlist
router.put('/update', updateWatchlist);

// Clear watchlist
router.delete('/clear', clearWatchlist);

module.exports = router;
