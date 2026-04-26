/**
 * Test script to verify catch-up report logic
 * This simulates various restart scenarios
 */

const fs = require('fs');
const path = require('path');

const REPORT_TRACKING_FILE = path.join(__dirname, 'config/lastReportSent.json');

// Test functions (copied from scheduleTelegramReport.js for testing)
function getLastReportTimes() {
  try {
    if (fs.existsSync(REPORT_TRACKING_FILE)) {
      const data = fs.readFileSync(REPORT_TRACKING_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.log('[Test] Error reading tracking file:', error.message);
  }
  return { lastMonday: null, lastWednesday: null };
}

function shouldSendCatchupReport() {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const hour = now.getHours();
  
  if (dayOfWeek !== 1 && dayOfWeek !== 3) {
    return null;
  }
  
  if (hour < 6 || hour >= 23) {
    return null;
  }
  
  const tracking = getLastReportTimes();
  const dayName = dayOfWeek === 1 ? 'Monday' : 'Wednesday';
  const lastSent = dayOfWeek === 1 ? tracking.lastMonday : tracking.lastWednesday;
  
  if (lastSent) {
    const lastSentDate = new Date(lastSent);
    const isSameDay = lastSentDate.getFullYear() === now.getFullYear() &&
                     lastSentDate.getMonth() === now.getMonth() &&
                     lastSentDate.getDate() === now.getDate();
    
    if (isSameDay) {
      console.log(`[Test] ${dayName} report already sent today at ${lastSentDate.toLocaleTimeString()}`);
      return null;
    }
  }
  
  console.log(`[Test] ${dayName} report not sent yet today (should send catch-up)`);
  return dayName;
}

function updateLastReportTime(day, customDate = null) {
  try {
    const tracking = getLastReportTimes();
    const timestamp = customDate ? customDate.toISOString() : new Date().toISOString();
    
    if (day === 'Monday') {
      tracking.lastMonday = timestamp;
    } else if (day === 'Wednesday') {
      tracking.lastWednesday = timestamp;
    }
    
    const configDir = path.dirname(REPORT_TRACKING_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(REPORT_TRACKING_FILE, JSON.stringify(tracking, null, 2));
    console.log(`[Test] Updated ${day} report time: ${timestamp}`);
  } catch (error) {
    console.error('[Test] Error updating tracking file:', error.message);
  }
}

// Test scenarios
console.log('='.repeat(60));
console.log('Testing Catch-up Report Logic');
console.log('='.repeat(60));
console.log('');

const now = new Date();
const dayOfWeek = now.getDay();
const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const currentDay = dayNames[dayOfWeek];
const hour = now.getHours();

console.log(`Current Time: ${now.toLocaleString()}`);
console.log(`Day of Week: ${currentDay} (${dayOfWeek})`);
console.log(`Hour: ${hour}`);
console.log('');

// Scenario 1: Check current state
console.log('--- Scenario 1: Current State ---');
const tracking = getLastReportTimes();
console.log('Last report times:', JSON.stringify(tracking, null, 2));
console.log('');

// Scenario 2: Check if catch-up needed now
console.log('--- Scenario 2: Check Catch-up Need (Current Time) ---');
const needsCatchup = shouldSendCatchupReport();
if (needsCatchup) {
  console.log(`✓ Catch-up needed: ${needsCatchup} report should be sent`);
} else {
  if (dayOfWeek !== 1 && dayOfWeek !== 3) {
    console.log(`✗ No catch-up needed: Today is ${currentDay} (not Monday/Wednesday)`);
  } else if (hour < 6) {
    console.log(`✗ No catch-up needed: Time is before 6:00 AM`);
  } else if (hour >= 23) {
    console.log(`✗ No catch-up needed: Time is after 11:00 PM`);
  } else {
    console.log('✗ No catch-up needed: Report already sent today');
  }
}
console.log('');

// Scenario 3: Simulate sending a report now
console.log('--- Scenario 3: Simulate Sending Report ---');
if (dayOfWeek === 1) {
  console.log('Simulating Monday report send...');
  updateLastReportTime('Monday');
} else if (dayOfWeek === 3) {
  console.log('Simulating Wednesday report send...');
  updateLastReportTime('Wednesday');
} else {
  console.log(`Cannot simulate report for ${currentDay} (only Monday/Wednesday)`);
}
console.log('');

// Scenario 4: Check catch-up after simulated send
console.log('--- Scenario 4: Check Catch-up After Send ---');
const needsCatchupAfter = shouldSendCatchupReport();
if (needsCatchupAfter) {
  console.log(`✓ Catch-up still needed: ${needsCatchupAfter}`);
} else {
  console.log('✗ No catch-up needed (report marked as sent)');
}
console.log('');

// Scenario 5: Simulate old report (test catch-up detection)
console.log('--- Scenario 5: Simulate Old Report (Yesterday) ---');
if (dayOfWeek === 1 || dayOfWeek === 3) {
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 7); // 1 week ago
  
  const testDay = dayOfWeek === 1 ? 'Monday' : 'Wednesday';
  console.log(`Setting ${testDay} report to last week: ${yesterday.toLocaleString()}`);
  updateLastReportTime(testDay, yesterday);
  
  console.log('Checking if catch-up needed...');
  const needsCatchupOld = shouldSendCatchupReport();
  if (needsCatchupOld) {
    console.log(`✓ Catch-up detected: ${needsCatchupOld} report is old`);
  } else {
    console.log('✗ Error: Should have detected old report');
  }
} else {
  console.log(`Skipped: Today is ${currentDay}, not Monday/Wednesday`);
}
console.log('');

// Final state
console.log('--- Final State ---');
const finalTracking = getLastReportTimes();
console.log('Last report times:', JSON.stringify(finalTracking, null, 2));
console.log('');

console.log('='.repeat(60));
console.log('Test Complete');
console.log('='.repeat(60));
console.log('');
console.log('Next Steps:');
console.log('1. Restart the backend on Monday or Wednesday after 6:00 AM');
console.log('2. Check logs for catch-up report behavior');
console.log('3. Verify tracking file updates: backend/config/lastReportSent.json');
console.log('');
