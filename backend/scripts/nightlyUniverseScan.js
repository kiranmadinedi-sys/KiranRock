/**
 * Standalone runner for the nightly universe scan.
 * Usage: node scripts/nightlyUniverseScan.js
 *
 * Can also be triggered via the scheduler (enhancedAIScheduler.js EOD cleanup).
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { initializeDatabase } = require('../src/config/initDatabase');
const { runNightlyUniverseScan } = require('../src/services/nightlyUniverseScanService');

(async () => {
    try {
        console.log('[NightlyScan:runner] Initializing database schema...');
        await initializeDatabase();

        console.log('[NightlyScan:runner] Starting scan...');
        const result = await runNightlyUniverseScan();

        if (result) {
            console.log('[NightlyScan:runner] Result:', JSON.stringify(result, null, 2));
        }

        process.exit(0);
    } catch (err) {
        console.error('[NightlyScan:runner] Error:', err.message);
        process.exit(1);
    }
})();
