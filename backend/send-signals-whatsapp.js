/**
 * Send available trading signals to WhatsApp.
 * Uses today's scan if available, otherwise falls back to last available date.
 */
require('dotenv').config();
const { query } = require('./src/config/database');
const wa = require('./src/services/whatsappAlertService');

(async () => {
    // Get the most recent analysis date
    const dateRes = await query(
        `SELECT analysis_date, COUNT(*) AS total, SUM(CASE WHEN passed_prescreen THEN 1 ELSE 0 END) AS passed
         FROM daily_universe_analysis
         GROUP BY analysis_date
         ORDER BY analysis_date DESC
         LIMIT 1`
    );

    if (!dateRes.rows.length) {
        console.log('No signals available in database.');
        process.exit(0);
    }

    const { analysis_date, total, passed } = dateRes.rows[0];
    const dateStr = new Date(analysis_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    // Fetch top signals that passed prescreen, sorted by ai_score desc
    const res = await query(
        `SELECT symbol, ai_score, recommendation, setup_family, sector
         FROM daily_universe_analysis
         WHERE analysis_date = $1
           AND passed_prescreen = true
         ORDER BY ai_score DESC
         LIMIT 20`,
        [analysis_date]
    );

    if (!res.rows.length) {
        console.log('No passed signals for', analysis_date);
        process.exit(0);
    }

    // Build message
    const rows = res.rows;
    const lines = rows.map((r, i) => {
        const score = r.ai_score != null ? Number(r.ai_score).toFixed(0) : '—';
        const setup = r.setup_family || r.sector || '';
        return `${i + 1}. ${r.symbol.padEnd(6)} Score:${score.padStart(3)}  ${setup}`;
    });

    const msg =
        `📊 TRADING SIGNALS — ${dateStr}\n` +
        `Universe: ${total} scanned | ${passed} passed\n` +
        `─────────────────────────\n` +
        `TOP ${rows.length} OPPORTUNITIES\n\n` +
        lines.join('\n') +
        `\n─────────────────────────\n` +
        `Regime: BULL | Min Score: 65`;

    console.log('\n--- Message to be sent ---');
    console.log(msg);
    console.log('--------------------------\n');

    await wa.send(msg);
    console.log('✅ Sent to WhatsApp successfully.');
    process.exit(0);
})().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
