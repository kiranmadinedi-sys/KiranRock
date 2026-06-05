#!/usr/bin/env node
/**
 * Manual Telegram Report Sender
 * Sends the weekly report immediately (on-demand)
 * Usage: node send-telegram-report-now.js [monday|wednesday]
 */

const { sendReport } = require('./src/sendWeeklyReportToTelegram');
const fs = require('fs');
const path = require('path');

const REPORT_TRACKING_FILE = path.join(__dirname, 'config/lastReportSent.json');

function updateLastReportTime(day) {
  try {
    const tracking = {
      lastMonday: null,
      lastWednesday: null
    };
    
    if (fs.existsSync(REPORT_TRACKING_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(REPORT_TRACKING_FILE, 'utf8'));
        tracking.lastMonday = data.lastMonday;
        tracking.lastWednesday = data.lastWednesday;
      } catch (e) {}
    }
    
    const now = new Date().toISOString();
    if (day === 'Monday' || day === 'monday') {
      tracking.lastMonday = now;
    } else if (day === 'Wednesday' || day === 'wednesday') {
      tracking.lastWednesday = now;
    }
    
    // Ensure config directory exists
    const configDir = path.dirname(REPORT_TRACKING_FILE);
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }
    
    fs.writeFileSync(REPORT_TRACKING_FILE, JSON.stringify(tracking, null, 2));
    console.log(`✓ Updated ${day} report send time: ${now}`);
    return true;
  } catch (error) {
    console.error('✗ Error updating tracking file:', error.message);
    return false;
  }
}

async function sendWeeklyReportNow() {
  const dayArg = process.argv[2] || 'Monday';
  const dayName = dayArg.charAt(0).toUpperCase() + dayArg.slice(1).toLowerCase();
  
  if (!['Monday', 'Wednesday'].includes(dayName)) {
    console.error('❌ Invalid day. Use: node send-telegram-report-now.js [monday|wednesday]');
    process.exit(1);
  }
  
  console.log(`\n📊 Sending ${dayName} Telegram Report...`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  
  try {
    console.log('⏳ Generating report (this may take 2-5 minutes)...\n');
    
    // Send the report
    await sendReport();
    
    console.log('\n✅ Report sent successfully!');
    
    // Update tracking file
    updateLastReportTime(dayName);
    
    console.log(`\n✓ ${dayName} report timestamp updated in tracking file`);
    
  } catch (error) {
    console.error('\n❌ Failed to send report:');
    console.error(`   Error: ${error.message}`);
    
    if (error.message.includes('No predictions')) {
      console.error('\n⚠️  No stock predictions available yet.');
      console.error('   The system may still be generating predictions.');
      console.error('   Try again in 1-2 minutes.');
    }
    
    process.exit(1);
  }
}

// Run the report sender
sendWeeklyReportNow().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
