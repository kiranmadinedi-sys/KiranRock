require('dotenv').config();
const { query } = require('./src/config/database');
(async () => {
  const r = await query(`
    SELECT analysis_date, COUNT(*) as total,
      COUNT(*) FILTER (WHERE passed_prescreen=true) as passed,
      MAX(ai_score) as max_score,
      MIN(created_at) as started_at,
      MAX(created_at) as ended_at
    FROM daily_universe_analysis
    WHERE analysis_date >= CURRENT_DATE - INTERVAL '3 days'
    GROUP BY analysis_date ORDER BY analysis_date DESC
  `);
  if (r.rows.length === 0) {
    console.log('No nightly scan records found in last 3 days.');
  } else {
    r.rows.forEach(row => {
      console.log(`Date: ${row.analysis_date?.toISOString?.().split('T')[0] || row.analysis_date}`);
      console.log(`  Total tickers: ${row.total}, Passed prescreen: ${row.passed}, Max AI score: ${row.max_score}`);
      console.log(`  Started: ${row.started_at}, Ended: ${row.ended_at}`);
      console.log('');
    });
  }
  process.exit(0);
})();
