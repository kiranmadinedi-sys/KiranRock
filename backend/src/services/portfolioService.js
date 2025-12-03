const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const usersFilePath = path.join(__dirname, '..', '..', 'users.json');

const readUsers = () => {
    if (!fs.existsSync(usersFilePath)) {
        return [];
    }
    const data = fs.readFileSync(usersFilePath, 'utf8');
    if (!data) {
        return [];
    }
    try {
        return JSON.parse(data);
    } catch (error) {
        console.error('Error parsing users.json:', error);
        return []; // Return empty array on parsing error
    }
};

const writeUsers = (users) => {
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
};

const getPortfolioByUserId = (userId) => {
    const users = readUsers();
    const user = users.find(u => u.id === userId);
    return user ? user.portfolio || [] : [];
};

const addHolding = (userId, symbol, quantity, purchasePrice) => {
    const users = readUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) {
        return null;
    }

    if (!users[userIndex].portfolio) {
        users[userIndex].portfolio = [];
    }

    const newHolding = {
        id: crypto.randomUUID(),
        symbol,
        quantity: parseInt(quantity),
        purchasePrice: parseFloat(purchasePrice),
        addedAt: new Date().toISOString(),
    };

    users[userIndex].portfolio.push(newHolding);
    writeUsers(users);
    return newHolding;
};

const deleteHolding = (userId, holdingId) => {
    const users = readUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) {
        return false;
    }

    const holdingIndex = users[userIndex].portfolio.findIndex(h => h.id === holdingId);
    if (holdingIndex === -1) {
        return false;
    }

    users[userIndex].portfolio.splice(holdingIndex, 1);
    writeUsers(users);
    return true;
};

module.exports = { getPortfolioByUserId, addHolding, deleteHolding };
