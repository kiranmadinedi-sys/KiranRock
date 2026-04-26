const { query } = require('../src/config/database');
const yfClient = require('../src/utils/yfClient');

/**
 * Update holdings prices: fetch distinct symbols, get quote once per symbol,
 * update holdings.current_price, market_value, gain_loss, gain_loss_percent, updated_at
 *
 * Usage: node backend/scripts/update-holdings-prices.js
 */

async function updatePrices() {
    try {
        const res = await query(`SELECT DISTINCT symbol FROM holdings WHERE symbol IS NOT NULL`);
        const rows = res.rows || [];
        if (rows.length === 0) {
            console.log('No holdings found to update');
            return;
        }

        const symbols = rows.map(r => r.symbol).filter(Boolean);
        console.log('Updating prices for symbols:', symbols.join(', '));

        for (const symbol of symbols) {
            try {
                const q = await yfClient.quote(symbol);
                const price = q && (q.regularMarketPrice || q.price || (q.price && q.price.regularMarketPrice)) || null;

                if (price === null) {
                    console.warn(`No price returned for ${symbol}`);
                    continue;
                }

                // Update all holdings rows for this symbol
                const upd = await query(
                    `UPDATE holdings SET current_price = $1,
                                         market_value = (current_price IS NULL OR current_price::numeric = 0) ? ($1 * quantity) : ($1 * quantity),
                                         gain_loss = ($1 * quantity) - (average_price * quantity),
                                         gain_loss_percent = CASE WHEN average_price > 0 THEN ((($1 - average_price)/average_price) * 100) ELSE 0 END,
                                         updated_at = NOW()
                     WHERE symbol = $2 RETURNING id, user_id, symbol, quantity, average_price, current_price`,
                    [price, symbol]
                );

                console.log(`Updated ${upd.rowCount} holdings for ${symbol} -> price: ${price}`);
            } catch (err) {
                console.error(`Failed to update ${symbol}:`, err && err.message ? err.message : err);
            }
        }

        console.log('Holdings price update complete');
    } catch (err) {
        console.error('Failed to update holdings prices:', err && err.message ? err.message : err);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    updatePrices().then(() => process.exit()).catch(() => process.exit(1));
}

module.exports = { updatePrices };
