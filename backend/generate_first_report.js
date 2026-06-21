require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const weeklyRpt = require('./src/services/weeklyTradingReportService');

const USER = 'ca632c53-8798-46f4-be94-29be0fede7f2';

async function main() {
    // Generate for last week (Jun 16-20) and current (Jun 20 — end of this week)
    const lastWeek = { weekStart: '2026-06-16', weekEnd: '2026-06-20' };
    console.log('Generating report for', lastWeek.weekStart, '–', lastWeek.weekEnd, '...');
    const r1 = await weeklyRpt.generateWeeklyReport(USER, lastWeek.weekStart, lastWeek.weekEnd);
    console.log('\n=== REPORT SUMMARY ===');
    console.log('Trades this week: ' + r1.summary.totalSells + ' sells, ' + r1.summary.totalBuys + ' buys');
    console.log('Realized P&L: $' + r1.summary.realizedPnl);
    console.log('Open positions: ' + r1.summary.openPositions);
    console.log('Cash: $' + r1.summary.cashBalance);
    console.log('Win rate: ' + r1.summary.winRate + '%');
    console.log('Market: SPY ' + r1.marketContext.spy + '%, QQQ ' + r1.marketContext.qqq + '%');
    console.log('Alpha capture: avg ' + (r1.alphaCapture.avgAlpha || 'n/a') + '% vs SPY, ' + r1.alphaCapture.beatingSpyCount + '/' + r1.alphaCapture.totalPositions + ' positions beating SPY');
    console.log('\nScore buckets:');
    r1.scoreBuckets.forEach(b => console.log('  ' + b.bucket + ': ' + b.winRate + '% WR, n=' + b.total + ', pnl=$' + b.totalPnl));
    console.log('\nInsights:');
    r1.insights.forEach(i => console.log('  • ' + i));
    console.log('\nReport saved to DB. ✓');
    process.exit(0);
}
main().catch(e => { console.error(e.message, e.stack); process.exit(1); });
