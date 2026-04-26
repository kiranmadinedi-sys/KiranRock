/**
 * Test Enhanced Telegram Weekly Report
 * This script tests the new enhanced weekly report format
 */

const { sendReport } = require('./src/sendWeeklyReportToTelegram');

console.log('🧪 Testing Enhanced Telegram Weekly Report...\n');
console.log('This test will:');
console.log('  1. Fetch weekly predictions with enhanced data');
console.log('  2. Include risk analysis for each stock');
console.log('  3. Show invalidation triggers');
console.log('  4. Display market regime and sector rotation');
console.log('  5. Include performance tracking stats');
console.log('  6. Send formatted report to Telegram\n');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

async function testReport() {
    try {
        console.log('⏳ Generating enhanced weekly report...\n');
        const startTime = Date.now();
        
        await sendReport();
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ Report sent successfully in ${elapsed}s!`);
        console.log('\nEnhanced Features Included:');
        console.log('  ✓ Market regime detection (Trending/Range-Bound/Volatile/Rotation)');
        console.log('  ✓ Macro trends (Growth vs Value, Risk Appetite, Volatility)');
        console.log('  ✓ Sector rotation analysis (Hot/Cold sectors)');
        console.log('  ✓ Performance tracking (Last 4 weeks hit rate)');
        console.log('  ✓ Risk analysis per stock (Score 0-100, Risk factors)');
        console.log('  ✓ Invalidation triggers (Technical/Fundamental exits)');
        console.log('  ✓ Enhanced signals (Strong Buy/Buy/Hold/Avoid)');
        console.log('  ✓ Trade type classification (Momentum/Value/Growth/Breakout)');
        console.log('  ✓ Reward/Risk ratios');
        console.log('  ✓ Component score breakdown (Technical/Fundamental/AI)');
        console.log('  ✓ Risk distribution (Low/Medium/High)');
        console.log('  ✓ Signal distribution by type');
        console.log('  ✓ Sector diversification percentages');
        console.log('\n📱 Check your Telegram for the enhanced report!');
        
    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        console.error('\nError details:', error);
        process.exit(1);
    }
}

// Run test
testReport();
