require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const svc = require('./src/services/ollamaBacktestService.js');

svc.buildTradeStats('b3eec6b6-719d-4686-92da-35c96ab61289')
  .then(s => {
    console.log('Overall:', JSON.stringify(s.overall, null, 2));
    console.log('Setups:', JSON.stringify(s.bySetup, null, 2));
    console.log('Regimes:', JSON.stringify(s.byRegime, null, 2));
    console.log('Sectors:', JSON.stringify(s.bySector.slice(0,5), null, 2));
    console.log('Score bands:', JSON.stringify(s.byScoreBand, null, 2));
    console.log('Hold days:', JSON.stringify(s.byHoldDays, null, 2));
    console.log('SPY bench:', JSON.stringify(s.spyBench));
    console.log('Stops:', JSON.stringify(s.stopAnalysis));
    console.log('Candidates:', s.totalCandidates, 'avg score:', s.candidateAvgScore?.toFixed(1));
    process.exit(0);
  })
  .catch(e => { console.error(e.stack); process.exit(1); });
