require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');
const { logger } = require('../utils/logger'); // Assuming logger is available

// PostgreSQL connection configuration — reads from .env
const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'kiranrock_trading', // Corrected back to DB_NAME
    user:     process.env.DB_USER     || 'postgres',
    password: process.env.DB_PASSWORD || 'admin',
    // Pool tuning from a day of Postgres connection logging (2026-10-07):
    // - The app opened 4,367 new connections in ~13h; 70% lived only 10-35s, because a 30s
    //   idle timeout closed them between the 5-minute scheduler ticks and every tick rebuilt
    //   them (bursts of 30-46/min). On Windows each new connection is a new postgres.exe
    //   process, and at intermittent moments the machine couldn't start them in time
    //   (06:05: 9 connections received, 0 authorized) — that was the chronic
    //   "timeout exceeded when trying to connect" errors, 40-300/day since at least 9/25.
    //   Keeping connections warm across ticks removes almost all of that churn.
    // - max 30 x ~4 node processes (backend, worker, crypto, backfill) could open 120
    //   connections against Postgres max_connections = 100; 20 keeps the total under it
    //   now that connections are held instead of churned.
    // - 10s connect timeout (was 5s) rides out a brief machine-level stall instead of failing.
    max: 20,
    idleTimeoutMillis: 10 * 60 * 1000,
    connectionTimeoutMillis: 10000,
});

// Event listeners for pool events
pool.on('error', (err, client) => {
    logger.error('Unexpected error on idle client', {
        error: err.message,
        client: client ? client.processID : 'unknown'
    });
});

// --- Connection Management ---
let isConnected = false;

async function connect() {
    if (isConnected) {
        logger.info('Database connection pool is already active.');
        return;
    }
    try {
        // Test the connection by acquiring a client
        const client = await pool.connect();
        logger.info('✓ Successfully connected to PostgreSQL database pool.');
        client.release();
        isConnected = true;
    } catch (error) {
        logger.error('Failed to connect to the database', { error: error.message });
        throw error; // Re-throw to prevent application from starting in a bad state
    }
}

async function disconnect() {
    if (!isConnected) {
        logger.info('Database connection pool is already disconnected.');
        return;
    }
    try {
        await pool.end();
        logger.info('✓ Successfully disconnected from PostgreSQL database pool.');
        isConnected = false;
    } catch (error) {
        logger.error('Failed to disconnect from the database', { error: error.message });
        throw error;
    }
}


// Helper function to execute queries
async function query(text, params) {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        // logger.debug('Executed query', { text, duration, rows: res.rowCount });
        return res;
    } catch (error) {
        logger.error('Database query error', { text, error: error.message });
        throw error;
    }
}

// Helper function for transactions
async function transaction(callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('Transaction failed, rolled back.', { error: error.message });
        throw error;
    } finally {
        client.release();
    }
}

module.exports = {
    pool,
    query,
    transaction,
    connect,
    disconnect
};
