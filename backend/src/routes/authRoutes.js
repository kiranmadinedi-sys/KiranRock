const express = require('express');
const { login, logout, signup, verifySignup } = require('../controllers/authController');
const router = express.Router();

router.post('/login', login);
router.post('/logout', logout);
router.post('/signup', signup);
router.post('/verify-signup', verifySignup);

module.exports = router;
