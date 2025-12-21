# Telegram Setup Guide

## The Error You're Seeing
```
[Weekly Report Batch] ✗ Failed to send to user: ETELEGRAM: 404 Not Found
```

This means your **Telegram bot token is not configured** or is invalid.

## How to Fix - Step by Step

### Step 1: Create a Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` command
3. Follow the prompts:
   - Choose a name for your bot (e.g., "Stock Trading Bot")
   - Choose a username (must end in 'bot', e.g., "my_stock_trading_bot")
4. **BotFather will give you a token** that looks like:
   ```
   1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567890
   ```
5. **Save this token** - you'll need it!

### Step 2: Get Your Chat ID

#### Option A: For Personal Messages
1. Search for **@userinfobot** on Telegram
2. Start a chat with it
3. It will show your chat ID (a number)
4. Save this chat ID

#### Option B: For Group/Supergroup (Your Current Setup)
Your current chat ID is: `-1003406286106`

To verify or get a new one:
1. Add your bot to the group/supergroup
2. Send a message in the group
3. Visit this URL in browser (replace YOUR_BOT_TOKEN):
   ```
   https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
   ```
4. Look for `"chat":{"id":-1001234567890` in the response
5. The negative number is your group chat ID

### Step 3: Configure the Backend

#### Method 1: Environment Variable (Recommended)

**On Windows PowerShell:**
```powershell
# Set for current session
$env:TELEGRAM_BOT_TOKEN = "your_actual_bot_token_here"

# Or add to your system environment variables:
[System.Environment]::SetEnvironmentVariable('TELEGRAM_BOT_TOKEN', 'your_token', 'User')
```

**Or create a `.env` file:**
```bash
cd backend
# Create .env file
echo "TELEGRAM_BOT_TOKEN=your_actual_bot_token_here" > .env
```

Then install dotenv:
```bash
npm install dotenv
```

And add to `backend/src/app.js` (at the very top):
```javascript
require('dotenv').config();
```

#### Method 2: Direct Configuration (Quick Test)

Edit `backend/src/services/telegramService.js`:
```javascript
const TELEGRAM_BOT_TOKEN = 'your_actual_bot_token_here'; // Replace with real token
```

### Step 4: Update Chat ID Mapping

Edit `backend/src/services/telegramService.js`:
```javascript
async function getChatIdByPhone(phone) {
    // Map your phone number to your chat ID
    const phoneToChat = {
        '6504830983': '-1003406286106',  // Your current mapping
        // Add more mappings here:
        // 'other_phone': 'other_chat_id',
    };
    return phoneToChat[phone] || null;
}
```

### Step 5: Test the Setup

```bash
cd backend
node src/testWeeklyReportBatch.js
```

**Success looks like:**
```
[Weekly Report Batch] Starting report generation...
[Weekly Report Batch] Sending to 1 user(s)...
[Weekly Report Batch] ✓ Sent to user (6504830983)
[Weekly Report Batch] Report batch completed
```

### Step 6: Restart Backend

```bash
cd backend
node src/app.js
```

You should see:
```
✓ Telegram bot initialized
[Weekly Report Batch] ✓ Scheduler started
```

## Troubleshooting

### Still Getting 404?
- ❌ Bot token is wrong or incomplete
- ❌ Bot token has spaces or quotes around it
- ✅ Copy token exactly from BotFather (no extra characters)

### Getting 403 Forbidden?
- ❌ Bot hasn't been started by user
- ❌ Bot was removed from group
- ✅ Send `/start` to your bot
- ✅ Re-add bot to group if needed

### Getting "Chat not found"?
- ❌ Wrong chat ID
- ❌ Bot not in the group
- ✅ Verify chat ID using getUpdates API
- ✅ Make sure bot is added to group/supergroup

### No Users Found?
- ❌ No phone number in users.json
- ✅ Check that users.json has `"phone": "6504830983"` field

## Quick Verification Checklist

- [ ] Created Telegram bot via @BotFather
- [ ] Copied bot token (starts with numbers, contains colon)
- [ ] Set TELEGRAM_BOT_TOKEN environment variable OR hardcoded token
- [ ] Got chat ID (for personal chat or group)
- [ ] Updated getChatIdByPhone() mapping
- [ ] Bot is started (sent /start command) OR added to group
- [ ] Phone number exists in users.json
- [ ] Ran test script successfully
- [ ] Restarted backend server

## Example Working Configuration

**Backend .env:**
```
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz1234567890
```

**telegramService.js:**
```javascript
async function getChatIdByPhone(phone) {
    if (phone === '6504830983') return '-1003406286106'; // Supergroup
    return null;
}
```

**users.json:**
```json
{
  "username": "user",
  "phone": "6504830983",
  ...
}
```

Once configured correctly, you'll receive beautiful formatted reports twice daily at 7 AM and 2:45 PM CST! 📊
