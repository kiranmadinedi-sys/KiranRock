const express = require('express');
const { getAlerts, addAlert, deleteAlert } = require('../controllers/alertController');
const { protect } = require('../middleware/authMiddleware');
const router = express.Router();

router.get('/', protect, getAlerts);
router.post('/', protect, addAlert);
router.delete('/:id', protect, deleteAlert);

module.exports = router;
