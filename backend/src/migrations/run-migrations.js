const fs = require('fs');
const path = require('path');
const { pool, connect, disconnect } = require('../config/database');
const { logger } = require('../utils/logger');

const MIGRATIONS_DIR = __dirname;
const MIGRATIONS_STATE_TABLE = 'schema_migrations';

async function ensureMigrationsTable() {
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS ${MIGRATIONS_STATE_TABLE} (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
            );
        `);
    } finally {
        client.release();
    }
}

async function getAppliedMigrations() {
    const client = await pool.connect();
    try {
        const result = await client.query(`SELECT name FROM ${MIGRATIONS_STATE_TABLE}`);
        return result.rows.map(row => row.name);
    } finally {
        client.release();
    }
}

async function runMigrations() {
    logger.info('Starting database migration process...');
    await connect();
    
    try {
        await ensureMigrationsTable();
        const appliedMigrations = await getAppliedMigrations();
        
        const migrationFiles = fs.readdirSync(MIGRATIONS_DIR)
            .filter(file => file.endsWith('.js') && file !== 'run-migrations.js')
            .sort();

        if (migrationFiles.length === 0) {
            logger.info('No migration files found.');
            return;
        }

        logger.info(`Found ${migrationFiles.length} migration files.`);

        for (const file of migrationFiles) {
            const migration = require(path.join(MIGRATIONS_DIR, file));
            const migrationName = migration.name || path.basename(file, '.js');

            if (appliedMigrations.includes(migrationName)) {
                logger.info(`Skipping already applied migration: ${migrationName}`);
                continue;
            }

            logger.info(`Applying migration: ${migrationName}...`);
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await migration.up(client);
                await client.query(
                    `INSERT INTO ${MIGRATIONS_STATE_TABLE} (name) VALUES ($1)`,
                    [migrationName]
                );
                await client.query('COMMIT');
                logger.info(`Successfully applied migration: ${migrationName}`);
            } catch (error) {
                await client.query('ROLLBACK');
                logger.error(`Failed to apply migration: ${migrationName}`, { error: error.message, stack: error.stack });
                throw error; // Stop the process if a migration fails
            } finally {
                client.release();
            }
        }

        logger.info('All new migrations have been applied successfully.');
    } catch (error) {
        logger.error('An error occurred during the migration process.', { error: error.message });
        // The process should exit if migrations fail.
        process.exit(1);
    } finally {
        await disconnect();
    }
}

// Run migrations if the script is executed directly
if (require.main === module) {
    runMigrations().catch(error => {
        logger.error('Migration script failed.', { error: error.message });
        process.exit(1);
    });
}

module.exports = { runMigrations };
