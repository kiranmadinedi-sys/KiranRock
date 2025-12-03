const jwt = require('jsonwebtoken');
const { findUserById } = require('../services/userService');

const protect = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).send('Access denied. No token provided.');
    }
    try {
        const decoded = jwt.verify(token, 'your_jwt_secret');
        const user = findUserById(decoded.id);
        if (!user) {
            return res.status(401).send('Access denied. User not found.');
        }
        req.user = user; // Attach the full user object to the request
        req.userId = decoded.id; // Also attach userId for convenience
        next();
    } catch (error) {
        res.status(401).send('Invalid token');
    }
};

module.exports = { protect };
