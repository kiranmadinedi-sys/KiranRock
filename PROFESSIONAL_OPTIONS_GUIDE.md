# Professional Options Trading Features - Implementation Guide

## Overview
This system now includes professional-grade options trading features using **FREE Yahoo Finance API** exclusively. No paid subscriptions required.

---

## ✅ Implemented Features

### 1. **Market Screener** 📊
Full stock universe scanning with market cap filtering.

**API Endpoints:**
```
GET  /api/screener/universe        - Get all stocks >$2B market cap
GET  /api/screener/sector/:sector  - Filter by sector
GET  /api/screener/liquid          - Top liquid stocks for options
POST /api/screener/refresh         - Clear cache manually
```

**Coverage:**
- S&P 500 stocks (~150 symbols)
- NASDAQ 100 stocks (~70 symbols)  
- Total: 220+ stocks with >$2B market cap

**Caching:**
- 24-hour cache duration
- Rate limiting: 2-second delays between batches
- Batch size: 10 stocks per request

**Data Returned:**
- Market cap (filtered >= $2B)
- Current price
- Volume
- Sector
- Industry

**Example Usage:**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3001/api/screener/universe

curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3001/api/screener/liquid?limit=50
```

---

### 2. **Scalping Strategy** ⚡
Ultra-short-term options trading (minutes to hours).

**API Endpoints:**
```
GET  /api/scalping/:symbol                - Scan single symbol
POST /api/scalping/scan                   - Scan multiple symbols
GET  /api/scalping/watchlist/recommended  - Get liquid symbols
GET  /api/scalping/criteria/settings      - Get criteria parameters
```

**Scalping Criteria:**
```javascript
{
  minGamma: 0.05,           // High gamma for quick delta changes
  minDelta: 0.40,
  maxDelta: 0.70,
  minVolume: 500,           // Daily volume minimum
  minOpenInterest: 1000,
  maxBidAskSpread: 0.15,    // Max 15% spread
  minDaysToExp: 7,          // Minimum days to expiration
  maxDaysToExp: 45,
  minOptionPrice: 0.50,     // Min $0.50 per contract
  maxOptionPrice: 15.00     // Max $15.00 per contract
}
```

**Trade Parameters:**
- **Entry Price:** Ask price (always)
- **Profit Target:** +20% from entry
- **Stop Loss:** -10% from entry
- **Scoring:** 0-100 (must pass 80% of criteria = 80+ score)

**Timeframe Recommendations:**
- **Intraday (4-8 hours):** Theta < -0.05
- **1-2 days:** Theta -0.05 to -0.15
- **2-5 days:** Theta > -0.15

**Recommended Watchlist:**
```
AAPL, MSFT, GOOGL, AMZN, NVDA, META, TSLA, AMD
SPY, QQQ, IWM, COIN, PLTR, RIVN
```

**Example Usage:**
```bash
# Scan single symbol
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3001/api/scalping/AAPL

# Scan multiple symbols
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"symbols": ["AAPL", "TSLA", "NVDA"], "limit": 10}' \
  http://localhost:3001/api/scalping/scan

# Get watchlist
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3001/api/scalping/watchlist/recommended
```

**Frontend Page:**
- Navigate to: `http://localhost:3000/scalping`
- Features:
  - Single symbol scan with dropdown
  - Multi-symbol market scan
  - Custom symbol input (comma-separated)
  - Adjustable results limit (1-50)
  - Color-coded scoring (green >80, yellow >60)
  - Visual tags: Liquid, Tight Spread, High Gamma
  - Entry/Target/Stop prices displayed
  - Timeframe recommendations shown

---

### 3. **Scenario Modeling** 🎯
Risk analysis with price changes and time decay.

**API Endpoints:**
```
POST /api/scenarios/price-change  - Model Greeks with ±% stock move
POST /api/scenarios/theta-decay   - Model time decay over days
POST /api/scenarios/matrix        - Full price + time matrix
POST /api/scenarios/risk-metrics  - Calculate max profit/loss
```

**Price Scenarios:**
- -10%, -5%, -2%, 0%, +2%, +5%, +10%
- Recalculates all Greeks for each price
- Shows profit/loss and percentage change

**Time Scenarios:**
- 1, 7, 14, 30 days forward
- Models theta decay over time
- Shows option value degradation

**Full Scenario Matrix:**
- Combines price AND time scenarios
- 7 price levels × 4 time periods = 28 scenarios
- Comprehensive P/L heatmap

**Risk Metrics:**
```javascript
{
  maxProfit: number,         // Call: unlimited, Put: strike - premium
  maxLoss: number,           // Premium paid (long options)
  breakeven: number,         // Strike ± premium
  riskRewardRatio: number    // maxProfit / maxLoss
}
```

**Example Usage:**
```bash
# Price change scenario
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "option": {
      "symbol": "AAPL",
      "stockPrice": 175.00,
      "strikePrice": 175.00,
      "optionType": "call",
      "daysToExpiration": 30,
      "volatility": 0.30,
      "riskFreeRate": 0.045
    },
    "priceChange": 5
  }' \
  http://localhost:3001/api/scenarios/price-change

# Theta decay
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "option": { ... },
    "days": 30
  }' \
  http://localhost:3001/api/scenarios/theta-decay

# Full matrix
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"option": { ... }}' \
  http://localhost:3001/api/scenarios/matrix
```

**Frontend Page:**
- Navigate to: `http://localhost:3000/scenarios`
- Features:
  - Option setup form (symbol, stock price, strike, type, days, IV, risk-free rate)
  - 3 tabs: Full Matrix, Price Changes, Time Decay
  - Interactive table with all Greeks
  - Color-coded P/L (green = profit, red = loss)
  - Risk metrics cards (Max Profit, Max Loss, Breakeven, Risk/Reward)

---

## 🔧 Backend Integration

**File:** `backend/src/app.js`

Routes registered:
```javascript
const scalpingRoutes = require('./routes/scalpingRoutes');
const scenarioRoutes = require('./routes/scenarioRoutes');
const screenerRoutes = require('./routes/screenerRoutes');

app.use('/api/scalping', scalpingRoutes);
app.use('/api/scenarios', scenarioRoutes);
app.use('/api/screener', screenerRoutes);
```

**Services:**
- `marketScreenerService.js` - Stock universe scanning
- `scalpingStrategyService.js` - Scalping opportunity detection
- `scenarioModelingService.js` - Risk analysis & Greeks modeling

**Dependencies:**
- `yahoo-finance2` - Free stock and options data
- `fs/promises` - File system for caching
- Existing Black-Scholes implementation for Greeks

---

## 🎨 Frontend Integration

**Navigation Added:**
Dashboard header now includes:
- ⚡ Scalping - `/scalping`
- 🎯 Scenarios - `/scenarios`

**Pages Created:**
1. `frontend/app/scalping/page.tsx` - Scalping strategy UI
2. `frontend/app/scenarios/page.tsx` - Scenario modeling UI

**Authentication:**
All pages use `useAuth()` hook for token management.

---

## 📊 Data Flow

### Scalping Workflow:
1. User selects symbol from watchlist OR enters custom symbols
2. Backend fetches options chain from Yahoo Finance
3. Service calculates Black-Scholes Greeks (Delta, Gamma, Theta, Vega)
4. Filters options by scalping criteria (9 checks)
5. Scores each option 0-100 based on criteria passed
6. Returns top opportunities sorted by score
7. Frontend displays with entry/target/stop prices

### Scenario Modeling Workflow:
1. User inputs option parameters (symbol, strike, type, days, IV)
2. Backend calculates base option price using Black-Scholes
3. For each scenario (price change or time decay):
   - Recalculates d1, d2 with new parameters
   - Computes new Greeks
   - Calculates P/L vs baseline
4. Returns complete matrix with all scenarios
5. Frontend displays in interactive table

### Market Screener Workflow:
1. Service fetches S&P500 + NASDAQ100 symbol lists
2. Batches symbols (10 per batch)
3. Fetches quote data for each batch
4. Filters by market cap >= $2B
5. Caches results for 24 hours
6. Returns sorted by volume (liquidity)

---

## 🚀 Testing the New Features

### 1. Test Market Screener:
```bash
# Get top 50 liquid stocks
curl -H "Authorization: Bearer YOUR_TOKEN" \
  "http://localhost:3001/api/screener/liquid?limit=50"
```

Expected: 50 stocks with highest volume, all >$2B market cap

### 2. Test Scalping Scanner:
```bash
# Scan AAPL for scalping opportunities
curl -H "Authorization: Bearer YOUR_TOKEN" \
  http://localhost:3001/api/scalping/AAPL
```

Expected: List of options sorted by scalpScore (80-100 = excellent)

### 3. Test Scenario Modeling:
```bash
# Model AAPL call option with +5% stock price move
curl -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "option": {
      "symbol": "AAPL",
      "stockPrice": 175.00,
      "strikePrice": 175.00,
      "optionType": "call",
      "daysToExpiration": 30,
      "volatility": 0.30,
      "riskFreeRate": 0.045
    },
    "priceChange": 5
  }' \
  http://localhost:3001/api/scenarios/price-change
```

Expected: New option price, P/L, updated Greeks

---

## 📈 Performance Considerations

**Rate Limiting:**
- Market screener: 2-second delays between batches (220+ stocks = ~44 seconds full scan)
- Scalping scanner: 1-second delays between symbols
- Scenario modeling: No delays (all calculations local)

**Caching Strategy:**
- Stock universe: 24 hours
- Options chains: No cache (real-time data needed)
- Manual refresh available: `POST /api/screener/refresh`

**API Limits (Yahoo Finance Free):**
- ~2000 requests/hour soft limit
- Rate limiting built-in to stay under limits
- Batch processing to minimize calls

---

## 🎯 Best Practices

### For Scalping:
1. Focus on high gamma options (>0.05) for quick delta moves
2. Only trade liquid options (>500 volume, >1000 OI)
3. Ensure tight bid-ask spreads (<15%)
4. Set strict profit targets (+20%) and stop losses (-10%)
5. Monitor timeframe recommendations based on theta

### For Scenario Analysis:
1. Test multiple price scenarios before entering position
2. Understand theta decay impact over holding period
3. Check risk/reward ratio (aim for >2:1)
4. Model worst-case scenarios (max loss)
5. Use breakeven price for exit planning

### For Market Screening:
1. Filter by sector for focused scanning
2. Sort by volume for most liquid options
3. Refresh cache daily for accurate market cap data
4. Focus on stocks >$5B for best options liquidity

---

## 🔜 Future Enhancements (Still TODO)

### High Priority:
- [ ] Unusual activity detection (volume spikes, IV anomalies)
- [ ] CSV export for backtesting data
- [ ] Visual heatmaps for scenario matrices

### Medium Priority:
- [ ] Historical Greeks storage (time-series database)
- [ ] Multi-leg strategies (spreads, straddles)
- [ ] Real-time alerts for scalping opportunities

### Low Priority:
- [ ] Custom criteria editor for scalping
- [ ] Portfolio Greeks aggregation
- [ ] Earnings calendar integration with scenarios

---

## 📝 Notes

**FREE API Limitations:**
- Greeks calculated locally (Black-Scholes) - no live feed
- Implied Volatility from last trade (may be stale)
- Options chain data updates every ~5 minutes
- Historical options data limited to recent expirations

**Workarounds Implemented:**
- Local Black-Scholes calculation for accurate Greeks
- Newton-Raphson IV solver for real-time IV
- Caching to minimize API calls
- Batch processing to stay within rate limits

**Data Accuracy:**
- Stock prices: Real-time during market hours
- Options chains: ~5 minute delay
- Greeks: Calculated using current bid/ask
- Market cap: Updated daily

---

## 🐛 Troubleshooting

**Issue:** "Market screener returns 0 stocks"
- **Fix:** Run `POST /api/screener/refresh` to clear cache
- **Cause:** Cached data expired or Yahoo Finance API down

**Issue:** "Scalping scanner finds no opportunities"
- **Fix:** Check if market is open, try more liquid symbols (SPY, QQQ, AAPL)
- **Cause:** Criteria too strict or options not liquid enough

**Issue:** "Scenario modeling shows NaN values"
- **Fix:** Ensure volatility > 0 and days to expiration > 0
- **Cause:** Invalid option parameters

**Issue:** "Backend returns 401 Unauthorized"
- **Fix:** Login again to get fresh token
- **Cause:** Token expired (default: 24 hours)

---

## 🎓 Educational Resources

**Black-Scholes Model:**
- Delta: Rate of change of option price with respect to stock price
- Gamma: Rate of change of delta with respect to stock price
- Theta: Time decay (option value lost per day)
- Vega: Sensitivity to implied volatility changes

**Scalping Strategy:**
- Goal: Quick profits (20%) in short timeframes (hours to days)
- Key: High gamma options respond quickly to small stock moves
- Risk: Theta decay erodes value rapidly

**Scenario Analysis:**
- Purpose: Understand position risk before entering trade
- Use: Model best/worst case outcomes
- Benefit: Make informed decisions with quantified risk

---

## 📞 Support

All features implemented using:
- **FREE Yahoo Finance API** (no paid subscription)
- **Local Black-Scholes calculations** (no external Greeks API)
- **Open-source libraries** (no proprietary dependencies)

Backend running on: `http://localhost:3001`
Frontend running on: `http://localhost:3000`

**Quick Start:**
1. Login at `http://localhost:3000/login`
2. Navigate to **⚡ Scalping** or **🎯 Scenarios** from dashboard
3. Start scanning or modeling!

---

**Last Updated:** November 6, 2024
**Version:** 1.0.0
**Status:** ✅ Production Ready
