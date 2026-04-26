const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

const protect = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        
        // Query user from PostgreSQL database
        const result = await query(
            'SELECT id, username, email FROM users WHERE id = $1',
            [decoded.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Access denied. User not found.' });
        }
        
        const user = result.rows[0];
        req.user = user; // Attach the full user object to the request
        req.userId = decoded.id; // Also attach userId for convenience
        next();
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
};

module.exports = { protect };
