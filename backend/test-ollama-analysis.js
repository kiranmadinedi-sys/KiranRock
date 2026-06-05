require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const svc = require('./src/services/ollamaBacktestService.js');

console.log('Starting Ollama AI analysis... (may take 60-120 seconds)');
const start = Date.now();

svc.getAIBacktestAnalysis('b3eec6b6-719d-4686-92da-35c96ab61289')
  .then(report => {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`\n=== REPORT (${elapsed}s) ===\n`);
    if (!report.hasData) {
        console.log('No data:', report.message);
        process.exit(0);
    }
    console.log('STATS SUMMARY:');
    console.log('  Win rate:', report.stats.overall.winRate + '%');
    console.log('  Profit factor:', report.stats.overall.profitFactor);
    console.log('  Total P&L: $' + report.stats.overall.totalPnl);
    console.log('  SPY return:', report.stats.spyBench?.spyReturn + '%');
    console.log('\nOLLAMA ANALYSIS:');
    if (report.ollamaAnalysis?.available) {
        console.log(report.ollamaAnalysis.analysis);
    } else {
        console.log('Ollama unavailable:', report.ollamaAnalysis?.error);
    }
    process.exit(0);
  })
  .catch(e => { console.error(e.stack); process.exit(1); });
