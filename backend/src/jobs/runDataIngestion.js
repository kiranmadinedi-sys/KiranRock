require('../bootstrapRuntime'); // This is crucial for patching modules
const { ingestDataForSymbols } = require('../services/dataIngestionService');
const { getStockUniverse } = require('../services/stockUniverseService');
const { logger } = require('../utils/logger');
const { connect, disconnect } = require('../config/database');

/**
 * This script is a standalone runner for the historical data ingestion process.
 * It connects to the database, fetches the stock universe, ingests the data,
 * and then disconnects. It's designed to be run as a scheduled task or manually.
 */
async function runIngestion() {
    logger.info('--- Starting Data Ingestion Job ---');
    
    try {
        await connect();
        
        const stockUniverse = await getStockUniverse();
        if (!stockUniverse || stockUniverse.length === 0) {
            logger.warn('Stock universe is empty. No data to ingest.');
            return;
        }
        
        await ingestDataForSymbols(stockUniverse);
        
    } catch (error) {
        logger.error('A critical error occurred during the data ingestion job.', {
            error: error.message,
            stack: error.stack
        });
        process.exit(1); // Exit with error code
    } finally {
        await disconnect();
        logger.info('--- Data Ingestion Job Finished ---');
    }
}

// Execute the job
runIngestion();
