const newsMonitoringService = require('./src/services/newsMonitoringService');

console.log('=== Testing News Monitoring Service ===\n');

// Test symbols with likely recent news
const testSymbols = ['AAPL', 'TSLA', 'NVDA'];

async function testNewsMonitoring() {
    try {
        console.log(`Starting news monitoring for: ${testSymbols.join(', ')}\n`);
        
        // Start monitoring
        newsMonitoringService.startNewsMonitoring(testSymbols);
        
        // Wait a few seconds for the initial check to complete
        console.log('Waiting for news check to complete...\n');
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        // Get alerts
        console.log('Fetching alerts...\n');
        const alerts = await newsMonitoringService.getNewsAlerts({ limit: 10 });
        
        console.log(`Found ${alerts.length} news alerts:\n`);
        
        alerts.forEach((alert, index) => {
            console.log(`${index + 1}. [${alert.severity}] ${alert.symbol}: ${alert.title}`);
            console.log(`   Sentiment: ${alert.sentimentImpact} (${alert.sentimentScore.toFixed(2)})`);
            console.log(`   Keywords: ${alert.keywords.join(', ')}`);
            console.log(`   Created: ${alert.createdAt}`);
            console.log('');
        });
        
        // Stop monitoring
        newsMonitoringService.stopNewsMonitoring();
        
        console.log('✓ Test completed successfully!');
        process.exit(0);
        
    } catch (error) {
        console.error('✗ Test failed:', error);
        process.exit(1);
    }
}

testNewsMonitoring();
