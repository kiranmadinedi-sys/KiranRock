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

const getAlertsByUserId = (userId) => {
    const users = readUsers();
    const user = users.find(u => u.id === userId);
    return user ? user.alerts || [] : [];
};

const addAlert = (userId, symbol, targetPrice) => {
    const users = readUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) {
        return null;
    }

    if (!users[userIndex].alerts) {
        users[userIndex].alerts = [];
    }

    const newAlert = {
        id: crypto.randomUUID(),
        symbol,
        targetPrice: parseFloat(targetPrice),
        createdAt: new Date().toISOString(),
    };

    users[userIndex].alerts.push(newAlert);
    writeUsers(users);
    return newAlert;
};

const deleteAlert = (userId, alertId) => {
    const users = readUsers();
    const userIndex = users.findIndex(u => u.id === userId);
    if (userIndex === -1) {
        return false;
    }

    const alertIndex = users[userIndex].alerts.findIndex(a => a.id === alertId);
    if (alertIndex === -1) {
        return false;
    }

    users[userIndex].alerts.splice(alertIndex, 1);
    writeUsers(users);
    return true;
};

module.exports = { getAlertsByUserId, addAlert, deleteAlert };
