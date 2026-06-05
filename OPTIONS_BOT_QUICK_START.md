# 🚀 Autonomous Options Bot - Quick Start Guide

## ✅ Implementation Complete

The Autonomous Options Trading Bot has been **successfully implemented** and is now running on your system!

---

## 📦 What Was Implemented

### 1. Core Bot Engine (1,000+ lines)
**File:** `backend/src/services/autonomousOptionsBot.js`

**Features:**
- 4 trading strategies (Scalping, Swing, Spreads, Hedging)
- Greeks-based analysis (Delta, Gamma, Theta, Vega)
- VIX regime detection
- IV Rank calculation
- Position sizing with ATR
- Auto-exit logic (take profit, stop loss, theta decay, expiration)

### 2. Scheduler (300+ lines)
**File:** `backend/src/services/optionsBotScheduler.js`

**Schedule:**
- **09:45 AM ET** - Post-open scan
- **11:00 AM ET** - Mid-morning scan
- **01:00 PM ET** - Post-lunch scan
- **03:00 PM ET** - Pre-close scan
- **Every 5 minutes** - Position monitoring
- **04:15 PM ET** - Daily summary

### 3. Database Schema (400+ lines)
**File:** `backend/src/config/optionsSchema.sql`

**Tables Created:**
```
✅ options_trades           - All positions
✅ options_performance      - Daily metrics
✅ options_watchlist        - Monitored symbols
✅ options_alerts           - Real-time alerts
✅ options_bot_config       - User settings
```

**Views Created:**
```
✅ options_open_positions
✅ options_strategy_performance
✅ options_monthly_performance
```

### 4. API Routes (350+ lines)
**File:** `backend/src/routes/optionsBotRoutes.js`

**Endpoints:**
- `GET /api/options-bot/status` - Bot status & config
- `POST /api/options-bot/enable` - Enable/disable bot
- `PUT /api/options-bot/config` - Update settings
- `GET /api/options-bot/positions` - Open positions
- `GET /api/options-bot/history` - Closed trades
- `GET /api/options-bot/performance` - Metrics
- `POST /api/options-bot/manual-scan` - Trigger scan
- `POST /api/options-bot/close-position/:id` - Close position
- `GET /api/options-bot/alerts` - View alerts

### 5. Telegram Alerts
**File:** `backend/src/services/telegramAlertService.js` (enhanced)

**New Alerts:**
- Options trade executed
- Credit spread executed
- Position closed
- Bot started
- High IV opportunity

### 6. Integration
**File:** `backend/src/app.js` (updated)
- Routes registered
- Scheduler auto-starts
- Runs alongside stock trading bot

---

## 🎯 Current Status

### ✅ Database Initialized
```
Tables Created: 5
Views Created: 3
Triggers Created: 2
Default Configs: 10 users
```

### ✅ Backend Running
```
Server: http://localhost:3001
Options Bot: ACTIVE
Scheduler: RUNNING
Next Scan: Based on market hours
```

### ✅ System Checks
```
✓ PostgreSQL connected
✓ Options tables exist
✓ Telegram integrated
✓ Logging configured
✓ VIX data accessible
✓ Options data available
```

---

## 🔧 Quick Setup (3 Steps)

### Step 1: Get Your Auth Token

Login to get JWT token:
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "your_username",
    "password": "your_password"
  }'
```

Save the token from response: `"token": "YOUR_JWT_TOKEN"`

### Step 2: Enable Options Bot

```bash
curl -X POST http://localhost:3001/api/options-bot/enable \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

### Step 3: Configure Settings (Optional)

```bash
curl -X PUT http://localhost:3001/api/options-bot/config \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "scalping_enabled": true,
    "swing_enabled": true,
    "spreads_enabled": true,
    "max_open_positions": 3,
    "max_daily_loss": 500,
    "take_profit_percent": 40.0,
    "stop_loss_percent": 25.0
  }'
```

---

## 📊 Monitoring Commands

### Check Bot Status
```bash
curl http://localhost:3001/api/options-bot/status \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### View Open Positions
```bash
curl http://localhost:3001/api/options-bot/positions \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Check Performance
```bash
curl "http://localhost:3001/api/options-bot/performance?period=week" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

### Manual Scan (Test)
```bash
curl -X POST http://localhost:3001/api/options-bot/manual-scan \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## 📈 Strategy Configuration

### Current Allocation
- **30%** - Delta-Neutral Scalping (⚡ Quick profits)
- **40%** - Directional Swing (🎯 Momentum plays)
- **20%** - Credit Spreads (💰 Income generation)
- **10%** - Protective Hedging (🛡️ Portfolio insurance)

### Risk Limits
- **Max Position Risk:** 2% per trade
- **Max Account Risk:** 10% total
- **Max Open Positions:** 5
- **Max Daily Loss:** $1,000
- **Min Account Balance:** $10,000

### Exit Rules
- **Take Profit:** +50%
- **Stop Loss:** -30%
- **Trailing Stop:** 15%
- **Expiration:** Close <7 days
- **Theta Decay:** Close if >20% in 7 days

---

## 🔍 What Happens Next?

### Automatic Scanning
Bot will automatically:
1. **Scan market** at scheduled times (4x daily)
2. **Analyze options** using Greeks and IV
3. **Score opportunities** across all strategies
4. **Execute trades** for top-rated opportunities
5. **Monitor positions** every 5 minutes
6. **Exit automatically** based on rules
7. **Send Telegram alerts** for all events
8. **Track performance** in database

### Trading Cycle Example
```
09:45 AM ET - SCAN
  ├─ VIX: 18.5 (NORMAL)
  ├─ Symbols: 16
  ├─ Options: 450 total
  ├─ Liquid: 125
  ├─ High Score: 23
  │
  ├─ Scalping: 8 opps (max score: 87)
  ├─ Swing: 5 opps (max score: 91)
  └─ Spreads: 3 opps (max RoR: 18%)

EXECUTION (Top 2)
  ├─ BUY MSFT $420 Call × 2 contracts
  │   Strategy: Swing
  │   Delta: 0.68, Score: 91
  │   Entry: $3.45 ($690 total)
  │
  └─ SELL QQQ 400/395 Bull Put Spread × 3
      Strategy: Credit Spread
      Credit: $0.55/contract ($165 total)
      RoR: 18%

11:21 AM - MONITOR
  ├─ MSFT Call: +15% (holding)
  └─ QQQ Spread: +5% (holding)

11:26 AM - MONITOR
  ├─ MSFT Call: +52% → TAKE PROFIT! 🎯
  │   Exit: $5.25 ($360 profit)
  └─ QQQ Spread: +8% (holding)
```

---

## 📱 Telegram Alerts

You'll receive real-time notifications for:

✅ Bot started  
✅ Trade executed  
✅ Position closed  
✅ Take profit hit  
✅ Stop loss triggered  
✅ High IV opportunity  
✅ Daily summary  

**Setup:** Bot uses your Telegram chat ID from database.

---

## 📚 Documentation

### Complete Guide
See [AUTONOMOUS_OPTIONS_BOT.md](./AUTONOMOUS_OPTIONS_BOT.md) for:
- Detailed strategy explanations
- Greeks analysis deep dive
- Full API reference
- Risk management details
- Troubleshooting guide
- Best practices

### Related Docs
- [PROFESSIONAL_OPTIONS_GUIDE.md](./PROFESSIONAL_OPTIONS_GUIDE.md) - Manual options features
- [AI_BOT_ENHANCEMENTS.md](./AI_BOT_ENHANCEMENTS.md) - Stock trading bot
- [ENHANCEMENTS_DEPLOYED.md](./ENHANCEMENTS_DEPLOYED.md) - System overview

---

## 🔐 Security Notes

- Bot is **DISABLED by default** for all users
- Each user must explicitly enable via API
- JWT authentication required for all endpoints
- Positions isolated per user
- Circuit breakers protect capital
- Daily loss limits enforced

---

## 🎓 Recommended First Steps

1. **Monitor First** - Watch bot scan without trading
2. **Small Config** - Start with 1-2 max positions
3. **Single Strategy** - Enable only scalping initially
4. **Conservative Limits** - Use tighter stop losses
5. **Review Daily** - Check performance metrics
6. **Adjust Config** - Fine-tune based on results
7. **Scale Up** - Increase positions as confident

---

## 🏆 Success Metrics to Track

Monitor these KPIs:

| Metric | Target | Check Via |
|--------|--------|-----------|
| Win Rate | >55% | `/performance` |
| Profit Factor | >1.5 | `/performance` |
| Avg Win | >$100 | `/history` |
| Max Drawdown | <15% | Database query |
| Open Positions | ≤5 | `/positions` |
| Daily P/L | Track trend | `/status` |

---

## ⚠️ Important Reminders

- **Paper Trading:** Current implementation for testing
- **Market Hours:** Bot only trades 9:45 AM - 3:45 PM ET
- **Minimum Balance:** $10,000 required
- **API Rate Limits:** Yahoo Finance has limits
- **Monitor Actively:** Check positions during market hours
- **Start Conservatively:** Small size, tight stops
- **Test Thoroughly:** Use manual scan to test

---

## 🆘 Need Help?

### Common Issues

**Bot not trading?**
- Check enabled status
- Verify market hours
- Confirm balance >$10k
- Check daily loss limit

**No opportunities found?**
- Normal during low volatility
- Liquidity filters are strict
- Try manual scan for testing

**Database errors?**
- Run `node initialize-options-db.js`
- Check PostgreSQL connection

### View Logs
```bash
# Live logs
Get-Content backend\logs\ai-trading-2025-12-26.log -Wait

# Recent entries
Get-Content backend\logs\ai-trading-2025-12-26.log -Tail 50
```

### Check Database
```sql
-- Open positions
SELECT * FROM options_open_positions;

-- Recent trades
SELECT * FROM options_trades 
WHERE user_id = 'YOUR_USER_ID' 
ORDER BY entry_date DESC 
LIMIT 10;

-- Performance
SELECT * FROM options_strategy_performance 
WHERE user_id = 'YOUR_USER_ID';
```

---

## 🎯 Next: Start Trading!

Bot is **ready to trade**. To activate:

1. ✅ Database initialized
2. ✅ Backend running
3. ✅ Scheduler active
4. ⏳ **Enable for your user**
5. ⏳ **Configure settings**
6. ⏳ **Monitor first scan**

**Run these commands now:**
```bash
# Replace YOUR_JWT_TOKEN with actual token
TOKEN="YOUR_JWT_TOKEN"

# Enable bot
curl -X POST http://localhost:3001/api/options-bot/enable \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# Check status
curl http://localhost:3001/api/options-bot/status \
  -H "Authorization: Bearer $TOKEN"
```

---

**Status:** 🟢 **FULLY OPERATIONAL**  
**Version:** 1.0.0  
**Last Updated:** December 26, 2025

**Happy Trading! 🚀📈💰**
