require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { query, pool } = require('../src/config/database');

async function test() {
    const botUser = process.env.BOT_USERNAME;
    console.log('BOT_USERNAME:', botUser);

    const r = await query(
        'SELECT id, username, email FROM users WHERE username = $1 OR email = $1 LIMIT 1',
        [botUser]
    );
    console.log('Resolved user:', r.rows[0] || 'NOT FOUND');
    await pool.end();
}
test().catch(e => { console.error(e.message); process.exit(1); });
