require('dotenv').config();
const svc = require('./src/services/nightlyUniverseScanService');

(async () => {
    console.log('[ManualScan] Starting nightly universe scan...');
    const r = await svc.runNightlyUniverseScan();
    console.log('[ManualScan] Done:', JSON.stringify(r));
    process.exit(0);
})();
