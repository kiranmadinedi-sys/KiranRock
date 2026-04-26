const express = require('express');
const { login, logout, signup, verifySignup } = require('../controllers/authController');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

router.post('/login', login);
router.post('/logout', logout);
router.post('/signup', signup);
router.post('/verify-signup', verifySignup);

// Verify token endpoint
router.get('/verify', protect, (req, res) => {
    // If we reach here, token is valid (protect middleware validates it)
    res.json({ valid: true, userId: req.userId });
});

module.exports = router;
