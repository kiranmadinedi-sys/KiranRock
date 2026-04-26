const schedule = require('node-schedule');
const axios = require('axios');

async function login() {
  const res = await axios.post('http://localhost:3001/api/auth/login', {
    username: 'user',
    password: 'password'
  }, { timeout: 10000 });
  return res.data.token;
}

async function prewarm(token) {
  try {
    await axios.get('http://localhost:3001/api/weekly/predictions?limit=10&universe=TOP_200', {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 120000
    });
    console.log('[PrewarmScheduler] Prewarm request completed');
  } catch (err) {
    console.log('[PrewarmScheduler] Prewarm trigger sent (may be in progress) -', err.message);
  }
}

async function scheduleJobs() {
  const token = await login();
  console.log('[PrewarmScheduler] Scheduling prewarm jobs for Monday & Wednesday 5:50 AM (America/New_York)');

  // Monday 5:50 AM ET
  schedule.scheduleJob({ rule: '50 5 * * 1', tz: 'America/New_York' }, async () => {
    console.log(new Date().toISOString(), ' - Running Monday prewarm');
    await prewarm(token);
  });

  // Wednesday 5:50 AM ET
  schedule.scheduleJob({ rule: '50 5 * * 3', tz: 'America/New_York' }, async () => {
    console.log(new Date().toISOString(), ' - Running Wednesday prewarm');
    await prewarm(token);
  });

  console.log('[PrewarmScheduler] Jobs scheduled. Process will keep running.');
}

if (require.main === module) {
  scheduleJobs().catch(err => {
    console.error('[PrewarmScheduler] Failed to start:', err.message || err);
    process.exit(1);
  });
}
