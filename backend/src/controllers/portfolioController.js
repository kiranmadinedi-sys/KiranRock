const portfolioService = require('../services/portfolioService');

const getPortfolio = async (req, res) => {
    const portfolio = await portfolioService.getPortfolioByUserId(req.user.id);
    res.json(portfolio);
};

const addHolding = async (req, res) => {
    const { symbol, quantity, purchasePrice } = req.body;
    if (!symbol || !quantity || !purchasePrice) {
        return res.status(400).json({ message: 'Symbol, quantity, and purchase price are required' });
    }
    const newHolding = await portfolioService.addHolding(req.user.id, symbol, quantity, purchasePrice);
    res.status(201).json(newHolding);
};

const deleteHolding = async (req, res) => {
    const { id } = req.params;
    const success = await portfolioService.deleteHolding(req.user.id, id);
    if (success) {
        res.status(204).send();
    } else {
        res.status(404).json({ message: 'Holding not found or user not authorized' });
    }
};

module.exports = { getPortfolio, addHolding, deleteHolding };
