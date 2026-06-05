# Enhanced AI Trading Bot Documentation

## Overview

The Enhanced AI Trading Bot is a fully autonomous trading system that:
- **Analyzes ALL available stocks** (200+ from S&P 500 and NASDAQ-100)
- **Trades automatically during market hours** (9:30 AM - 4:00 PM ET, Mon-Fri)
- **Executes trades without manual intervention**
- **Maintains risk management** per user configuration
- **Reflects all trades in portfolio** automatically

## Key Features

### 🤖 Autonomous Trading
- Scans entire market universe every 5 minutes during trading hours
- Analyzes stocks using AI-powered scoring system
- Automatically executes buy/sell orders based on signals
- No manual intervention required

### 📊 Comprehensive Market Coverage
- **S&P 500 stocks**: ~150 symbols
- **NASDAQ-100 stocks**: ~70 symbols
- **Total universe**: 200+ stocks with market cap > $5B
- Dynamic stock selection based on AI scoring

### ⚖️ Advanced Risk Management
- Position sizing with configurable limits
- Stop-loss and take-profit automation
- Trailing stop-loss for profit protection
- Sector diversification enforcement
- Volatility-based position adjustments

### ⏰ Market Hours Integration
- Only trades during NYSE hours (9:30 AM - 4:00 PM ET)
- Automatically skips weekends and holidays
- Checks market status before every trading cycle

## Architecture

### Core Components

#### 1. Enhanced AI Trading Bot (`enhancedAITradingBot.js`)
Main trading engine with the following functions:

- **`scanMarketForOpportunities(userId, limit)`**
  - Scans entire stock universe (200+ stocks)
  - Analyzes each stock using AI scoring
  - Returns top opportunities sorted by AI score
  - Filters by market cap, volume, and other criteria

- **`analyzeStockWithAI(symbol, vixLevel)`**
  - Calculates AI score (0-100) based on:
    - Momentum (40% weight)
    - Volume analysis (30% weight)
    - VIX impact (15% weight)
    - Market cap quality (15% weight)
  - Returns recommendation: STRONG BUY, BUY, HOLD, SELL, STRONG SELL

- **`executeAutonomousTrading(userId)`**
  - Main trading loop executed every 5 minutes
  - Checks market status
  - Manages existing positions (stop-loss/take-profit)
  - Scans for new opportunities
  - Executes trades with risk management

- **`manageExistingPositions(userId)`**
  - Monitors all holdings
  - Implements trailing stop-loss (8% from peak)
  - Hard stop-loss at 12% loss
  - Take-profit at 25% gain
  - Partial take-profit at 15% (sells 50%)

- **`isMarketOpen()`**
  - Returns true if market is currently open
  - Checks day (Mon-Fri) and time (9:30 AM - 4:00 PM ET)

#### 2. Enhanced AI Scheduler (`enhancedAIScheduler.js`)
Automated scheduling system:

- Runs every 5 minutes (configurable)
- Processes all users with `aiTradingEnabled: true`
- Logs all trading activity
- Handles errors gracefully
- Provides detailed console output

#### 3. Market Screener Service (`marketScreenerService.js`)
Stock universe provider:

- **`getStockUniverse()`**: Returns all 200+ stocks
- **`getStocksBySector(sector)`**: Filter by sector
- **`getTopLiquidStocks(limit)`**: High-volume stocks
- Caches data for 24 hours
- Rate-limited to prevent API throttling

## Configuration

### Default Risk Configuration

```javascript
{
  // Position Sizing
  maxPositionSize: 0.15,          // Max 15% in single stock
  minPositionSize: 0.02,          // Min 2% per position
  maxPortfolioRisk: 0.60,         // Max 60% invested (40% cash)
  
  // Entry/Exit Rules
  minBuyScore: 65,                // Min AI score to buy
  stopLoss: -0.12,                // Sell at 12% loss
  trailingStopPercent: 0.08,      // Trail 8% from peak
  takeProfitPercent: 0.25,        // Take profit at 25%
  partialTakeProfitPercent: 0.15, // Partial at 15%
  
  // Risk Limits
  maxOpenPositions: 25,           // Max holdings
  minMarketCap: 5000000000,       // Min $5B market cap
  maxDailyTrades: 10,             // Max trades per day
  
  // Volatility Management
  maxVix: 30,                     // Don't buy if VIX > 30
  reducePositionsVix: 25,         // Reduce if VIX > 25
  
  // Diversification
  maxSectorAllocation: 0.35,      // Max 35% per sector
  preferredSectors: ['Technology', 'Healthcare', 'Financials', 'Consumer']
}
```

### Customizing Risk Settings

Users can customize risk settings by calling:
```
POST /api/enhanced-ai-trading/config/:userId
```

Example:
```json
{
  "maxPositionSize": 0.10,
  "stopLoss": -0.10,
  "minBuyScore": 70
}
```

## API Endpoints

### Enable/Disable AI Trading
```
POST /api/enhanced-ai-trading/toggle
Body: { userId: string, enabled: boolean }
```

### Get AI Trading Status
```
GET /api/enhanced-ai-trading/status/:userId
Returns: {
  aiTradingEnabled: boolean,
  riskConfig: object,
  schedulerStatus: object,
  marketOpen: boolean,
  lastActivity: object
}
```

### Update Risk Configuration
```
POST /api/enhanced-ai-trading/config/:userId
Body: { /* risk config overrides */ }
```

### Get Trading Activity Log
```
GET /api/enhanced-ai-trading/log/:userId?limit=50
Returns: { log: array, totalEntries: number }
```

### Scan Market (Manual)
```
POST /api/enhanced-ai-trading/scan
Body: { userId: string, limit: number }
Returns: { opportunities: array, count: number }
```

### Execute Trading (Manual)
```
POST /api/enhanced-ai-trading/execute
Body: { userId: string }
Returns: { success: boolean, trades: array, ... }
```

### Get Scheduler Status
```
GET /api/enhanced-ai-trading/scheduler/status
Returns: { running: boolean, isProcessing: boolean, marketOpen: boolean }
```

### Check Market Status
```
GET /api/enhanced-ai-trading/market/status
Returns: { marketOpen: boolean, timestamp: date }
```

## Trading Logic

### Stock Selection Process

1. **Universe Retrieval**
   - Fetch all 200+ stocks from market screener
   - Filter by minimum market cap ($5B)

2. **AI Analysis**
   - Analyze each stock individually
   - Calculate AI score (0-100)
   - Generate recommendation

3. **Opportunity Filtering**
   - Keep only BUY or STRONG BUY recommendations
   - Require AI score >= minBuyScore (default 65)
   - Sort by AI score descending

4. **Position Sizing**
   - Calculate available capital
   - Check sector allocations
   - Check existing positions
   - Scale position size with AI score
   - Higher score = larger position (within limits)

5. **Execution**
   - Execute buy orders for selected stocks
   - Update portfolio tracking
   - Log all transactions

### Position Management

#### Entry Strategy
- Only buy during market hours
- VIX must be < 30 (configurable)
- AI score must be >= 65 (configurable)
- Check sector diversification
- Respect position size limits

#### Exit Strategy
- **Hard Stop-Loss**: Sell if loss >= 12%
- **Trailing Stop-Loss**: Sell if drops 8% from peak price
- **Partial Take-Profit**: Sell 50% at 15% gain
- **Full Take-Profit**: Sell all at 25% gain

#### Peak Price Tracking
```javascript
// Update peak price on each check
if (currentPrice > holding.peakPrice) {
  holding.peakPrice = currentPrice;
}

// Trailing stop triggers if drops 8% from peak
trailingStopPrice = peakPrice * 0.92;
if (currentPrice <= trailingStopPrice) {
  SELL();
}
```

## Enabling AI Trading

### Step 1: Enable for User

In your frontend application:
```typescript
const enableAITrading = async (userId: string) => {
  const response = await fetch('http://localhost:3001/api/enhanced-ai-trading/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, enabled: true })
  });
  return response.json();
};
```

### Step 2: Configure Risk (Optional)

```typescript
const updateRiskConfig = async (userId: string, config: any) => {
  const response = await fetch(`http://localhost:3001/api/enhanced-ai-trading/config/${userId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });
  return response.json();
};
```

### Step 3: Monitor Activity

```typescript
const getStatus = async (userId: string) => {
  const response = await fetch(`http://localhost:3001/api/enhanced-ai-trading/status/${userId}`);
  return response.json();
};

const getLog = async (userId: string) => {
  const response = await fetch(`http://localhost:3001/api/enhanced-ai-trading/log/${userId}?limit=50`);
  return response.json();
};
```

## Scheduler Behavior

### Startup
- Scheduler starts automatically when backend starts
- First scan happens immediately
- Then repeats every 5 minutes

### During Market Hours (9:30 AM - 4:00 PM ET, Mon-Fri)
- Scans market for opportunities
- Manages existing positions
- Executes trades for all enabled users
- Logs all activity

### Outside Market Hours
- Scheduler still runs every 5 minutes
- Detects market is closed
- Skips trading
- Logs "Market is closed"

### Console Output Example
```
================================================================================
[Enhanced AI Scheduler] Starting at 2025-12-21T14:30:00.000Z
================================================================================

[Enhanced AI Scheduler] ✓ Market is OPEN - proceeding with trading
[Enhanced AI Scheduler] Found 2 users with AI trading enabled

--------------------------------------------------------------------------------
[Enhanced AI Scheduler] Processing user: john_doe (ID: user123)
--------------------------------------------------------------------------------

[AI Bot] Scanning market for opportunities...
[AI Bot] Analyzing 220 stocks (VIX: 15.23)
[AI Bot] 218 stocks meet market cap requirement
[AI Bot] Analyzed 100/218 stocks, found 12 opportunities
[AI Bot] Analyzed 200/218 stocks, found 24 opportunities
[AI Bot] ✓ Found 28 buy opportunities, returning top 30
[AI Bot] Account Balance: $50000.00, Holdings: 15
[AI Bot] Can invest: $12500.00
[AI Bot] BUY 25 shares of AAPL @ $185.50 (Score: 78)
[AI Bot] BUY 15 shares of GOOGL @ $142.30 (Score: 76)
[AI Bot] BUY 30 shares of MSFT @ $375.20 (Score: 74)
[AI Bot] ✓ Executed 3 trades, invested $8847.50

[Enhanced AI Scheduler] ✓ User john_doe: Trading completed
  - Trades executed: 3
  - Capital deployed: $8847.50
  - Opportunities found: 28
  1. BUY 25 AAPL @ $185.50 (Score: 78, Sector: Technology)
  2. BUY 15 GOOGL @ $142.30 (Score: 76, Sector: Technology)
  3. BUY 30 MSFT @ $375.20 (Score: 74, Sector: Technology)

================================================================================
[Enhanced AI Scheduler] Trading cycle completed
================================================================================
```

## Safety Features

### Capital Protection
- Maximum 60% of portfolio invested
- Minimum 40% cash reserve maintained
- Position size limits per stock
- Sector diversification limits

### Risk Controls
- Stop-loss on every position
- Trailing stops protect profits
- Maximum positions limit
- Maximum daily trades limit

### Volatility Protection
- No buying when VIX > 30
- Reduce exposure when VIX > 25
- Position sizing adjusts with volatility

### Error Handling
- Graceful API failure handling
- Rate limiting to prevent throttling
- Continues on individual stock errors
- Logs all errors for debugging

## Monitoring & Debugging

### Check Scheduler Status
```bash
curl http://localhost:3001/api/enhanced-ai-trading/scheduler/status
```

### Check Market Status
```bash
curl http://localhost:3001/api/enhanced-ai-trading/market/status
```

### View Trading Log
```bash
curl http://localhost:3001/api/enhanced-ai-trading/log/user123?limit=20
```

### Manual Scan (Testing)
```bash
curl -X POST http://localhost:3001/api/enhanced-ai-trading/scan \
  -H "Content-Type: application/json" \
  -d '{"userId":"user123","limit":10}'
```

### Manual Trading Execution (Testing)
```bash
curl -X POST http://localhost:3001/api/enhanced-ai-trading/execute \
  -H "Content-Type: application/json" \
  -d '{"userId":"user123"}'
```

## Performance Considerations

### Market Scanning
- Analyzes 200+ stocks in batches of 20
- 1-second delay between batches (rate limiting)
- Full scan takes ~10-15 seconds
- Runs every 5 minutes during market hours

### API Rate Limits
- Yahoo Finance API: 2000 requests/hour
- Market screener: Cached for 24 hours
- Stock quotes: Real-time (not cached)

### Optimization Tips
- Increase `minBuyScore` to reduce trades
- Decrease `limit` in scanMarketForOpportunities
- Adjust CHECK_INTERVAL (default 5 minutes)
- Use `getTopLiquidStocks()` for faster analysis

## Troubleshooting

### Bot Not Trading
1. Check if market is open: `/api/enhanced-ai-trading/market/status`
2. Check if user has AI trading enabled
3. Check account balance (need minimum $100)
4. Check VIX level (must be < 30)
5. Check if max positions reached
6. Review console logs for errors

### No Opportunities Found
- May indicate no stocks meet criteria
- Try lowering `minBuyScore`
- Check VIX level
- Review AI scoring thresholds

### Trades Not Showing in Portfolio
- Check tradingService integration
- Verify portfolioTrackingService is working
- Check users.json for holdings array
- Review transaction logs

## Future Enhancements

### Planned Features
- [ ] Pre-market and after-hours trading support
- [ ] Options trading integration
- [ ] Machine learning model training
- [ ] Historical backtest results
- [ ] Performance analytics dashboard
- [ ] Email/SMS notifications for trades
- [ ] Risk-adjusted position sizing
- [ ] Correlation-based diversification
- [ ] Sentiment analysis integration
- [ ] Technical indicator combinations

### Configuration Enhancements
- [ ] User-specific sector preferences
- [ ] Custom AI scoring weights
- [ ] Time-based strategy switching
- [ ] Risk profile templates
- [ ] Trade execution timing preferences

## Support

For issues or questions:
1. Check console logs in backend
2. Review trading log: `/api/enhanced-ai-trading/log/:userId`
3. Test manual scan: `/api/enhanced-ai-trading/scan`
4. Check scheduler status: `/api/enhanced-ai-trading/scheduler/status`

## License

Part of KiranRock Trading Platform
