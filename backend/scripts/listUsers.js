const { query } = require('../src/config/database');

(async () => {
  try {
    const res = await query('SELECT id, username, email FROM users LIMIT 5');
    console.log('USERS:', res.rows);
  } catch (err) {
    console.error('ERROR QUERYING USERS:', err.message);
  } finally {
    process.exit();
  }
})();