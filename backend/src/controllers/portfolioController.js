const portfolioService = require('../services/portfolioService');

const getPortfolio = (req, res) => {
    const portfolio = portfolioService.getPortfolioByUserId(req.user.id);
    res.json(portfolio);
};

const addHolding = (req, res) => {
    const { symbol, quantity, purchasePrice } = req.body;
    if (!symbol || !quantity || !purchasePrice) {
        return res.status(400).json({ message: 'Symbol, quantity, and purchase price are required' });
    }
    const newHolding = portfolioService.addHolding(req.user.id, symbol, quantity, purchasePrice);
    res.status(201).json(newHolding);
};

const deleteHolding = (req, res) => {
    const { id } = req.params;
    const success = portfolioService.deleteHolding(req.user.id, id);
    if (success) {
        res.status(204).send();
    } else {
        res.status(404).json({ message: 'Holding not found or user not authorized' });
    }
};

module.exports = { getPortfolio, addHolding, deleteHolding };
