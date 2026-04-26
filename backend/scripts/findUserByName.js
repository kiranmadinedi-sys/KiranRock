const { query } = require('../src/config/database');
const username = process.argv[2] || 'user';

(async () => {
  try {
    const res = await query('SELECT id, username, email FROM users WHERE username = $1', [username]);
    if (res.rowCount === 0) {
      console.log('NOT_FOUND');
    } else {
      console.log(JSON.stringify(res.rows, null, 2));
    }
  } catch (err) {
    console.error('ERROR:', err.message);
  } finally {
    process.exit();
  }
})();
