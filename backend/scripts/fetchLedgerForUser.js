const ledgerService = require('../src/services/ledgerService');

const userId = process.argv[2] || '83f08677-e55a-48d1-bd31-f5b56fa79c23';

(async () => {
  try {
    const summary = await ledgerService.getLedgerSummary(userId);
    console.log('LEDGER SUMMARY:');
    console.log(JSON.stringify(summary, null, 2));

    const trades = await ledgerService.getLedgerTrades(userId, 200);
    console.log('\nRECENT TRADES (count=' + trades.length + '):');
    console.log(JSON.stringify(trades, null, 2));
  } catch (err) {
    console.error('ERROR calling ledgerService:', err.message || err);
  } finally {
    process.exit();
  }
})();
