// Network Configuration Test Script
const http = require('http');
const https = require('https');

function testEndpoint(url, description) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 5000 }, (res) => {
      console.log(`✅ ${description}: ${res.statusCode}`);
      resolve(true);
    });

    req.on('error', (err) => {
      console.log(`❌ ${description}: ${err.message}`);
      resolve(false);
    });

    req.on('timeout', () => {
      console.log(`❌ ${description}: Timeout`);
      req.destroy();
      resolve(false);
    });
  });
}

async function runTests() {
  console.log('=== Stock Analysis App - Network Tests ===\n');

  // Test local endpoints
  console.log('Local Tests:');
  console.log('============');
  await testEndpoint('http://localhost:3001/api/auth/login', 'Backend API (local)');
  await testEndpoint('http://localhost:3000', 'Frontend (local)');

  // Get external IP
  const externalIP = await new Promise((resolve) => {
    https.get('https://api.ipify.org', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', () => resolve(null));
  });

  if (externalIP) {
    console.log(`\nExternal IP: ${externalIP}`);

    console.log('\nExternal Tests:');
    console.log('===============');
    await testEndpoint(`http://${externalIP}:3001/api/auth/login`, 'Backend API (external)');
    await testEndpoint(`http://${externalIP}:3000`, 'Frontend (external)');
  }

  console.log('\nConfiguration:');
  console.log('==============');
  console.log('1. Backend should bind to 0.0.0.0');
  console.log('2. Ports 3000, 3001 should be forwarded');
  console.log('3. Firewall should allow these ports');
  console.log('4. Set NEXT_PUBLIC_API_BASE_URL for frontend');
}

// Run tests if called directly
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testEndpoint, runTests };