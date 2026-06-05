const { query } = require('../src/config/database');
const yfClient = require('../src/utils/yfClient');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Throttled updater: process symbols in batches with delay between batches
 * Usage:
 *   node backend/scripts/update-holdings-prices-throttled.js [delayMs] [batchSize]
 */
async function updateThrottled(delayMs = 1500, batchSize = 1) {
    try {
        const res = await query(`SELECT DISTINCT symbol FROM holdings WHERE symbol IS NOT NULL`);
        const rows = res.rows || [];
        if (rows.length === 0) {
            console.log('No holdings found to update');
            return;
        }

        const symbols = rows.map(r => r.symbol).filter(Boolean);
        console.log(`Updating prices for ${symbols.length} symbols in batches of ${batchSize} (delay ${delayMs}ms)`);

        for (let i = 0; i < symbols.length; i += batchSize) {
            const batch = symbols.slice(i, i + batchSize);
            for (const symbol of batch) {
                try {
                    const q = await yfClient.quote(symbol);
                    const price = q && (q.regularMarketPrice || q.price || (q.price && q.price.regularMarketPrice)) || null;

                    if (price === null) {
                        console.warn(`No price returned for ${symbol}`);
                        continue;
                    }

                    const upd = await query(
                        `UPDATE holdings SET current_price = $1,
                                             market_value = ($1 * quantity),
                                             gain_loss = (($1 * quantity) - (average_price * quantity)),
                                             gain_loss_percent = CASE WHEN average_price > 0 THEN ((( $1 - average_price)/average_price) * 100) ELSE 0 END,
                                             updated_at = NOW()
                         WHERE symbol = $2 RETURNING id, user_id, symbol, quantity, average_price, current_price`,
                        [price, symbol]
                    );

                    console.log(`Updated ${upd.rowCount} holdings for ${symbol} -> price: ${price}`);
                } catch (err) {
                    console.error(`Failed to update ${symbol}:`, err && err.message ? err.message : err);
                }
            }

            if (i + batchSize < symbols.length) {
                // delay before next batch
                await sleep(Number(delayMs));
            }
        }

        console.log('Throttled holdings price update complete');
    } catch (err) {
        console.error('Failed to run throttled updater:', err && err.message ? err.message : err);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    const argv = process.argv.slice(2);
    const delayMs = argv[0] ? parseInt(argv[0], 10) : 1500;
    const batchSize = argv[1] ? parseInt(argv[1], 10) : 1;
    updateThrottled(delayMs, batchSize).then(() => process.exit()).catch(() => process.exit(1));
}

module.exports = { updateThrottled };
