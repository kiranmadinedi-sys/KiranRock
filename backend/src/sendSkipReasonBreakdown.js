/**
 * On-demand "why did we miss N candidates" report. Usage (from backend/):
 *   node src/sendSkipReasonBreakdown.js            -> today's breakdown
 *   node src/sendSkipReasonBreakdown.js 2026-09-25 -> a specific date
 */
require('dotenv').config();
const svc = require('./services/nightlyUniverseScanService');

(async () => {
    try {
        const date = process.argv[2] || undefined;
        const result = await svc.getSkipReasonBreakdown(date);
        console.log(svc.formatSkipReasonBreakdown(result));
        process.exit(0);
    } catch (err) {
        console.error('Failed:', err.message);
        process.exit(1);
    }
})();
