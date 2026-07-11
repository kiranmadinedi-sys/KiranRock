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
            'SELECT id, username, email, is_admin, is_active FROM users WHERE id = $1',
            [decoded.id]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Access denied. User not found.' });
        }

        const user = result.rows[0];

        // Re-checked on every request (not just at login) so a JWT issued before an admin
        // deactivates this account (soft delete) stops working immediately, instead of
        // staying valid for the rest of its 7-day life (2026-07-11).
        if (user.is_active === false) {
            return res.status(403).json({ error: 'This account has been deactivated.' });
        }
        req.user = user; // Attach the full user object to the request
        req.userId = decoded.id; // Also attach userId for convenience
        next();
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.status(401).json({ error: 'Invalid token' });
    }
};

/** Must run after `protect` — rejects any request whose authenticated user isn't flagged
 *  is_admin (set directly in the DB, not self-service). Gates /api/admin/*. */
const adminOnly = (req, res, next) => {
    if (!req.user?.is_admin) {
        return res.status(403).json({ error: 'Access denied. Admin only.' });
    }
    next();
};

module.exports = { protect, adminOnly };
