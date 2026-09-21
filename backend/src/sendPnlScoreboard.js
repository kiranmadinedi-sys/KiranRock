/**
 * On-demand $/day scoreboard. Usage (from backend/):
 *   node src/sendPnlScoreboard.js          -> send per-user reports + admin scoreboard now
 *   node src/sendPnlScoreboard.js --print  -> print to the console only, send nothing
 */
require('dotenv').config();
const svc = require('./services/dailyPnlTargetService');

(async () => {
    try {
        if (process.argv.includes('--print')) {
            const entries = await svc.buildAllSummaries();
            for (const e of entries) console.log(svc.formatAccountMessage(e.username, e.summary), '\n');
            console.log(svc.formatCombinedMessage(entries));
        } else {
            console.log(await svc.sendWeeklyPnlReports().then(r => `Sent: ${r.accounts} accounts, ${r.userMessages} user messages + admin scoreboard`));
        }
        process.exit(0);
    } catch (err) {
        console.error('Failed:', err.message);
        process.exit(1);
    }
})();
