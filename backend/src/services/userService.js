const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const usersFilePath = path.join(__dirname, '..', '..', 'users.json');

const readUsers = () => {
    if (!fs.existsSync(usersFilePath)) {
        fs.writeFileSync(usersFilePath, JSON.stringify([], null, 2));
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
        return [];
    }
};

const writeUsers = (users) => {
    fs.writeFileSync(usersFilePath, JSON.stringify(users, null, 2));
};

const findUserByUsername = (username) => {
    const users = readUsers();
    return users.find(u => u.username === username);
};

const findUserById = (id) => {
    const users = readUsers();
    return users.find(u => u.id === id);
};

const { v4: uuidv4 } = require('uuid');

const createUser = (username, password) => {
    const users = readUsers();
    const newUser = {
        id: uuidv4(),
        username,
        password, // In a real app, hash this!
        alerts: [],
        portfolio: [],
        phone: '', // Add phone field, empty by default
    };
    users.push(newUser);
    writeUsers(users);
    return newUser;
};

module.exports = {
    readUsers,
    writeUsers,
    findUserByUsername,
    findUserById,
    createUser,
};
