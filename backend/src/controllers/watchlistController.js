const watchlistService = require('../services/watchlistService');

// Get user's watchlist
const getWatchlist = async (req, res) => {
    try {
        const userId = req.user.id;
        const watchlist = watchlistService.getUserWatchlist(userId);
        res.json({ success: true, watchlist });
    } catch (error) {
        console.error('Error getting watchlist:', error);
        res.status(500).json({ success: false, message: 'Failed to get watchlist' });
    }
};

// Add symbol to watchlist
const addSymbol = async (req, res) => {
    try {
        const userId = req.user.id;
        const { symbol } = req.body;
        
        if (!symbol) {
            return res.status(400).json({ success: false, message: 'Symbol is required' });
        }
        
        const result = watchlistService.addToWatchlist(userId, symbol);
        res.json(result);
    } catch (error) {
        console.error('Error adding to watchlist:', error);
        res.status(500).json({ success: false, message: 'Failed to add symbol' });
    }
};

// Remove symbol from watchlist
const removeSymbol = async (req, res) => {
    try {
        const userId = req.user.id;
        const { symbol } = req.params;
        
        if (!symbol) {
            return res.status(400).json({ success: false, message: 'Symbol is required' });
        }
        
        const result = watchlistService.removeFromWatchlist(userId, symbol);
        res.json(result);
    } catch (error) {
        console.error('Error removing from watchlist:', error);
        res.status(500).json({ success: false, message: 'Failed to remove symbol' });
    }
};

// Update entire watchlist
const updateWatchlist = async (req, res) => {
    try {
        const userId = req.user.id;
        const { symbols } = req.body;
        
        if (!Array.isArray(symbols)) {
            return res.status(400).json({ success: false, message: 'Symbols must be an array' });
        }
        
        const result = watchlistService.updateWatchlist(userId, symbols);
        res.json(result);
    } catch (error) {
        console.error('Error updating watchlist:', error);
        res.status(500).json({ success: false, message: 'Failed to update watchlist' });
    }
};

// Clear watchlist
const clearWatchlist = async (req, res) => {
    try {
        const userId = req.user.id;
        const result = watchlistService.clearWatchlist(userId);
        res.json(result);
    } catch (error) {
        console.error('Error clearing watchlist:', error);
        res.status(500).json({ success: false, message: 'Failed to clear watchlist' });
    }
};

module.exports = {
    getWatchlist,
    addSymbol,
    removeSymbol,
    updateWatchlist,
    clearWatchlist
};
