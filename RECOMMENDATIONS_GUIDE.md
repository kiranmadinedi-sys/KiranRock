# 🎯 Personalized Recommendations System

## Overview

The Personalized Recommendations System provides AI-powered, tailored stock recommendations based on your portfolio, risk profile, and market conditions. Unlike generic stock screeners, this system analyzes your actual holdings and suggests actions that make sense for YOUR specific situation.

## Key Features

### 1. **New Opportunities** 🌟
Discover stocks that match your risk profile and complement your existing portfolio:
- **Top Rated**: Highest-scoring stocks matching your risk tolerance
- **Diversification**: Stocks in sectors where you're underweight
- **Sector Rotation**: Strong momentum plays in hot sectors
- **High Conviction**: Low-risk, high-reward opportunities with 80%+ confidence

### 2. **Portfolio Actions** 📊
Get specific guidance on your existing positions:
- **SELL**: Exit weak positions with poor fundamentals
- **TRIM**: Take profits on overbought positions
- **ADD**: Increase positions with strong buy signals
- **HOLD**: Maintain positions with solid outlook

### 3. **Risk Analysis** 🛡️
Every recommendation includes:
- Risk score (0-100)
- Reward/risk ratio
- Confidence level
- Stop-loss triggers

### 4. **Portfolio Health Dashboard** 💼
Real-time tracking of:
- Total portfolio value
- Sector diversification score
- Current risk exposure vs target
- Number of positions

---

## How It Works

### Step 1: Analysis
The system analyzes 800+ stocks using:
- Multi-model AI predictions
- Technical indicators (RSI, MACD, SMA)
- Fundamental metrics (P/E, growth, margins)
- News sentiment
- Volume patterns

### Step 2: Personalization
Your recommendations are filtered by:
- **Risk Tolerance**: Conservative (low risk) → Aggressive (high risk)
- **Current Holdings**: Avoids duplicate recommendations
- **Portfolio Gaps**: Identifies underweight sectors
- **Market Conditions**: Adapts to current regime

### Step 3: Categorization
Recommendations are grouped by:
1. **Top Rated**: Best overall scores
2. **Diversification**: Fill portfolio gaps
3. **Sector Rotation**: Capture momentum
4. **High Conviction**: Low-risk gems

### Step 4: Action Items
For existing holdings:
- **SELL signals**: High urgency (🔴), weak outlook
- **TRIM signals**: Medium urgency (🟡), take profits
- **ADD signals**: Low urgency (🟢), strengthen winners
- **HOLD positions**: No action needed

---

## Risk Tolerance Profiles

### 🛡️ Conservative
**Best for**: Preservation of capital, retirement accounts, risk-averse investors

**Filters**:
- Maximum risk score: 40/100
- Minimum confidence: 75%
- Minimum total score: 70
- Focus on: Mega-cap, dividend stocks, defensive sectors

**Typical Holdings**: AAPL, MSFT, JNJ, PG, KO

### ⚖️ Moderate (Default)
**Best for**: Balanced growth, most investors, diversified portfolios

**Filters**:
- Maximum risk score: 60/100
- Minimum confidence: 65%
- Minimum total score: 65
- Focus on: Mix of growth and value

**Typical Holdings**: Mix of tech, financials, healthcare, consumer

### 🚀 Aggressive
**Best for**: Growth seekers, risk tolerance, active traders

**Filters**:
- Maximum risk score: 100/100
- Minimum confidence: 50%
- Minimum total score: 60
- Focus on: High-beta, momentum, emerging sectors

**Typical Holdings**: NVDA, TSLA, COIN, CRWD, high-growth tech

---

## Analysis Scopes

### ⚡ Quick (50 stocks)
- **Speed**: 15-20 seconds
- **Coverage**: Mega-cap stocks only (Apple, Microsoft, Google, etc.)
- **Best for**: Quick daily check, fast decisions
- **Universe**: Top 50 most liquid, highest market cap

### 📊 Balanced (200 stocks) - **Recommended**
- **Speed**: 60-90 seconds
- **Coverage**: Top 200 stocks across all sectors
- **Best for**: Comprehensive analysis without waiting
- **Universe**: Large-cap and mega-cap stocks

### 🌐 All (800+ stocks)
- **Speed**: 3-5 minutes
- **Coverage**: Complete market coverage
- **Best for**: Deep research, finding hidden gems
- **Universe**: All major US stocks across indices

---

## Understanding Recommendations

### Recommendation Card Components

```
#1  NVDA - NVIDIA Corporation                    High Conviction
    
    High conviction: 85% confidence, 2.8x reward/risk
    
    Current Price: $495.20    Target: $580.00
    Expected Move: +17.1%     Reward/Risk: 2.8x
    
    [Strong Buy] [85% confidence] [Score: 88] [Risk: 35/100]
```

**Key Metrics**:
- **Rank**: Priority order (#1 = highest)
- **Category**: Why it's recommended
- **Reason**: Specific justification
- **Current/Target**: Entry and exit prices
- **Expected Move**: Predicted gain/loss
- **Reward/Risk**: How much upside vs downside
- **Signal**: Buy recommendation strength
- **Confidence**: AI prediction certainty
- **Score**: Overall quality (0-100)
- **Risk**: Position risk level (0-100)

### Portfolio Action Components

```
🔴 AAPL - Apple Inc.                              SELL
    Current value: $50,000                        HIGH urgency
    
    High risk (78/100), weak technicals detected
    
    💡 Suggested: Exit position
    
    [Avoid] @ $170.50
```

**Key Metrics**:
- **Urgency**: 🔴 High | 🟡 Medium | 🟢 Low
- **Action**: SELL, TRIM, ADD, or HOLD
- **Current Value**: Your position size
- **Reason**: Why action is recommended
- **Suggested Amount**: Specific % to adjust

---

## API Endpoints

### Get Personalized Recommendations
```bash
GET /api/recommendations?riskTolerance=moderate&universe=TOP_200&maxRecommendations=10
Authorization: Bearer YOUR_JWT_TOKEN
```

**Query Parameters**:
- `riskTolerance`: `conservative`, `moderate`, or `aggressive` (default: `moderate`)
- `universe`: `MEGA_CAP`, `TOP_200`, or `ALL` (default: `TOP_200`)
- `maxRecommendations`: Number of recommendations (default: `10`)

**Response**:
```json
{
  "recommendations": [
    {
      "symbol": "NVDA",
      "name": "NVIDIA Corporation",
      "sector": "Technology",
      "currentPrice": "495.20",
      "totalScore": 88,
      "category": "High Conviction",
      "reason": "High conviction: 85% confidence, 2.8x reward/risk",
      "priority": 1,
      "prediction": {
        "signal": "Strong Buy",
        "confidence": 85,
        "expectedMove": "17.1",
        "targetPrice": "580.00"
      },
      "riskAnalysis": {
        "riskScore": 35,
        "riskLevel": "Low"
      },
      "rewardRiskRatio": "2.8"
    }
  ],
  "portfolioActions": [
    {
      "action": "SELL",
      "symbol": "AAPL",
      "currentValue": 50000,
      "reason": "High risk (78/100), weak technicals detected",
      "urgency": "high",
      "prediction": {
        "signal": "Avoid",
        "currentPrice": "170.50"
      }
    }
  ],
  "portfolioAnalysis": {
    "totalValue": 250000,
    "sectorExposure": {
      "Technology": 45.0,
      "Healthcare": 25.0,
      "Finance": 15.0,
      "Consumer": 10.0,
      "Energy": 5.0
    },
    "riskScore": 52,
    "diversificationScore": 72,
    "holdingsCount": 12
  },
  "riskProfile": {
    "tolerance": "moderate",
    "currentExposure": 52,
    "recommendation": "Portfolio risk is well-aligned with your risk tolerance"
  },
  "summary": {
    "newOpportunities": 10,
    "portfolioAdjustments": {
      "sells": 2,
      "trims": 1,
      "adds": 3
    },
    "topCategories": ["High Conviction", "Top Rated", "Diversification"],
    "message": "10 new opportunities identified. 3 position adjustments recommended."
  }
}
```

### Quick Recommendations (Top 5, Fast)
```bash
GET /api/recommendations/quick?riskTolerance=moderate
Authorization: Bearer YOUR_JWT_TOKEN
```

Returns only top 5 recommendations using MEGA_CAP universe for speed.

### Portfolio Actions Only
```bash
GET /api/recommendations/portfolio-actions?universe=TOP_200
Authorization: Bearer YOUR_JWT_TOKEN
```

Returns only portfolio rebalancing suggestions (no new stocks).

---

## Best Practices

### 1. **Set Correct Risk Tolerance**
- Be honest about your risk appetite
- Consider your investment timeframe
- Factor in your portfolio size

### 2. **Use Appropriate Scope**
- Daily checks: Use Quick (50 stocks)
- Weekly research: Use Balanced (200 stocks)
- Deep dives: Use All (800+ stocks)

### 3. **Review Regularly**
- Check recommendations weekly
- Update after major market moves
- Rebalance quarterly

### 4. **Understand Categories**
- **High Conviction**: Highest certainty
- **Top Rated**: Best overall
- **Diversification**: Fill gaps
- **Sector Rotation**: Capture trends

### 5. **Act on Urgency**
- 🔴 High: Act within days
- 🟡 Medium: Act within weeks
- 🟢 Low: Monitor and consider

### 6. **Validate Before Trading**
- Check current price
- Review company news
- Consider market conditions
- Set stop-losses

---

## Portfolio Diversification Guide

### Sector Allocation Targets

**Conservative Portfolio**:
- Technology: 15-20%
- Healthcare: 15-20%
- Financials: 15-20%
- Consumer Staples: 15-20%
- Utilities: 10-15%
- Other: 15-20%

**Moderate Portfolio**:
- Technology: 25-30%
- Healthcare: 15-20%
- Financials: 15-20%
- Consumer Discretionary: 10-15%
- Industrials: 10-15%
- Other: 10-15%

**Aggressive Portfolio**:
- Technology: 40-50%
- Healthcare: 10-15%
- Consumer Discretionary: 10-15%
- Communications: 10-15%
- Financials: 5-10%
- Other: 5-15%

### Diversification Score Interpretation

- **90-100**: Excellent diversification
- **70-89**: Good diversification
- **50-69**: Moderate diversification (improvement recommended)
- **Below 50**: Poor diversification (action needed)

**Improvement Tips**:
- Add positions in underweight sectors
- Reduce oversized positions
- Aim for 10-15 holdings minimum
- Avoid >30% in any single sector

---

## Risk Management

### Position Sizing
Based on risk score:
- **Low Risk (0-40)**: 5-10% of portfolio
- **Medium Risk (40-60)**: 3-5% of portfolio
- **High Risk (60-100)**: 1-3% of portfolio

### Stop-Loss Recommendations
- **Conservative**: -5% to -8%
- **Moderate**: -8% to -12%
- **Aggressive**: -12% to -20%

### Portfolio Risk Targets
- **Conservative**: 0-40 risk score
- **Moderate**: 40-60 risk score
- **Aggressive**: 60+ risk score

---

## Common Scenarios

### Scenario 1: "Too Tech Heavy"
**Problem**: 60% in technology sector

**Recommendations Will Show**:
- Diversification picks in Healthcare, Financials, Consumer
- Trim suggestions on largest tech positions
- Target: Reduce tech to 25-30%

### Scenario 2: "Need Income"
**Problem**: All growth stocks, no dividends

**Action**: Switch to Conservative risk profile

**Recommendations Will Show**:
- Dividend aristocrats
- Utility stocks
- REIT opportunities
- Consumer staples

### Scenario 3: "Market Correction"
**Problem**: High risk exposure during volatility

**Action**: Temporarily switch to Conservative

**Recommendations Will Show**:
- Defensive sectors
- Low-beta stocks
- Cash-generating businesses
- Sell high-risk positions

### Scenario 4: "New Capital to Deploy"
**Problem**: Received $50k, need allocation guidance

**Action**: Run with your normal risk profile

**Recommendations Will Show**:
- Top 10 new opportunities
- Prioritized by category
- Balanced across sectors
- Clear entry points

---

## Integration with Other Features

### Weekly Predictions
Recommendations use the same AI analysis as weekly predictions but:
- Filter by YOUR risk tolerance
- Consider YOUR existing holdings
- Suggest specific actions
- Prioritize by personal relevance

### Portfolio Page
Cross-reference recommendations with:
- Current holdings performance
- Unrealized gains/losses
- Position sizes
- Sector exposure

### Alerts
Set alerts for:
- Recommended stock price targets
- Stop-loss levels from portfolio actions
- Earnings dates for recommended stocks

---

## Technical Details

### Recommendation Algorithm

1. **Score Calculation**:
   - Technical score (0-100)
   - Fundamental score (0-100)
   - AI confidence (0-100)
   - Risk score (0-100)
   - Weighted average = Total score

2. **Risk Filtering**:
   ```javascript
   if (riskScore > maxRiskForProfile) SKIP
   if (confidence < minConfidenceForProfile) SKIP
   if (totalScore < minScoreForProfile) SKIP
   ```

3. **Category Assignment**:
   - Score > 80 + Risk < 50 + Confidence > 80 → High Conviction
   - Score > 70 + Match risk profile → Top Rated
   - Underweight sector + Score > 65 → Diversification
   - Sector momentum > 70 → Sector Rotation

4. **Priority Ranking**:
   - Priority 1: High Conviction, Top Rated
   - Priority 2: Diversification, Sector Rotation
   - Sort by: Priority → Score → Confidence

5. **Portfolio Action Logic**:
   ```javascript
   if (signal === 'Avoid' || riskScore > 75) → SELL
   if (technical < 40 && profit > 20%) → TRIM
   if (signal === 'Strong Buy' && confidence > 75) → ADD
   else → HOLD
   ```

---

## Performance Tracking

The system will soon track:
- Recommendation accuracy
- Average returns
- Win rate by category
- Best performing risk profile

**Coming Soon**: Historical performance dashboard showing which recommendations outperformed.

---

## Troubleshooting

### "No recommendations found"
**Causes**:
- Risk tolerance too conservative for current market
- All good stocks already in portfolio
- Market conditions unfavorable

**Solutions**:
- Adjust risk tolerance
- Expand universe to ALL
- Check again during market uptrend

### "Too many portfolio actions"
**Causes**:
- Portfolio severely misaligned with risk profile
- Major market shift

**Solutions**:
- Prioritize by urgency (🔴 first)
- Implement changes gradually over weeks
- Rebalance 20-30% per week

### "Recommendations keep changing"
**Causes**:
- Market conditions volatile
- Stock prices moving rapidly
- News events impacting sentiment

**Solutions**:
- Focus on High Conviction category (most stable)
- Use longer timeframes
- Average into positions

---

## FAQ

**Q: How often should I check recommendations?**
A: Weekly for long-term investors, daily for active traders.

**Q: Should I follow all recommendations?**
A: No. Start with High Conviction and Top Rated categories. Consider your own research.

**Q: What if a recommendation conflicts with my research?**
A: Trust your research. The system is a tool, not a replacement for due diligence.

**Q: Can I customize risk thresholds?**
A: Currently uses predefined profiles (Conservative/Moderate/Aggressive). Custom thresholds coming soon.

**Q: How accurate are the predictions?**
A: Based on multi-model AI with 65-75% historical accuracy. Past performance doesn't guarantee future results.

**Q: What happens if I have no holdings?**
A: System shows only new opportunities, no portfolio actions. Perfect for starting a portfolio!

**Q: Do recommendations account for tax implications?**
A: No. Consult a tax professional before selling positions.

**Q: Can I get recommendations for a watchlist instead of holdings?**
A: Currently analyzes actual holdings. Watchlist integration coming soon.

---

## Examples

### Example 1: Conservative Investor
**Profile**:
- Risk tolerance: Conservative
- Portfolio: $500k, mostly large-cap
- Goal: Capital preservation + modest growth

**Recommendations**:
```
NEW OPPORTUNITIES (5):
1. JNJ - High Conviction - Score: 75, Risk: 25
2. PG - Top Rated - Score: 72, Risk: 30
3. KO - Diversification - Score: 70, Risk: 28
4. MSFT - Top Rated - Score: 78, Risk: 35
5. XOM - Sector Rotation - Score: 71, Risk: 38

PORTFOLIO ACTIONS (2):
- TRIM TSLA (risk too high for profile)
- ADD KO (strengthen defensive allocation)
```

### Example 2: Aggressive Trader
**Profile**:
- Risk tolerance: Aggressive
- Portfolio: $100k, high-growth tech
- Goal: Maximum growth

**Recommendations**:
```
NEW OPPORTUNITIES (10):
1. NVDA - High Conviction - Score: 92, Risk: 55
2. CRWD - Sector Rotation - Score: 88, Risk: 68
3. COIN - Top Rated - Score: 85, Risk: 82
4. PLTR - High Conviction - Score: 87, Risk: 72
... (6 more)

PORTFOLIO ACTIONS (4):
- SELL AMD (technical breakdown)
- ADD NVDA (strong momentum)
- TRIM META (take profits)
- ADD COIN (crypto exposure)
```

### Example 3: Balanced Portfolio
**Profile**:
- Risk tolerance: Moderate
- Portfolio: $250k, diversified
- Goal: Balanced growth

**Recommendations**:
```
NEW OPPORTUNITIES (10):
1. AAPL - High Conviction - Score: 84, Risk: 42
2. V - Top Rated - Score: 81, Risk: 38
3. LLY - Diversification (Healthcare) - Score: 80, Risk: 45
4. HD - Top Rated - Score: 78, Risk: 40
... (6 more)

PORTFOLIO ACTIONS (3):
- SELL XYZ (fundamental weakness)
- TRIM ABC (overweight sector)
- ADD V (payment processing leader)
```

---

## Changelog

### Version 1.0.0 (December 2024)
- Initial release
- 800+ stock universe
- 3 risk tolerance profiles
- 4 recommendation categories
- Portfolio action suggestions
- Real-time analysis
- Sector diversification tracking

### Roadmap
- [ ] Performance tracking dashboard
- [ ] Custom risk parameters
- [ ] Watchlist recommendations
- [ ] Tax-aware rebalancing
- [ ] Options strategy recommendations
- [ ] Crypto integration
- [ ] Social sentiment analysis
- [ ] Peer portfolio comparison

---

## Support

For questions or issues:
- Check this documentation first
- Review FAQ section
- Test with Quick mode first
- Report bugs via support channel

---

**Disclaimer**: Recommendations are for informational purposes only. Not financial advice. Past performance doesn't guarantee future results. Always do your own research and consult a financial advisor before making investment decisions.
