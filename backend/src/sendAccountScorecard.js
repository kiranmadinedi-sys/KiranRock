/**
 * On-demand account scorecard. Usage (from backend/):
 *   node src/sendAccountScorecard.js          -> print to console
 */
require('dotenv').config();
const svc = require('./services/accountScorecardService');

(async () => {
    try {
        const result = await svc.getAccountScorecard();
        console.log(svc.formatScorecard(result));
        process.exit(0);
    } catch (err) {
        console.error('Failed:', err.message);
        process.exit(1);
    }
})();
