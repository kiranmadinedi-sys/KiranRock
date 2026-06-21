require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');

const KEY = process.env.POLYGON_API_KEY;
const BASE = 'https://api.polygon.io';

async function testPolygon() {
    console.log('=== Polygon Options Diagnostic ===');
    console.log('API Key:', KEY ? `${KEY.slice(0, 6)}...${KEY.slice(-4)}` : 'MISSING');
    console.log('');

    const symbols = ['SPY', 'AAPL', 'NVDA'];

    for (const symbol of symbols) {
        try {
            console.log(`--- ${symbol} ---`);
            const url = `${BASE}/v3/snapshot/options/${symbol}`;
            const resp = await axios.get(url, {
                params: { apiKey: KEY, limit: 10 },
                timeout: 10000
            });

            const data = resp.data;
            console.log(`  Status HTTP: ${resp.status}`);
            console.log(`  Status field: ${data.status}`);
            console.log(`  Results count: ${data.results?.length ?? 'N/A'}`);
            console.log(`  Results type: ${Array.isArray(data.results) ? 'array' : typeof data.results}`);

            if (data.results && data.results.length > 0) {
                const first = data.results[0];
                console.log(`  First contract keys: ${Object.keys(first).join(', ')}`);
                console.log(`  First contract details: ${JSON.stringify(first.details || first, null, 2).slice(0, 400)}`);
            } else {
                console.log(`  Full response: ${JSON.stringify(data).slice(0, 300)}`);
            }
        } catch (err) {
            console.log(`  ERROR: HTTP ${err.response?.status} — ${err.response?.data?.message || err.message}`);
            if (err.response?.data) {
                console.log(`  Response body: ${JSON.stringify(err.response.data).slice(0, 300)}`);
            }
        }
        console.log('');
    }

    // Also test account/subscription status
    try {
        console.log('--- Checking Polygon subscription tier ---');
        const resp = await axios.get(`${BASE}/v1/meta/symbols/AAPL/company`, {
            params: { apiKey: KEY },
            timeout: 5000
        });
        console.log(`  HTTP ${resp.status} — basic data OK`);
    } catch (err) {
        console.log(`  Basic data error: HTTP ${err.response?.status} — ${err.message}`);
    }
}

testPolygon().catch(console.error);
