const express = require('express');
const { getPortfolio, addHolding, deleteHolding } = require('../controllers/portfolioController');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

router.get('/', protect, getPortfolio);
router.post('/', protect, addHolding);
router.delete('/:id', protect, deleteHolding);

module.exports = router;
