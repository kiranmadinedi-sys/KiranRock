const { ingestDataForSymbols } = require('../services/dataIngestionService');
const { getStockUniverse } = require('../services/stockUniverseService');
const { logger } = require('../utils/logger');
const { sendAdminMonthlyReport } = require('../sendPerformanceReport');

/**
 * @description Triggers the historical data ingestion process.
 * This is an async, fire-and-forget endpoint. It starts the job
 * and returns a confirmation message immediately. The actual
 * ingestion happens in the background.
 * @param {object} req The Express request object.
 * @param {object} res The Express response object.
 */
async function triggerDataIngestion(req, res) {
    logger.info('API request received to trigger historical data ingestion.');
    
    // Respond to the client immediately to prevent the request from timing out.
    res.status(202).json({ 
        message: 'Historical data ingestion process has been started. This may take several minutes. See server logs for progress.' 
    });

    // Run the ingestion process in the background.
    // No 'await' here, making it fire-and-forget.
    (async () => {
        try {
            logger.info('--- Starting Data Ingestion Job (triggered by API) ---');
            const stockUniverse = await getStockUniverse();
            if (!stockUniverse || stockUniverse.length === 0) {
                logger.warn('Stock universe is empty. No data to ingest.');
                return;
            }
            await ingestDataForSymbols(stockUniverse);
            logger.info('--- Data Ingestion Job Finished (triggered by API) ---');
        } catch (error) {
            logger.error('A critical error occurred during the API-triggered data ingestion job.', {
                error: error.message,
                stack: error.stack
            });
        }
    })();
}

async function triggerMonthlyReport(req, res) {
    logger.info('[AdminReport] API request received to send all-users 30-day Telegram report.');
    res.status(202).json({ message: 'Monthly report generation started. Check Telegram for the message.' });

    (async () => {
        try {
            await sendAdminMonthlyReport();
        } catch (error) {
            logger.error('[AdminReport] Failed to send monthly report.', { error: error.message, stack: error.stack });
        }
    })();
}

module.exports = {
    triggerDataIngestion,
    triggerMonthlyReport
};
