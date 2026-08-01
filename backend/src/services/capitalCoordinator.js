/**
 * Blitz — Cross-Strategy Capital Coordinator
 *
 * There is exactly one real Alpaca account per user (confirmed: brokerService's
 * client is constructed once per user from one set of credentials — no broker-
 * side sub-accounts). Swing (ARROW) and Blitz (intraday) both draw from that
 * same real cash pool, so each side needs visibility into what the OTHER has
 * already committed, without either owning the other's data.
 *
 * Uses quantity * average_price (actual dollars spent), not a stored
 * market_value column, since that column isn't guaranteed fresh between
 * price-update cycles — cost basis is the conservative, defensible number
 * for "how much of the real cash pool is already spoken for."
 */

const { query } = require('../config/database');

async function getSwingCommittedCapital(userId) {
    const result = await query(
        'SELECT COALESCE(SUM(quantity * average_price), 0) AS total FROM holdings WHERE user_id = $1',
        [userId]
    );
    return parseFloat(result.rows[0].total) || 0;
}

async function getIntradayCommittedCapital(userId) {
    const result = await query(
        'SELECT COALESCE(SUM(quantity * average_price), 0) AS total FROM intraday_positions WHERE user_id = $1',
        [userId]
    );
    return parseFloat(result.rows[0].total) || 0;
}

module.exports = { getSwingCommittedCapital, getIntradayCommittedCapital };
