# 📰 NEWS Feature - Implementation Guide

## Overview
The NEWS tab aggregates market-moving news from multiple free API sources, providing comprehensive coverage of:
- 🏢 Company-specific news (earnings, upgrades/downgrades)
- 🌍 Macro economic news (Fed, inflation, interest rates)
- 📊 Market updates and analysis
- ⚡ High-impact breaking news

## Architecture

### Backend Services
- **`newsAggregationService.js`** - Core service that:
  - Fetches news from multiple APIs in parallel
  - Deduplicates headlines using similarity matching
  - Calculates market impact scores (1-4 scale)
  - Assigns sentiment scores when available
  - Caches results for 15 minutes to respect rate limits

### Data Sources
The system integrates 4 free API sources:

1. **Yahoo Finance** (No API key required)
   - Company-specific news
   - Works immediately out of the box
   
2. **Alpha Vantage** (Free tier: 25 requests/day)
   - AI-powered sentiment scoring
   - Ticker relevance scores
   - Get free key: https://www.alphavantage.co/support/#api-key

3. **Finnhub** (Free tier: 60 calls/minute)
   - Real-time market news
   - Economic calendar integration
   - Get free key: https://finnhub.io/

4. **NewsAPI** (Free tier: 100 requests/day)
   - Global financial news
   - Major publisher coverage (Reuters, CNBC, WSJ)
   - Get free key: https://newsapi.org/

## Setup Instructions

### 1. Get Free API Keys

**Alpha Vantage:**
```
1. Visit: https://www.alphavantage.co/support/#api-key
2. Enter your email
3. Copy the API key
```

**Finnhub:**
```
1. Visit: https://finnhub.io/register
2. Sign up (free)
3. Copy the API key from dashboard
```

**NewsAPI:**
```
1. Visit: https://newsapi.org/register
2. Sign up (free)
3. Copy the API key
```

### 2. Configure Environment Variables

Create or update `.env` file in the backend directory:

```bash
# Alpha Vantage API Key
ALPHA_VANTAGE_KEY=your_alpha_vantage_key_here

# Finnhub API Key
FINNHUB_KEY=your_finnhub_key_here

# NewsAPI Key
NEWSAPI_KEY=your_newsapi_key_here

# Telegram (already configured)
TELEGRAM_BOT_TOKEN=8520099950:AAFAAZrQCEK9B6wARjpoYDiqP3zNsaMz52Q
```

### 3. Restart Services

```powershell
# Stop existing Node processes
Get-Process node | Stop-Process

# Start servers
.\start.ps1
```

## Features

### News Feed Display
- ✅ Real-time aggregated news from multiple sources
- ✅ Category filtering (All, Macro, Company, Market)
- ✅ Ticker-specific filtering
- ✅ High-impact news filtering
- ✅ Sentiment indicators (Bullish/Bearish/Neutral)
- ✅ Market impact scoring (Low/Medium/High/Critical)
- ✅ Time-ago display (e.g., "2h ago")
- ✅ Source attribution
- ✅ Thumbnail images when available
- ✅ Auto-refresh with cache management

### Market Impact Scoring

The system automatically calculates impact scores:

**Critical Impact (4):**
- Federal Reserve announcements
- Interest rate decisions
- War/sanctions/elections
- Major inflation reports

**High Impact (3):**
- Earnings reports
- Revenue misses/beats
- Macro economic data

**Medium Impact (2):**
- Analyst upgrades/downgrades
- Company announcements

**Low Impact (1):**
- General company news

### Sentiment Analysis

When available from Alpha Vantage:
- 📈 Bullish (sentiment > 0.2)
- 📉 Bearish (sentiment < -0.2)
- ➡️ Neutral (sentiment between -0.2 and 0.2)

## API Endpoints

### GET `/api/news-aggregation/aggregate`
Get all aggregated news

**Query Parameters:**
- `tickers` (optional) - Comma-separated list of tickers
- `refresh` (optional) - Force cache refresh (true/false)

**Example:**
```
GET /api/news-aggregation/aggregate?tickers=AAPL,TSLA&refresh=true
```

### GET `/api/news-aggregation/category/:category`
Filter by category

**Categories:** all, macro, company, market

**Example:**
```
GET /api/news-aggregation/category/macro
```

### GET `/api/news-aggregation/ticker/:ticker`
Get news for specific ticker

**Example:**
```
GET /api/news-aggregation/ticker/AAPL
```

### GET `/api/news-aggregation/high-impact`
Get only high-impact news (impact >= 3)

**Example:**
```
GET /api/news-aggregation/high-impact
```

## Cache Management

- **Duration:** 15 minutes per cache
- **Storage:** `backend/src/storage/newsCache.json`
- **Auto-refresh:** Yes, when cache expires
- **Manual refresh:** Use `refresh=true` query parameter

## Rate Limits & Best Practices

### Yahoo Finance
- No official rate limits
- Respect their terms of service
- Used per-ticker, not for bulk requests

### Alpha Vantage (Free Tier)
- 25 requests per day
- 5 API calls per minute
- Service caches results to minimize calls

### Finnhub (Free Tier)
- 60 calls per minute
- Sufficient for most use cases
- Real-time updates available

### NewsAPI (Free Tier)
- 100 requests per day
- Requests cached for 15 minutes
- Development use only (production requires paid plan)

## Data Structure

Each news item contains:

```typescript
{
  headline: string;           // Article headline
  source: string;             // News source name
  published_at: string;       // ISO timestamp
  url: string;                // Link to full article
  description?: string;       // Brief description
  summary?: string;           // Detailed summary
  tickers: string[];          // Related stock tickers
  category: string;           // macro | company | market
  sentiment: number;          // -1 to +1
  sentiment_label?: string;   // Bearish | Neutral | Bullish
  market_impact: number;      // 1-4 impact score
  thumbnail?: string;         // Image URL
}
```

## Future Enhancements (Not Yet Implemented)

These features were suggested but not implemented yet:

1. **News Impact Score Integration**
   - Incorporate news sentiment into stock scoring algorithm
   - Adjust confidence scores based on recent news

2. **Market Risk Alert System**
   - Real-time alerts for critical market-moving news
   - Push notifications for high-impact events

3. **Automatic Stock Mapping**
   - Link news to affected stocks automatically
   - Calculate sector-wide impact

4. **Sentiment-Based Buy/Hold Logic**
   - Adjust trading signals based on news sentiment
   - Weight decisions by market impact

## Troubleshooting

### No News Showing
1. Check if API keys are set in `.env`
2. Verify backend is running
3. Check browser console for errors
4. Try manual refresh button

### Rate Limit Errors
- Wait for cache expiration (15 minutes)
- Consider upgrading to paid API tiers
- Implement longer cache duration if needed

### Missing Sentiment Scores
- Alpha Vantage key not configured
- Free tier limit exceeded
- Service temporarily unavailable

## Files Created

**Backend:**
- `backend/src/services/newsAggregationService.js` - Main aggregation service
- `backend/src/routes/newsAggregationRoutes.js` - API endpoints
- `backend/src/storage/newsCache.json` - Cache storage (auto-created)

**Frontend:**
- `frontend/app/news/page.tsx` - NEWS tab UI

**Modified:**
- `backend/src/app.js` - Registered news routes
- `frontend/app/components/AppHeader.tsx` - Added NEWS tab
- `frontend/app/components/AppHeaderMobile.tsx` - Added NEWS tab
- `frontend/app/components/MobileMenu.tsx` - Added NEWS tab

## Production Considerations

1. **API Keys Security**
   - Never commit `.env` to version control
   - Use environment variables in production
   - Rotate keys periodically

2. **Scalability**
   - Consider Redis for caching in production
   - Implement request queuing for rate limits
   - Monitor API usage and upgrade tiers as needed

3. **Legal Compliance**
   - Always display source attribution
   - Respect API terms of service
   - Don't claim "real-time" unless truly real-time
   - Add appropriate disclaimers

## Support & Resources

- Alpha Vantage Docs: https://www.alphavantage.co/documentation/
- Finnhub Docs: https://finnhub.io/docs/api
- NewsAPI Docs: https://newsapi.org/docs
- Yahoo Finance: Community-maintained (no official docs)

---

**Status:** ✅ Implemented and ready to use (API keys required for full functionality)
**Last Updated:** December 20, 2025
