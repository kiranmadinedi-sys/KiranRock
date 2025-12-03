const jwt = require('jsonwebtoken');
const { findUserByUsername, createUser } = require('../services/userService');

const login = (req, res) => {
    console.log('Login attempt:', req.body);
    const { username, password } = req.body;
    let user = findUserByUsername(username);

    // If user does not exist, create a new one
    if (!user) {
        console.log(`User "${username}" not found. Creating new user.`);
        user = createUser(username, password);
    }

    if (user && user.password === password) {
        // Sign a token with user id
        const token = jwt.sign({ id: user.id }, 'your_jwt_secret', { expiresIn: '1h' });
        console.log('Login successful for user:', username);
        res.json({ token });
    } else {
        console.log('Invalid credentials for user:', username);
        res.status(401).send('Invalid credentials');
    }
};

const logout = (req, res) => {
    // In a real app, you might want to manage token blacklisting
    res.send('Logged out successfully');
};

module.exports = { login, logout };
