require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { query, pool } = require('../src/config/database');

async function run() {
    console.log('\n=== Telegram Configuration Check ===\n');

    // 1. Env vars
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    console.log('TELEGRAM_BOT_TOKEN :', token  ? `SET (length=${token.length})`  : 'NOT SET ❌');
    console.log('TELEGRAM_CHAT_ID   :', chatId ? `${chatId} ✅`                  : 'NOT SET ❌');
    console.log('BOT_USERNAME       :', process.env.BOT_USERNAME || 'NOT SET ❌');

    // 2. DB telegram_chat_id for main user
    const users = await query(`
        SELECT username, email, telegram_chat_id
        FROM users
        WHERE id = '83f08677-e55a-48d1-bd31-f5b56fa79c23'
    `);
    const u = users.rows[0];
    if (u) {
        console.log('\nDB user row:');
        console.log('  username         :', u.username);
        console.log('  email            :', u.email);
        console.log('  telegram_chat_id :', u.telegram_chat_id ? `${u.telegram_chat_id} ✅` : 'NULL ❌');
    } else {
        console.log('\n❌ Main user not found in DB');
    }

    // 3. Schedule summary from health endpoint
    const axios = require('axios');
    try {
        const h = await axios.get('http://localhost:3001/health', { timeout: 5000 });
        const next = h.data.reportScheduler?.nextRuns || [];
        console.log('\nUpcoming Telegram sends:');
        next.forEach(r => console.log(`  ${r.label.padEnd(30)} → ${r.nextRunLocal}`));
    } catch (e) {
        console.log('\n⚠️  Could not reach health endpoint:', e.message);
    }

    await pool.end();
    console.log('\n✅ Telegram config check complete\n');
}

run().catch(e => { console.error('Failed:', e.message); pool.end().finally(() => process.exit(1)); });
