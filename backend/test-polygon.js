/**
 * Quick Polygon.io API key validation script.
 * Run: node test-polygon.js
 *
 * Tests: quote, bars, symbol search, options chain
 */

require('dotenv').config();
const axios = require('axios');

const KEY  = process.env.POLYGON_API_KEY;
const BASE = 'https://api.polygon.io';

if (!KEY) {
    console.error('\n❌  POLYGON_API_KEY is not set in .env\n');
    process.exit(1);
}

console.log('\n=== Polygon.io API Key Test ===\n');
console.log(`Key: ${KEY.slice(0, 8)}${'*'.repeat(Math.max(0, KEY.length - 8))}\n`);

async function test(label, fn) {
    try {
        const result = await fn();
        console.log(`✅  ${label}`);
        console.log(`    ${result}\n`);
    } catch (err) {
        const status = err.response?.status;
        const msg    = err.response?.data?.error || err.message;
        console.log(`❌  ${label}`);
        console.log(`    ${status ? `HTTP ${status}: ` : ''}${msg}\n`);
    }
}

(async () => {
    // 1. Quote — AAPL snapshot
    await test('Quote (AAPL)', async () => {
        const r = await axios.get(`${BASE}/v2/snapshot/locale/us/markets/stocks/tickers/AAPL`, {
            params: { apiKey: KEY }
        });
        const t = r.data.ticker || {};
        const price = t.lastTrade?.p || t.day?.c || 0;
        return `AAPL last price = $${price}`;
    });

    // 2. Daily bars — MSFT last 5 days
    await test('Daily bars (MSFT, 5 days)', async () => {
        const to   = new Date().toISOString().split('T')[0];
        const from = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
        const r = await axios.get(`${BASE}/v2/aggs/ticker/MSFT/range/1/day/${from}/${to}`, {
            params: { apiKey: KEY, limit: 5, adjusted: true }
        });
        const bars = r.data.results || [];
        return `${bars.length} bars returned (latest close: $${bars.at(-1)?.c ?? 'n/a'})`;
    });

    // 3. Symbol search
    await test('Symbol search ("NVDA")', async () => {
        const r = await axios.get(`${BASE}/v3/reference/tickers`, {
            params: { search: 'NVDA', apiKey: KEY, active: true, limit: 3, market: 'stocks' }
        });
        const names = (r.data.results || []).map(t => t.ticker).join(', ');
        return `Matches: ${names || '(none)'}`;
    });

    // 4. Options chain — SPY (requires Starter plan or above)
    await test('Options chain (SPY) — requires Starter plan', async () => {
        const r = await axios.get(`${BASE}/v3/snapshot/options/SPY`, {
            params: { apiKey: KEY, limit: 5 }
        });
        const count = r.data.results?.length ?? 0;
        return `${count} contracts returned`;
    });

    console.log('─────────────────────────────────');
    console.log('If all ✅ → add to .env and optionally set DATA_PROVIDER=polygon');
    console.log('If options ❌ with 403 → free tier; upgrade to Starter for options data');
    console.log('');
})();
