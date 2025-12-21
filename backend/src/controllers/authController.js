const jwt = require('jsonwebtoken');
const { findUserByUsername, createUser, findUserByEmail } = require('../services/userService');
const { sendOTP, verifyOTP } = require('../services/otpService');

// Temporary storage for pending signups (use database in production)
const pendingSignups = new Map();

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
        
        // Return token and user details
        res.json({ 
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email || '',
                firstName: user.firstName || '',
                lastName: user.lastName || '',
                phone: user.phone || ''
            }
        });
    } else {
        console.log('Invalid credentials for user:', username);
        res.status(401).send('Invalid credentials');
    }
};

const logout = (req, res) => {
    // In a real app, you might want to manage token blacklisting
    res.send('Logged out successfully');
};

/**
 * Signup - Send OTP to email
 */
const signup = async (req, res) => {
    try {
        const { username, email, password, firstName, lastName, phone } = req.body;

        // Validate required fields
        if (!username || !email || !password) {
            return res.status(400).json({ error: 'Username, email, and password are required' });
        }

        // Check if username already exists
        const existingUser = findUserByUsername(username);
        if (existingUser) {
            return res.status(400).json({ error: 'Username already exists' });
        }

        // Check if email already exists
        const existingEmail = findUserByEmail(email);
        if (existingEmail) {
            return res.status(400).json({ error: 'Email already registered' });
        }

        // Store signup data temporarily
        pendingSignups.set(email, {
            username,
            email,
            password,
            firstName: firstName || '',
            lastName: lastName || '',
            phone: phone || '',
            createdAt: Date.now()
        });

        // Send OTP
        await sendOTP(email, username);

        console.log(`[Signup] OTP sent to ${email} for user ${username}`);
        res.json({ 
            message: 'Verification code sent to your email',
            email: email
        });
    } catch (error) {
        console.error('[Signup] Error:', error);
        res.status(500).json({ error: error.message || 'Failed to send verification code' });
    }
};

/**
 * Verify Signup - Verify OTP and create user
 */
const verifySignup = async (req, res) => {
    try {
        const { email, otp } = req.body;

        if (!email || !otp) {
            return res.status(400).json({ error: 'Email and OTP are required' });
        }

        // Verify OTP
        const isValid = verifyOTP(email, otp);
        if (!isValid) {
            return res.status(400).json({ error: 'Invalid or expired verification code' });
        }

        // Get pending signup data
        const signupData = pendingSignups.get(email);
        if (!signupData) {
            return res.status(400).json({ error: 'Signup session expired. Please start again.' });
        }

        // Create user
        const user = createUser(
            signupData.username,
            signupData.password,
            {
                email: signupData.email,
                firstName: signupData.firstName,
                lastName: signupData.lastName,
                phone: signupData.phone
            }
        );

        // Clear pending signup
        pendingSignups.delete(email);

        // Generate token
        const token = jwt.sign({ id: user.id }, 'your_jwt_secret', { expiresIn: '1h' });

        console.log(`[Signup] User created successfully: ${signupData.username}`);
        res.json({ 
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                firstName: user.firstName,
                lastName: user.lastName,
                phone: user.phone
            },
            message: 'Account created successfully'
        });
    } catch (error) {
        console.error('[Verify Signup] Error:', error);
        res.status(500).json({ error: 'Failed to verify and create account' });
    }
};

// Clean up old pending signups periodically (30 minutes)
setInterval(() => {
    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;
    for (const [email, data] of pendingSignups.entries()) {
        if (now - data.createdAt > thirtyMinutes) {
            pendingSignups.delete(email);
            console.log(`[Signup] Cleaned up expired signup for ${email}`);
        }
    }
}, 10 * 60 * 1000); // Every 10 minutes

module.exports = { login, logout, signup, verifySignup };
