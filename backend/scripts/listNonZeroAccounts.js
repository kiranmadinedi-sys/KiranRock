const { query } = require('../src/config/database');

(async () => {
  try {
    const res = await query("SELECT user_id, balance FROM trading_accounts WHERE balance::numeric <> 0 ORDER BY balance::numeric DESC LIMIT 20");
    console.log('NONZERO ACCOUNTS:', res.rowCount);
    console.log(res.rows);
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    process.exit();
  }
})();
