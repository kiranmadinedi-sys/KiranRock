# 🤖 Autonomous Options Trading Bot

## Complete Implementation Guide

**Status:** ✅ **FULLY IMPLEMENTED & PRODUCTION READY**

---

## 📋 Table of Contents

1. [Overview](#overview)
2. [Features](#features)
3. [Architecture](#architecture)
4. [Installation](#installation)
5. [Configuration](#configuration)
6. [Trading Strategies](#trading-strategies)
7. [API Reference](#api-reference)
8. [Monitoring](#monitoring)
9. [Risk Management](#risk-management)
10. [Troubleshooting](#troubleshooting)

---

## 🎯 Overview

The Autonomous Options Trading Bot is a professional-grade algorithmic trading system designed to automatically trade options based on advanced technical analysis, Greeks, and market conditions.

### Key Capabilities

- **Fully Autonomous:** Scans markets, identifies opportunities, executes trades, and manages positions automatically
- **Multi-Strategy:** Implements 4 distinct options strategies with intelligent allocation
- **Greeks-Based:** Uses Delta, Gamma, Theta, Vega for precise decision-making
- **Risk-Aware:** Comprehensive risk management with position limits and circuit breakers
- **Real-Time Alerts:** Telegram notifications for all trading events
- **Performance Tracking:** Detailed metrics and analytics in PostgreSQL database

---

## ✨ Features

### Trading Strategies

#### 1. ⚡ Delta-Neutral Scalping
**Objective:** Quick profits from volatility swings  
**Timeframe:** Intraday (minutes to hours)  
**Target Return:** 20%

**Criteria:**
- ATM options (Delta ≈ 0.50 ± 0.10)
- High Gamma (>0.08) for quick delta changes
- High Vega (>0.15) to profit from volatility spikes
- Low Theta decay (<-0.30)
- Liquid options (>500 volume, >1000 OI)

#### 2. 🎯 Directional Swing
**Objective:** Capitalize on momentum moves  
**Timeframe:** 2-5 days  
**Target Return:** 35%

**Criteria:**
- ITM options (Delta 0.60-0.85 for calls, -0.60 to -0.85 for puts)
- Alignment with stock momentum
- Moderate Gamma (>0.03)
- 14-45 days to expiration
- Liquid options

#### 3. 💰 Credit Spreads
**Objective:** Generate consistent income  
**Timeframe:** 7-30 days  
**Target Return:** 15% (lower risk)

**Types:**
- **Bull Put Spread:** Sell OTM put, buy further OTM put (credit received)
- **Bear Call Spread:** Sell OTM call, buy further OTM call (credit received)

**Criteria:**
- Short leg delta ≈ 0.30 (70% probability OTM)
- Long leg delta ≈ 0.20 (protection)
- Minimum $0.30 credit
- Maximum $5 strike width
- Minimum 15% return on risk

#### 4. 🛡️ Protective Puts (Hedging)
**Objective:** Portfolio insurance  
**Timeframe:** 30-60 days  
**Target Return:** -5% (cost of insurance)

**Criteria:**
- 20% OTM puts (Delta ≈ -0.20)
- Maximum 2% of stock value cost
- High Vega for volatility protection

### Risk Management

```javascript
{
  maxAccountRisk: 0.10,        // Max 10% of account at risk
  maxPositionRisk: 0.02,       // Max 2% risk per position
  maxOpenPositions: 5,          // Max concurrent positions
  minAccountBalance: 10000,     // $10k minimum
  
  stopLoss: 0.30,              // Exit at -30%
  takeProfit: 0.50,            // Exit at +50%
  trailingStop: 0.15,          // Trail by 15%
  maxDailyLoss: 1000          // $1,000 daily limit
}
```

### Market Data & Analysis

- **VIX Monitoring:** Adjusts strategy based on volatility regime
- **IV Rank:** Identifies high/low IV opportunities
- **Liquidity Scoring:** Ensures tradeable options
- **Momentum Analysis:** Aligns with stock direction

### Position Management

- **ATR-Based Sizing:** Adjusts contracts based on volatility
- **Greeks Monitoring:** Continuous delta, gamma, theta, vega tracking
- **Auto-Exit Triggers:**
  - Take profit reached
  - Stop loss hit
  - Expiration approaching (<7 days)
  - High theta decay (>20% in 7 days)

---

## 🏗️ Architecture

### Components

```
┌─────────────────────────────────────────────────┐
│          Autonomous Options Bot                  │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────────┐    ┌──────────────┐          │
│  │  Scheduler   │───▶│ Market Scan  │          │
│  │ (4x daily)   │    │              │          │
│  └──────────────┘    └──────────────┘          │
│                             │                    │
│                             ▼                    │
│  ┌──────────────┐    ┌──────────────┐          │
│  │   Strategy   │◀───│  Opportunity │          │
│  │  Selection   │    │   Analysis   │          │
│  └──────────────┘    └──────────────┘          │
│         │                                        │
│         ▼                                        │
│  ┌──────────────┐    ┌──────────────┐          │
│  │   Position   │───▶│   Database   │          │
│  │   Execute    │    │   Storage    │          │
│  └──────────────┘    └──────────────┘          │
│         │                                        │
│         ▼                                        │
│  ┌──────────────┐    ┌──────────────┐          │
│  │   Monitor    │───▶│   Telegram   │          │
│  │  (5 min)     │    │    Alerts    │          │
│  └──────────────┘    └──────────────┘          │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Files Created

1. **`backend/src/services/autonomousOptionsBot.js`** (1,000+ lines)
   - Core trading engine
   - Strategy implementations
   - Greeks analysis
   - Position management

2. **`backend/src/services/optionsBotScheduler.js`** (300+ lines)
   - Cron scheduler
   - Market hours detection
   - User management
   - Daily summaries

3. **`backend/src/services/telegramAlertService.js`** (Enhanced)
   - Options trade alerts
   - Credit spread notifications
   - Position close alerts
   - Bot status updates
   - High IV opportunities

4. **`backend/src/routes/optionsBotRoutes.js`** (350+ lines)
   - RESTful API endpoints
   - Configuration management
   - Manual controls
   - Performance queries

5. **`backend/src/config/optionsSchema.sql`** (400+ lines)
   - Database schema
   - Tables, views, triggers
   - Performance tracking
   - Alert storage

---

## 🚀 Installation

### Step 1: Initialize Database

```bash
# Run database initialization script
node initialize-options-db.js
```

This creates:
- ✅ 5 database tables
- ✅ 3 analytical views
- ✅ 2 automatic triggers
- ✅ Default user configurations

### Step 2: Restart Backend

```bash
# Stop existing backend
Get-Process node | Stop-Process -Force

# Start with options bot
node backend/src/app.js
```

Look for:
```
✓ PostgreSQL database connected
⚡ Starting Autonomous Options Trading Bot...
[Options Scheduler] ✓ Scheduler started successfully
```

### Step 3: Test Installation

```bash
# Run comprehensive test suite
node test-options-bot.js
```

Tests verify:
- Database connectivity
- Table existence
- VIX data fetch
- Options data retrieval
- Scheduler status
- Configuration setup

---

## ⚙️ Configuration

### Database Schema

#### `options_trades` Table
Stores all options positions (open and closed).

```sql
CREATE TABLE options_trades (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) REFERENCES users(id),
    symbol VARCHAR(10),
    strike DECIMAL(10, 2),
    expiration DATE,
    option_type VARCHAR(4) CHECK (option_type IN ('CALL', 'PUT')),
    action VARCHAR(10) CHECK (action IN ('BUY', 'SELL')),
    contracts INTEGER,
    entry_price DECIMAL(10, 2),
    exit_price DECIMAL(10, 2),
    entry_date TIMESTAMP,
    exit_date TIMESTAMP,
    strategy VARCHAR(50),
    status VARCHAR(20) CHECK (status IN ('OPEN', 'CLOSED', 'EXPIRED', 'ASSIGNED')),
    profit_loss DECIMAL(12, 2),
    greeks_at_entry JSONB,
    ...
);
```

#### `options_bot_config` Table
User-specific bot configuration.

```sql
CREATE TABLE options_bot_config (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(255) UNIQUE REFERENCES users(id),
    enabled BOOLEAN DEFAULT TRUE,
    scalping_enabled BOOLEAN DEFAULT TRUE,
    swing_enabled BOOLEAN DEFAULT TRUE,
    spreads_enabled BOOLEAN DEFAULT TRUE,
    hedging_enabled BOOLEAN DEFAULT FALSE,
    max_position_risk DECIMAL(5, 4) DEFAULT 0.02,
    max_account_risk DECIMAL(5, 4) DEFAULT 0.10,
    max_open_positions INTEGER DEFAULT 5,
    max_daily_loss DECIMAL(10, 2) DEFAULT 1000,
    take_profit_percent DECIMAL(5, 2) DEFAULT 50.0,
    stop_loss_percent DECIMAL(5, 2) DEFAULT 30.0,
    ...
);
```

### Default Configuration

```javascript
{
  enabled: true,
  
  // Strategy enablement
  scalping_enabled: true,
  swing_enabled: true,
  spreads_enabled: true,
  hedging_enabled: false,
  
  // Risk limits
  max_position_risk: 0.02,      // 2% per trade
  max_account_risk: 0.10,       // 10% total
  max_open_positions: 5,
  max_daily_loss: 1000,         // $1,000
  
  // Exit rules
  take_profit_percent: 50.0,    // +50%
  stop_loss_percent: 30.0,      // -30%
  trailing_stop_percent: 15.0,  // 15% trail
  
  // Quality filters
  min_liquidity_score: 50.0,
  min_opportunity_score: 70.0,
  
  // Trading hours
  trading_start_time: '09:45:00',
  trading_end_time: '15:45:00'
}
```

---

## 📊 Trading Strategies

### Strategy Selection Logic

The bot analyzes each opportunity and assigns a score based on:

#### Scalper Score (0-100)
- **Gamma (40%):** Higher gamma = faster profit potential
- **Vega (30%):** Profit from volatility spikes
- **Liquidity (20%):** Tight spreads for execution
- **Theta (10%):** Less time decay is better

#### Swing Score (0-100)
- **Delta (40%):** Strong directional bias
- **Momentum (30%):** Aligned with stock trend
- **Liquidity (20%):** Tradeable spreads
- **DTE (10%):** Optimal 20-40 days to expiration

#### Spread Score (Return on Risk %)
- **Credit Received / Max Risk × 100**
- Minimum 15% return on risk required
- Probability of profit based on delta

### Example Scan Results

```
🔍 Market Scan at 09:45 AM ET

VIX: 18.5 (NORMAL)
Universe: 16 stocks

Found Opportunities:
⚡ Delta-Neutral Scalping: 8 opportunities
   - AAPL $185 Call (Score: 87)
   - SPY $480 Put (Score: 82)
   
🎯 Directional Swing: 5 opportunities
   - MSFT $420 Call (Score: 91)
   - NVDA $520 Call (Score: 88)
   
💰 Credit Spreads: 3 opportunities
   - QQQ 400/395 Bull Put Spread (RoR: 18%)
   - TSLA 250/255 Bear Call Spread (RoR: 16%)

Executing top 2 trades (max positions: 5, open: 3)
```

---

## 🔌 API Reference

### Authentication
All endpoints require Bearer token authentication.

```bash
Authorization: Bearer YOUR_JWT_TOKEN
```

### Endpoints

#### 1. Get Bot Status
```http
GET /api/options-bot/status
```

**Response:**
```json
{
  "enabled": true,
  "config": {
    "scalping_enabled": true,
    "swing_enabled": true,
    "max_open_positions": 5,
    "max_daily_loss": 1000
  },
  "openPositions": 3,
  "todayPerformance": {
    "total_trades": 5,
    "winning_trades": 3,
    "total_pnl": 450.00,
    "win_rate": 60.0
  },
  "scheduler": {
    "active": true,
    "marketOpen": true,
    "nextScans": ["09:45 AM ET", "11:00 AM ET", "01:00 PM ET", "03:00 PM ET"]
  },
  "vix": {
    "value": 18.5,
    "regime": "NORMAL"
  }
}
```

#### 2. Enable/Disable Bot
```http
POST /api/options-bot/enable
Content-Type: application/json

{
  "enabled": true
}
```

#### 3. Update Configuration
```http
PUT /api/options-bot/config
Content-Type: application/json

{
  "scalping_enabled": true,
  "swing_enabled": true,
  "spreads_enabled": false,
  "max_open_positions": 3,
  "max_daily_loss": 500,
  "take_profit_percent": 40.0,
  "stop_loss_percent": 25.0
}
```

#### 4. Get Open Positions
```http
GET /api/options-bot/positions
```

**Response:**
```json
[
  {
    "id": 1,
    "symbol": "AAPL",
    "strike": 185.00,
    "expiration": "2025-01-17",
    "option_type": "CALL",
    "contracts": 2,
    "entry_price": 3.50,
    "entry_date": "2025-12-26T14:45:00Z",
    "strategy": "directionalSwing",
    "status": "OPEN",
    "greeks_at_entry": {
      "delta": 0.65,
      "gamma": 0.04,
      "theta": -0.25,
      "vega": 0.18
    }
  }
]
```

#### 5. Get Trade History
```http
GET /api/options-bot/history?limit=50
```

#### 6. Get Performance Metrics
```http
GET /api/options-bot/performance?period=week
```

**Query Parameters:**
- `period`: `week`, `month`, `all`

**Response:**
```json
{
  "overall": {
    "total_trades": 25,
    "winning_trades": 16,
    "losing_trades": 9,
    "total_pnl": 1250.00,
    "avg_win": 125.50,
    "avg_loss": -65.25,
    "best_trade": 450.00,
    "worst_trade": -150.00,
    "win_rate": 64.0
  },
  "byStrategy": [
    {
      "strategy": "deltaNeutralScalping",
      "trades": 10,
      "pnl": 520.00
    },
    {
      "strategy": "directionalSwing",
      "trades": 12,
      "pnl": 680.00
    },
    {
      "strategy": "creditSpreads",
      "trades": 3,
      "pnl": 50.00
    }
  ]
}
```

#### 7. Manual Scan
```http
POST /api/options-bot/manual-scan
```

Triggers immediate scan and execution cycle.

#### 8. Close Position Manually
```http
POST /api/options-bot/close-position/:id
Content-Type: application/json

{
  "exitPrice": 5.25,
  "reason": "MANUAL_CLOSE"
}
```

#### 9. Get Alerts
```http
GET /api/options-bot/alerts?unread=true&limit=50
```

#### 10. Mark Alert as Read
```http
PUT /api/options-bot/alerts/:id/read
```

---

## 📈 Monitoring

### Telegram Alerts

The bot sends real-time alerts for:

#### Trade Execution
```
📈 OPTIONS TRADE EXECUTED ⚡

Action: BUY
Symbol: AAPL
Type: CALL
Strike: $185.00
Expiration: 2025-01-17

Contracts: 2
Price: $3.50
Total: $700.00

Strategy: directionalSwing

📊 Greeks:
• Delta: 0.650
• Gamma: 0.042
• Theta: -0.250
• Vega: 0.180
```

#### Position Closed
```
✅ OPTIONS POSITION CLOSED 🎯

Symbol: AAPL
Strike: $185
Expiration: 2025-01-17

Contracts: 2
Entry: $3.50
Exit: $5.25

P&L: $350.00 (50.0%)

Reason: TAKE PROFIT
```

#### Bot Started
```
🤖 OPTIONS BOT STARTED

💰 Account: $25,000.00
📊 VIX: 18.50

Strategies Enabled:
⚡ Delta-Neutral Scalping
🎯 Directional Swing
💰 Credit Spreads

Max Positions: 5

🔍 Scanning for opportunities...
```

#### High IV Opportunity
```
🔥 HIGH IV OPPORTUNITY

Symbol: TSLA
IV Rank: 82.5%

💰 Great for selling premium (credit spreads)

Recommended: creditSpreads
```

### Logs

Bot activity is logged to:
- `backend/logs/ai-trading-YYYY-MM-DD.log`
- `backend/logs/application-YYYY-MM-DD.log`

**View live logs:**
```bash
Get-Content backend\logs\ai-trading-2025-12-26.log -Wait
```

### Database Monitoring

**Check open positions:**
```sql
SELECT * FROM options_open_positions;
```

**Strategy performance:**
```sql
SELECT * FROM options_strategy_performance WHERE user_id = 'YOUR_USER_ID';
```

**Monthly performance:**
```sql
SELECT * FROM options_monthly_performance WHERE user_id = 'YOUR_USER_ID';
```

---

## 🛡️ Risk Management

### Position Limits

- **Max Open Positions:** 5 (configurable)
- **Max Position Risk:** 2% of account per trade
- **Max Account Risk:** 10% total at risk
- **Min Account Balance:** $10,000

### Exit Rules

| Trigger | Action | Threshold |
|---------|--------|-----------|
| Take Profit | Close position | +50% |
| Stop Loss | Close position | -30% |
| Trailing Stop | Adjust stop | 15% from peak |
| Expiration | Close position | <7 days |
| Theta Decay | Close position | >20% decay in 7 days |
| Daily Loss | Stop trading | $1,000 loss |

### Circuit Breakers

1. **Daily Loss Limit:** Trading stops if daily loss exceeds $1,000
2. **Account Balance:** Bot disabled if balance < $10,000
3. **Max Positions:** No new trades if max positions reached
4. **Market Hours:** Only trades 9:45 AM - 3:45 PM ET

### Liquidity Filters

All options must meet:
- Minimum 500 daily volume
- Minimum 1,000 open interest
- Maximum 15% bid-ask spread
- Stock price > $20
- Market cap > $2 billion

---

## 🔧 Troubleshooting

### Bot Not Trading

**Check:**
1. Bot enabled? `GET /api/options-bot/status`
2. Market open? Weekday 9:30 AM - 4:00 PM ET
3. Sufficient balance? Min $10,000
4. Daily loss limit reached? Check today's P/L
5. Max positions reached? Check open positions count

**Solution:**
```bash
# Enable bot
curl -X POST http://localhost:3001/api/options-bot/enable \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# Trigger manual scan
curl -X POST http://localhost:3001/api/options-bot/manual-scan \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### No Opportunities Found

**Reasons:**
1. High VIX (>35) - Bot becomes more conservative
2. Low liquidity - Options don't meet volume/OI thresholds
3. Poor quality scores - None meet min 70 score
4. Market conditions - Strategies prefer specific IV regimes

**Check logs:**
```bash
Get-Content backend\logs\ai-trading-2025-12-26.log | Select-String "Opportunities found"
```

### Database Errors

**Reinitialize:**
```bash
node initialize-options-db.js
```

**Verify tables:**
```sql
SELECT table_name FROM information_schema.tables 
WHERE table_schema = 'public' AND table_name LIKE 'options%';
```

### Scheduler Not Running

**Check status:**
```javascript
const status = optionsBotScheduler.getSchedulerStatus();
console.log(status);
```

**Restart:**
```javascript
optionsBotScheduler.stopOptionsScheduler();
optionsBotScheduler.startOptionsScheduler();
```

---

## 📚 Additional Resources

### Related Documentation
- [PROFESSIONAL_OPTIONS_GUIDE.md](./PROFESSIONAL_OPTIONS_GUIDE.md) - Manual options trading features
- [AI_BOT_ENHANCEMENTS.md](./AI_BOT_ENHANCEMENTS.md) - Stock trading bot documentation
- [ENHANCEMENTS_DEPLOYED.md](./ENHANCEMENTS_DEPLOYED.md) - System enhancements overview

### API Examples

**Full workflow:**
```bash
# 1. Check bot status
curl http://localhost:3001/api/options-bot/status \
  -H "Authorization: Bearer YOUR_TOKEN"

# 2. Update configuration
curl -X PUT http://localhost:3001/api/options-bot/config \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "scalping_enabled": true,
    "max_open_positions": 3,
    "take_profit_percent": 40.0
  }'

# 3. Enable bot
curl -X POST http://localhost:3001/api/options-bot/enable \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# 4. Monitor positions
curl http://localhost:3001/api/options-bot/positions \
  -H "Authorization: Bearer YOUR_TOKEN"

# 5. Check performance
curl http://localhost:3001/api/options-bot/performance?period=week \
  -H "Authorization: Bearer YOUR_TOKEN"
```

---

## 🎓 Best Practices

### For Maximum Performance

1. **Start Small:** Begin with 1-2 max positions, increase as confidence grows
2. **Monitor Daily:** Review performance metrics and adjust config
3. **Respect Limits:** Let circuit breakers protect your capital
4. **Diversify Strategies:** Enable multiple strategies for varied opportunities
5. **High IV for Spreads:** Credit spreads work best when IV >60%
6. **Low IV for Long:** Buy options when IV <30%
7. **Follow Alerts:** Telegram notifications keep you informed
8. **Weekly Reviews:** Analyze closed trades to identify patterns

### Risk Guidelines

- Never risk more than 2% per trade
- Keep total risk under 10% of account
- Start with small position sizes (1-2 contracts)
- Honor stop losses - don't override the bot
- Maintain $10k+ balance for proper diversification
- Review and adjust config monthly

---

## 🏆 Success Metrics

Track these KPIs:

- **Win Rate:** Target >55%
- **Profit Factor:** Target >1.5 (total wins / total losses)
- **Average Win:** Target >$100
- **Average Loss:** Target <$60
- **Max Drawdown:** Target <15%
- **Sharpe Ratio:** Target >1.0
- **Monthly Return:** Target 5-10%

---

## ⚠️ Disclaimer

This bot is for **paper trading and educational purposes**. Real options trading involves substantial risk of loss. Always:
- Test thoroughly before live trading
- Start with small position sizes
- Monitor actively during market hours
- Understand the strategies being used
- Comply with your broker's rules
- Consider tax implications
- Seek professional advice

---

## 🎯 Quick Start Checklist

- [ ] Run `node initialize-options-db.js`
- [ ] Restart backend with `node backend/src/app.js`
- [ ] Run `node test-options-bot.js` to verify
- [ ] Enable bot via API: `POST /api/options-bot/enable`
- [ ] Configure settings: `PUT /api/options-bot/config`
- [ ] Set up Telegram for alerts
- [ ] Monitor first scan: `GET /api/options-bot/status`
- [ ] Review first trades: `GET /api/options-bot/positions`
- [ ] Track performance: `GET /api/options-bot/performance`

---

**Bot Status:** 🟢 **OPERATIONAL**  
**Version:** 1.0.0  
**Last Updated:** December 26, 2025  
**Author:** KiranRock Trading System

---
