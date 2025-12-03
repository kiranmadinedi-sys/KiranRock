const alertService = require('../services/alertService');

const getAlerts = (req, res) => {
    const alerts = alertService.getAlertsByUserId(req.user.id);
    res.json(alerts);
};

const addAlert = (req, res) => {
    const { symbol, targetPrice } = req.body;
    if (!symbol || !targetPrice) {
        return res.status(400).json({ message: 'Symbol and target price are required' });
    }
    const newAlert = alertService.addAlert(req.user.id, symbol, targetPrice);
    res.status(201).json(newAlert);
};

const deleteAlert = (req, res) => {
    const { id } = req.params;
    const success = alertService.deleteAlert(req.user.id, id);
    if (success) {
        res.status(204).send();
    } else {
        res.status(404).json({ message: 'Alert not found or user not authorized' });
    }
};

module.exports = { getAlerts, addAlert, deleteAlert };
