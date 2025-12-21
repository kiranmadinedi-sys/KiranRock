# Weekly Report Telegram Batch Job

## Overview
Automated batch process that sends weekly stock analysis reports to Telegram twice daily.

## Schedule
- **Morning Report**: 7:00 AM CST
- **Afternoon Report**: 2:45 PM CST

## Features
- ✅ Automatic twice-daily execution
- ✅ Fetches top 10 weekly stock predictions
- ✅ Formats report with Markdown for better readability
- ✅ Sends to all users with Telegram configured
- ✅ Includes live link to full report
- ✅ Timezone-aware (CST/CDT)

## Report Content
Each report includes:
- 📊 Symbol and tier classification
- 📈 Signal (BUY/SELL/HOLD)
- 💯 Confidence percentage
- 💰 Current price
- 🎯 Target price
- 📊 Expected move percentage
- 📉 Volatility score
- 🔢 Total score

## Configuration

### Environment Variables
Make sure you have set:
```bash
TELEGRAM_BOT_TOKEN=your_bot_token_here
```

### Users Configuration
Users must have phone numbers configured in `backend/users.json`:
```json
[
  {
    "id": 1,
    "username": "user",
    "password": "hashed_password",
    "phone": "6504830983"
  }
]
```

### Telegram Chat ID Mapping
Update `backend/src/services/telegramService.js` to map phone numbers to chat IDs:
```javascript
async function getChatIdByPhone(phone) {
    const demoPhone = '6504830983';
    const supergroupChatId = '-1003406286106';
    if (phone === demoPhone) return supergroupChatId;
    return null;
}
```

## Testing

### Manual Test
Run the test script to send a report immediately:
```bash
cd backend
node src/testWeeklyReportBatch.js
```

### Check Logs
The scheduler logs all activities:
```
[Weekly Report Batch] ✓ Scheduler started
[Weekly Report Batch] Morning report: 7:00 AM CST
[Weekly Report Batch] Afternoon report: 2:45 PM CST
[Weekly Report Batch] 🌅 Morning report triggered (7:00 AM CST)
[Weekly Report Batch] Starting report generation...
[Weekly Report Batch] Sending to 1 user(s)...
[Weekly Report Batch] ✓ Sent to user (6504830983)
[Weekly Report Batch] Report batch completed
```

## Integration

The scheduler is automatically started when the backend server starts:

**File**: `backend/src/app.js`
```javascript
const { startWeeklyReportScheduler } = require('./scheduleWeeklyReportBatch');

app.listen(PORT, HOST, () => {
  // ... other initializations
  startWeeklyReportScheduler();
});
```

## API Endpoint Used
The batch job calls:
```
GET http://localhost:3001/api/weekly/predictions?limit=10
```

## Troubleshooting

### Reports not sending?
1. Check Telegram bot token is valid
2. Verify phone-to-chatId mapping in telegramService.js
3. Ensure users.json has phone numbers
4. Check backend logs for errors

### Wrong timezone?
The scheduler uses `America/Chicago` timezone. Server will auto-adjust for CDT/CST.

### Want to change schedule?
Edit `backend/src/scheduleWeeklyReportBatch.js`:
```javascript
// Cron format: minute hour * * *
const morningSchedule = cron.schedule('0 7 * * *', ...);   // 7:00 AM
const afternoonSchedule = cron.schedule('45 14 * * *', ...); // 2:45 PM
```

## Dependencies
- `node-cron`: ^4.2.1 - Job scheduling
- `node-telegram-bot-api`: ^0.66.0 - Telegram integration
- `axios`: ^1.13.1 - HTTP requests

## Files Created/Modified

### New Files
- `backend/src/scheduleWeeklyReportBatch.js` - Main scheduler implementation
- `backend/src/testWeeklyReportBatch.js` - Manual test script

### Modified Files
- `backend/src/app.js` - Added scheduler initialization
- `backend/src/services/telegramService.js` - Added Markdown support

## Report Format Example
```
📊 *Weekly Stock Analysis Report*
🕒 Friday, December 13, 2025 at 7:00 AM

━━━━━━━━━━━━━━━━━━━━

*1. AAPL* (A)
   📈 Signal: *BUY*
   💯 Confidence: 85%
   💰 Price: $180.50
   🎯 Target: $195.00
   📊 Expected Move: +8.0%
   📉 Volatility: 0.25
   🔢 Score: 92

*2. MSFT* (A)
   📈 Signal: *BUY*
   💯 Confidence: 82%
   💰 Price: $370.00
   🎯 Target: $390.00
   📊 Expected Move: +5.4%
   📉 Volatility: 0.22
   🔢 Score: 88

━━━━━━━━━━━━━━━━━━━━
💡 Total picks analyzed: 10
🔗 View full report: http://localhost:3000/weekly
```

## Maintenance

### Add more users
Simply add phone numbers to users.json and update the phone-to-chatId mapping.

### Change report frequency
Modify the cron schedules in scheduleWeeklyReportBatch.js.

### Customize report format
Edit the message formatting in the `getWeeklyReport()` function.

## Security Notes
- JWT authentication is used for API calls
- Default credentials: username='user', password='password'
- Update these in production
- Keep Telegram bot token secure in environment variables
