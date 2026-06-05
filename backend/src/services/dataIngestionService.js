const yahooFinance = require('yahoo-finance2').default;
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

/**
 * Fetches historical daily data for a given stock symbol.
 * @param {string} symbol The stock symbol to fetch data for.
 * @param {string} startDate The start date in 'YYYY-MM-DD' format.
 * @returns {Promise<Array>} A promise that resolves to an array of historical data points.
 */
async function fetchHistoricalData(symbol, startDate = '2020-01-01') {
    try {
        const results = await yahooFinance.historical(symbol, {
            period1: startDate,
            interval: '1d'
        });
        return results;
    } catch (error) {
        logger.warn(`Failed to fetch historical data for ${symbol}`, { error: error.message });
        return []; // Return empty array on failure to not stop the whole process
    }
}

/**
 * Inserts historical bar data into the daily_bars table.
 * Uses INSERT ... ON CONFLICT to prevent duplicates.
 * @param {Array} bars The historical data bars to insert.
 * @returns {Promise<number>} The number of rows inserted.
 */
async function insertHistoricalBars(bars) {
    if (bars.length === 0) {
        return 0;
    }

    const insertQuery = `
        INSERT INTO daily_bars (symbol, timestamp, open, high, low, close, volume)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (symbol, timestamp) DO NOTHING;
    `;

    let insertedCount = 0;
    // Using a loop for resilience, as a single large bulk insert can fail entirely.
    // For higher performance, a bulk insert strategy could be used.
    for (const bar of bars) {
        if (!bar.date || !bar.symbol || bar.volume === null) {
            logger.warn('Skipping invalid bar data', { bar });
            continue;
        }
        try {
            const result = await query(insertQuery, [
                bar.symbol,
                bar.date,
                bar.open,
                bar.high,
                bar.low,
                bar.close,
                bar.volume
            ]);
            if (result.rowCount > 0) {
                insertedCount++;
            }
        } catch (error) {
            logger.error('Error inserting single historical bar', { symbol: bar.symbol, date: bar.date, error: error.message });
        }
    }
    return insertedCount;
}

/**
 * Main function to orchestrate fetching and ingesting data for a list of symbols.
 * @param {Array<string>} symbols The list of stock symbols to process.
 */
async function ingestDataForSymbols(symbols) {
    logger.info(`Starting historical data ingestion for ${symbols.length} symbols.`);
    
    for (const symbol of symbols) {
        logger.info(`Processing symbol: ${symbol}`);
        
        // Fetch the latest timestamp we have for this symbol
        const latestRecord = await query('SELECT MAX(timestamp) as last_date FROM daily_bars WHERE symbol = $1', [symbol]);
        const lastDate = latestRecord.rows[0]?.last_date;
        
        // Start fetching from the day after the last record, or from a default start date
        let startDate = '2020-01-01';
        if (lastDate) {
            const nextDay = new Date(lastDate);
            nextDay.setDate(nextDay.getDate() + 1);
            startDate = nextDay.toISOString().split('T')[0];
        }

        logger.info(`Fetching data for ${symbol} from ${startDate}`);
        const historicalData = await fetchHistoricalData(symbol, startDate);
        
        if (historicalData.length > 0) {
            // Add symbol to each bar for insertion
            const barsWithSymbol = historicalData.map(bar => ({ ...bar, symbol }));
            const insertedCount = await insertHistoricalBars(barsWithSymbol);
            logger.info(`Inserted ${insertedCount} new daily bars for ${symbol}.`);
        } else {
            logger.info(`No new historical data found for ${symbol}.`);
        }
    }

    logger.info('Completed historical data ingestion cycle.');
}

module.exports = {
    ingestDataForSymbols,
    fetchHistoricalData,
    insertHistoricalBars
};
