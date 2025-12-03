async function testScalpingAPI() {
    try {
        console.log('Testing scalping watchlist API...');
        const response = await fetch('http://localhost:3001/api/scalping/watchlist/recommended', {
            headers: {
                'Authorization': 'Bearer test'
            }
        });

        if (response.ok) {
            const data = await response.json();
            console.log('✅ Scalping watchlist API working:', data);
        } else {
            console.log('❌ Scalping watchlist API failed:', response.status);
        }

        console.log('\nTesting scalping scan for AAPL...');
        const scanResponse = await fetch('http://localhost:3001/api/scalping/AAPL', {
            headers: {
                'Authorization': 'Bearer test'
            }
        });

        if (scanResponse.ok) {
            const scanData = await scanResponse.json();
            console.log('✅ Scalping scan API working:', scanData);
        } else {
            console.log('❌ Scalping scan API failed:', scanResponse.status);
        }

    } catch (error) {
        console.error('❌ Error testing scalping API:', error.message);
    }
}

testScalpingAPI();