const fs = require('fs');
const path = require('path');

const WATCHLIST_FILE = path.join(__dirname, '../storage/watchlists.json');

// Ensure storage directory exists
const storageDir = path.dirname(WATCHLIST_FILE);
if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
}

// Initialize watchlists file if it doesn't exist
if (!fs.existsSync(WATCHLIST_FILE)) {
    fs.writeFileSync(WATCHLIST_FILE, JSON.stringify({}, null, 2));
}

// Read watchlists from file
function readWatchlists() {
    try {
        const data = fs.readFileSync(WATCHLIST_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error('Error reading watchlists:', error);
        return {};
    }
}

// Write watchlists to file
function writeWatchlists(watchlists) {
    try {
        fs.writeFileSync(WATCHLIST_FILE, JSON.stringify(watchlists, null, 2));
    } catch (error) {
        console.error('Error writing watchlists:', error);
        throw error;
    }
}

// Get user's watchlist
function getUserWatchlist(userId) {
    const watchlists = readWatchlists();
    return watchlists[userId] || [];
}

// Add symbol to user's watchlist
function addToWatchlist(userId, symbol) {
    const watchlists = readWatchlists();
    
    if (!watchlists[userId]) {
        watchlists[userId] = [];
    }
    
    // Check if symbol already exists
    if (!watchlists[userId].includes(symbol.toUpperCase())) {
        watchlists[userId].push(symbol.toUpperCase());
        writeWatchlists(watchlists);
        return { success: true, watchlist: watchlists[userId] };
    }
    
    return { success: false, message: 'Symbol already in watchlist', watchlist: watchlists[userId] };
}

// Remove symbol from user's watchlist
function removeFromWatchlist(userId, symbol) {
    const watchlists = readWatchlists();
    
    if (!watchlists[userId]) {
        return { success: false, message: 'Watchlist not found' };
    }
    
    const index = watchlists[userId].indexOf(symbol.toUpperCase());
    if (index > -1) {
        watchlists[userId].splice(index, 1);
        writeWatchlists(watchlists);
        return { success: true, watchlist: watchlists[userId] };
    }
    
    return { success: false, message: 'Symbol not found in watchlist', watchlist: watchlists[userId] };
}

// Update entire watchlist for a user
function updateWatchlist(userId, symbols) {
    const watchlists = readWatchlists();
    watchlists[userId] = symbols.map(s => s.toUpperCase());
    writeWatchlists(watchlists);
    return { success: true, watchlist: watchlists[userId] };
}

// Clear user's watchlist
function clearWatchlist(userId) {
    const watchlists = readWatchlists();
    watchlists[userId] = [];
    writeWatchlists(watchlists);
    return { success: true, watchlist: [] };
}

module.exports = {
    getUserWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    updateWatchlist,
    clearWatchlist
};
