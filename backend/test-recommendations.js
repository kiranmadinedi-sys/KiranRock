/**
 * Test Recommendations API
 */

const https = require('https');
const http = require('http');

function makeRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        
        const reqOptions = {
            hostname: urlObj.hostname,
            port: urlObj.port,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: options.headers || {}
        };
        
        const req = protocol.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                resolve({
                    ok: res.statusCode >= 200 && res.statusCode < 300,
                    status: res.statusCode,
                    json: () => JSON.parse(data),
                    text: () => data
                });
            });
        });
        
        req.on('error', reject);
        
        if (options.body) {
            req.write(options.body);
        }
        
        req.end();
    });
}

async function testRecommendations() {
    try {
        // First login to get token
        console.log('1. Logging in...');
        const loginResponse = await makeRequest('http://localhost:3001/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: 'kiran',
                password: 'kiran123'
            })
        });
        
        if (!loginResponse.ok) {
            console.error('❌ Login failed:', loginResponse.status);
            return;
        }
        
        const loginData = await loginResponse.json();
        const token = loginData.token;
        console.log('✅ Login successful');
        
        // Test Quick Recommendations (fastest)
        console.log('\n2. Testing Quick Recommendations (50 stocks)...');
        const quickStart = Date.now();
        const quickResponse = await makeRequest(
            'http://localhost:3001/api/recommendations/quick?riskTolerance=moderate',
            {
                headers: { 'Authorization': `Bearer ${token}` }
            }
        );
        
        if (!quickResponse.ok) {
            console.error('❌ Quick recommendations failed:', quickResponse.status);
            const error = await quickResponse.text();
            console.error('Error:', error);
            return;
        }
        
        const quickData = await quickResponse.json();
        const quickTime = Date.now() - quickStart;
        
        console.log(`✅ Quick recommendations completed in ${(quickTime / 1000).toFixed(1)}s`);
        console.log(`   - New opportunities: ${quickData.recommendations.length}`);
        console.log(`   - Portfolio value: $${quickData.riskProfile?.currentExposure || 'N/A'}`);
        console.log(`   - Risk profile: ${quickData.riskProfile?.tolerance || 'N/A'}`);
        
        if (quickData.recommendations.length > 0) {
            console.log('\n   Top 3 Recommendations:');
            quickData.recommendations.slice(0, 3).forEach((rec, i) => {
                console.log(`   ${i + 1}. ${rec.symbol} - ${rec.category}`);
                console.log(`      Score: ${rec.totalScore}, Risk: ${rec.riskAnalysis?.riskScore || 'N/A'}`);
                console.log(`      ${rec.prediction.signal} - ${rec.reason}`);
            });
        }
        
        console.log('\n✅ All tests passed!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        console.error(error.stack);
    }
}

// Run tests
console.log('🧪 Testing Recommendations API...\n');
testRecommendations();
