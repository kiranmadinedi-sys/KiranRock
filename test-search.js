const fetch = require('node-fetch');

async function testSearch() {
    try {
        const response = await fetch('http://localhost:3001/api/stocks/search?query=AAPL', {
            headers: {
                'Authorization': 'Bearer test'
            }
        });
        const data = await response.json();
        console.log('Search results for AAPL:', data);
    } catch (error) {
        console.error('Error:', error);
    }
}

testSearch();