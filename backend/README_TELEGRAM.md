Telegram logger

This script helps you capture the Telegram chat_id for your account so you can map phone numbers to chat ids for demo messaging.

Steps

1. Get your bot token from BotFather.
2. In PowerShell, set the environment variable and run the logger:

```powershell
$env:TELEGRAM_BOT_TOKEN = "<your-bot-token>"
node backend/src/telegramLogger.js
```

3. Open Telegram, find your bot and send any message (e.g., "hi").
4. The logger will print an object containing the `chat.id` — copy that value.
5. Update `backend/src/services/telegramService.js` to map the user's phone to that `chat.id` (or reuse the `chat.id` directly in your code).

Notes

- The bot must be started by sending it a message first (otherwise the bot cannot message you).
- If you run into `ETELEGRAM: 404 Not Found`, ensure the bot token is correct and that you messaged the bot at least once.
