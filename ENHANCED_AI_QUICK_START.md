# Quick Start Guide: Enhanced AI Trading Bot

## What's New?

✨ **The AI Trading Bot has been completely enhanced!**

### Before (Old Bot):
- ❌ Only analyzed 10 hardcoded stocks
- ❌ Limited trading opportunities
- ❌ No market hours check

### After (Enhanced Bot):
- ✅ Analyzes **ALL 200+ stocks** from S&P 500 & NASDAQ-100
- ✅ Automatic trading during **market hours only** (9:30 AM - 4:00 PM ET)
- ✅ Advanced AI scoring system
- ✅ Comprehensive risk management
- ✅ Fully autonomous - no manual intervention needed
- ✅ Detailed activity logging

## How to Enable (3 Easy Steps)

### Step 1: Start the Backend
```bash
cd c:\MyProject\KiranRock\backend
npm start
```

You should see:
```
🤖 Starting Enhanced AI Trading Bot...
[Enhanced AI Scheduler] Starting enhanced AI trading scheduler...
[Enhanced AI Scheduler] Will only trade during market hours (9:30 AM - 4:00 PM ET, Mon-Fri)
[Enhanced AI Scheduler] ✓ Scheduler started successfully
```

### Step 2: Enable AI Trading for Your User

**Option A: Via API (Recommended)**
```bash
curl -X POST http://localhost:3001/api/enhanced-ai-trading/toggle \
  -H "Content-Type: application/json" \
  -d '{"userId":"YOUR_USER_ID","enabled":true}'
```

**Option B: Manually Edit users.json**
```json
{
  "id": "YOUR_USER_ID",
  "username": "your_username",
  "aiTradingEnabled": true,  // <-- Add this line
  ...
}
```

### Step 3: Fund Your Trading Account
```bash
# Make sure you have balance in your trading account
# The bot needs minimum $100 to start trading
```

## That's It! 🎉

The bot will now:
- Scan 200+ stocks every 5 minutes during market hours
- Automatically buy high-scoring opportunities
- Manage positions with stop-loss and take-profit
- Reflect all trades in your portfolio

## How to Monitor

### Check Status
```bash
curl http://localhost:3001/api/enhanced-ai-trading/status/YOUR_USER_ID
```

### View Trading Log
```bash
curl http://localhost:3001/api/enhanced-ai-trading/log/YOUR_USER_ID?limit=20
```

### Check Market Status
```bash
curl http://localhost:3001/api/enhanced-ai-trading/market/status
```

### Manual Test Scan
```bash
curl -X POST http://localhost:3001/api/enhanced-ai-trading/scan \
  -H "Content-Type: application/json" \
  -d '{"userId":"YOUR_USER_ID","limit":10}'
```

## Default Settings

The bot uses these safe defaults:

- **Max Position Size**: 15% per stock
- **Min AI Score**: 65 (out of 100) to buy
- **Stop Loss**: Sell at 12% loss
- **Trailing Stop**: Sell if drops 8% from peak
- **Take Profit**: Sell at 25% gain
- **Max Holdings**: 25 stocks
- **Cash Reserve**: 40% (max 60% invested)

## Customizing Settings

```bash
curl -X POST http://localhost:3001/api/enhanced-ai-trading/config/YOUR_USER_ID \
  -H "Content-Type: application/json" \
  -d '{
    "maxPositionSize": 0.10,
    "stopLoss": -0.10,
    "minBuyScore": 70,
    "maxOpenPositions": 20
  }'
```

## Trading Schedule

**During Market Hours** (9:30 AM - 4:00 PM ET, Mon-Fri):
- Bot scans market every 5 minutes
- Analyzes 200+ stocks
- Executes trades automatically
- Manages existing positions

**Outside Market Hours**:
- Bot checks but does not trade
- Logs "Market is closed"
- Waits for next market open

## What to Expect

### First Run
```
[AI Bot] Scanning market for opportunities...
[AI Bot] Analyzing 220 stocks (VIX: 15.23)
[AI Bot] ✓ Found 28 buy opportunities
[AI Bot] Account Balance: $50000.00, Holdings: 0
[AI Bot] Can invest: $30000.00
[AI Bot] BUY 25 shares of AAPL @ $185.50 (Score: 78)
[AI Bot] BUY 15 shares of GOOGL @ $142.30 (Score: 76)
[AI Bot] BUY 30 shares of MSFT @ $375.20 (Score: 74)
[AI Bot] ✓ Executed 3 trades, invested $8847.50
```

### Ongoing Management
```
[AI Bot] Managing existing positions...
[AI Bot] SELL 25 shares of AAPL: Take-profit at 26.5%
[AI Bot] SELL 15 shares of NVDA: Trailing stop triggered
```

## Safety Features

✅ **Capital Protection**
- Always maintains 40% cash reserve
- Never invests more than 15% in single stock

✅ **Risk Management**
- Automatic stop-loss on every position
- Trailing stops protect profits
- Sector diversification enforced

✅ **Volatility Protection**
- Won't buy when VIX > 30 (high volatility)
- Reduces exposure when VIX > 25

## Disabling the Bot

To stop autonomous trading:

```bash
curl -X POST http://localhost:3001/api/enhanced-ai-trading/toggle \
  -H "Content-Type: application/json" \
  -d '{"userId":"YOUR_USER_ID","enabled":false}'
```

Existing positions will remain but no new trades will be made.

## Troubleshooting

### Bot Not Trading?

1. **Check if market is open**
   ```bash
   curl http://localhost:3001/api/enhanced-ai-trading/market/status
   ```

2. **Check if enabled**
   ```bash
   curl http://localhost:3001/api/enhanced-ai-trading/status/YOUR_USER_ID
   ```

3. **Check account balance**
   - Need minimum $100 available

4. **Check console logs**
   - Look for error messages in backend terminal

### No Opportunities Found?
- Market may be highly volatile (VIX > 30)
- Try lowering `minBuyScore` in config
- Check console for scan results

### Trades Not in Portfolio?
- Verify tradingService is configured
- Check users.json for holdings array
- Review trading log for execution details

## Getting Help

📖 Full Documentation: `ENHANCED_AI_TRADING_GUIDE.md`

🐛 Check Logs:
```bash
# Backend console shows detailed output
# Or check trading log via API
curl http://localhost:3001/api/enhanced-ai-trading/log/YOUR_USER_ID
```

## Next Steps

1. ✅ Enable AI trading (see Step 2 above)
2. 📊 Monitor first few cycles to ensure it's working
3. ⚙️ Adjust risk settings if needed
4. 📈 Let it run autonomously!

---

**Enjoy fully autonomous AI trading! 🚀**
