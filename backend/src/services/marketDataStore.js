const fs = require('fs');
const path = require('path');

const STORAGE_DIR = path.join(__dirname, '../storage/market-cache');

function ensureStorageDir() {
    if (!fs.existsSync(STORAGE_DIR)) {
        fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }
}

function sanitizeKey(key) {
    return String(key).replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function getFilePath(key) {
    ensureStorageDir();
    return path.join(STORAGE_DIR, `${sanitizeKey(key)}.json`);
}

function readEntry(key) {
    try {
        const filePath = getFilePath(key);
        if (!fs.existsSync(filePath)) {
            return null;
        }

        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.warn(`[MarketDataStore] Failed to read ${key}:`, error.message);
        return null;
    }
}

function writeEntry(key, value) {
    try {
        const filePath = getFilePath(key);
        const payload = {
            updatedAt: new Date().toISOString(),
            value
        };

        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
        return payload;
    } catch (error) {
        console.warn(`[MarketDataStore] Failed to write ${key}:`, error.message);
        return null;
    }
}

function getValue(key, maxAgeMs = null) {
    const entry = readEntry(key);
    if (!entry) {
        return null;
    }

    if (maxAgeMs !== null) {
        const ageMs = Date.now() - new Date(entry.updatedAt).getTime();
        if (!Number.isFinite(ageMs) || ageMs > maxAgeMs) {
            return null;
        }
    }

    return entry.value;
}

function getStaleValue(key) {
    const entry = readEntry(key);
    return entry ? entry.value : null;
}

module.exports = {
    getStaleValue,
    getValue,
    writeEntry
};