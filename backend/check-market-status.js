/**
 * Check market status and AI trading scheduler status
 */

function isMarketOpen() {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();
    const minute = now.getUTCMinutes();
    
    // Weekend
    if (day === 0 || day === 6) {
        return false;
    }
    
    // Convert to ET (UTC-5)
    const etHour = (hour - 5 + 24) % 24;
    const etTime = etHour + minute / 60;
    
    // Market hours: 9:30 AM - 4:00 PM ET
    return etTime >= 9.5 && etTime < 16;
}

console.log('========================================');
console.log('MARKET & AI TRADING STATUS CHECK');
console.log('========================================\n');

const now = new Date();
console.log('Current Time (Local):', now.toLocaleString());
console.log('Current Time (UTC):', now.toUTCString());

const day = now.getUTCDay();
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
console.log('Day of Week:', dayNames[day]);

const hour = now.getUTCHours();
const minute = now.getUTCMinutes();
const etHour = (hour - 5 + 24) % 24;
const etMinute = minute;
const etTime = etHour + etMinute / 60;

console.log(`\nET Time: ${etHour}:${etMinute.toString().padStart(2, '0')}`);
console.log(`ET Time (decimal): ${etTime.toFixed(2)}`);
console.log(`Market Hours: 9:30 AM - 4:00 PM ET (9.5 - 16.0 decimal)`);

const isOpen = isMarketOpen();
console.log(`\n✓ Market is currently: ${isOpen ? '🟢 OPEN' : '🔴 CLOSED'}`);

if (!isOpen) {
    if (day === 0 || day === 6) {
        console.log('  Reason: Weekend');
    } else if (etTime < 9.5) {
        const minutesUntilOpen = Math.ceil((9.5 - etTime) * 60);
        console.log(`  Reason: Before market open (opens in ${minutesUntilOpen} minutes)`);
    } else {
        console.log('  Reason: After market close (opens tomorrow at 9:30 AM ET)');
    }
}

console.log('\n========================================');
console.log('AI TRADING SCHEDULER BEHAVIOR');
console.log('========================================');
console.log('- Enhanced AI Scheduler runs every 5 minutes');
console.log('- First run happens immediately on backend startup');
console.log('- Checks if market is open before trading');
console.log('- Only processes users with ai_trading_enabled=true');
console.log('- When market is closed: logs "Market is closed" and waits');
console.log('- When market is open: analyzes ALL stocks and executes trades');
console.log('');
console.log('IMPORTANT: AI trading ONLY happens during market hours!');
console.log('Next trading cycle will be at next market open.');
