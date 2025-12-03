# 🔗 API Quick Reference

## Base URL
```
http://localhost:3001/api
```

## Authentication
All endpoints (except `/auth/login` and `/auth/register`) require JWT token:
```http
Authorization: Bearer <your-jwt-token>
```

---

## 📊 Stock Data

### Get Stock Price Data
```http
GET /stocks/:symbol?interval=1d
```
**Intervals**: `1d` (daily), `1wk` (weekly), `1mo` (monthly), `all` (10 years)

**Response**:
```json
[
  {
    "time": 1730764800,
    "open": 225.50,
    "high": 227.80,
    "low": 224.10,
    "close": 226.75,
    "volume": 45123000
  }
]
```

---

## 🤖 AI Signals

### Get Trading Signals
```http
GET /signals/:symbol
```

**Response**:
```json
{
  "signal": "Buy",
  "confidence": "85.5",
  "strength": 2.3,
  "timestamp": "2025-11-04T10:30:00Z"
}
```

### Get Historical Signals (with markers)
```http
GET /signals/:symbol/historical?shortPeriod=5&longPeriod=15&interval=1d
```

**Response**:
```json
[
  {
    "time": 1730764800,
    "position": "belowBar",
    "color": "#00c805",
    "shape": "arrowUp",
    "text": "Buy @ 226.75",
    "strength": 2.3,
    "confidence": "85.5"
  }
]
```

---

## 📈 Technical Indicators

### EMA (Exponential Moving Average)
```http
GET /indicator/ema/:symbol?period=20&interval=1d
```

### Bollinger Bands
```http
GET /indicator/bbands/:symbol?interval=1d
```

### RSI (Relative Strength Index)
```http
GET /indicator/rsi/:symbol?period=14&interval=1d
```

**Response**:
```json
[
  { "time": 1730764800, "value": 67.5 }
]
```
- **Overbought**: RSI > 70
- **Oversold**: RSI < 30

### MACD
```http
GET /indicator/macd/:symbol?fast=12&slow=26&signal=9&interval=1d
```

**Response**:
```json
{
  "macd": [{ "time": 1730764800, "value": 1.25 }],
  "signal": [{ "time": 1730764800, "value": 0.98 }],
  "histogram": [{ "time": 1730764800, "value": 0.27, "color": "#00c805" }]
}
```

---

## 💼 Fundamentals

### Get Fundamental Data
```http
GET /fundamentals/:symbol
```

**Response**:
```json
{
  "metrics": {
    "peRatio": "28.50",
    "pegRatio": "1.85",
    "eps": "6.42",
    "revenueGrowth": "15.2%",
    "profitMargin": "26.5%",
    "returnOnEquity": "45.8%",
    "marketCap": "$3.45T",
    "dividend": "$0.96",
    "dividendYield": "0.42%"
  },
  "valuation": {
    "status": "Fair Value",
    "description": "PEG ratio of 1.85 suggests fair valuation.",
    "signal": "Neutral"
  },
  "growth": {
    "status": "Moderate Growth",
    "description": "Revenue growing at 15.2% shows healthy expansion.",
    "signal": "Bullish"
  },
  "recommendation": {
    "rating": "Buy",
    "confidence": "Medium",
    "rationale": "Positive fundamentals with room for appreciation."
  }
}
```

---

## 📰 News & Sentiment

### Get News and Sentiment Analysis
```http
GET /news/:symbol
```

**Response**:
```json
{
  "articles": [
    {
      "title": "Apple Reports Record Quarter",
      "publisher": "Bloomberg",
      "link": "https://...",
      "publishedAt": "2025-11-04T09:00:00Z",
      "sentiment": {
        "score": "45.5",
        "label": "Positive",
        "positiveCount": 5,
        "negativeCount": 1
      }
    }
  ],
  "sentiment": {
    "score": "32.5",
    "label": "Very Positive",
    "confidence": "High",
    "breakdown": {
      "positive": "60%",
      "negative": "20%",
      "neutral": "20%"
    }
  },
  "analystRatings": {
    "currentRating": "BUY",
    "strongBuy": 15,
    "buy": 20,
    "hold": 8,
    "sell": 2,
    "strongSell": 0,
    "consensus": "Strong Buy"
  },
  "summary": "News sentiment is very positive with high confidence. Analysts consensus: Strong Buy. Based on 45 analyst ratings."
}
```

---

## 📊 Volume Analysis

### Get Volume Analysis
```http
GET /volume/:symbol?interval=1d
```

**Response**:
```json
{
  "currentVolume": 45123000,
  "averageVolume": 42500000,
  "recentAverageVolume": 48200000,
  "volumeChange": "13.5",
  "volumeTrend": "Increasing",
  "volumeStatus": "High",
  "signals": [
    {
      "time": 1730764800,
      "type": "Bullish Breakout",
      "strength": "Strong",
      "price": 226.75,
      "volume": 67800000
    }
  ],
  "interpretation": {
    "sentiment": "Bullish",
    "confidence": "High",
    "description": "Strong buying pressure with increasing volume confirms uptrend."
  }
}
```

---

## 📉 Pattern Detection

### Detect Chart Patterns
```http
GET /patterns/:symbol?interval=1d
```

**Response**:
```json
{
  "patterns": [
    {
      "type": "Bullish Breakout",
      "signal": "Bullish",
      "strength": "Strong",
      "time": 1730764800,
      "price": 226.75,
      "description": "Price broke above resistance at $225.50 with strong volume.",
      "confidence": 85
    },
    {
      "type": "Double Bottom",
      "signal": "Bullish",
      "strength": "Strong",
      "time": 1730678400,
      "price": 220.50,
      "description": "Bullish reversal pattern detected. Consider buying.",
      "confidence": 82
    }
  ],
  "summary": {
    "total": 5,
    "bullish": 4,
    "bearish": 1,
    "overall": "Bullish",
    "dominantPattern": "Bullish Breakout"
  },
  "alerts": [
    {
      "type": "Bullish Breakout",
      "signal": "Bullish",
      "message": "Bullish Breakout detected: Price broke above resistance at $225.50 with strong volume.",
      "urgency": "Medium"
    }
  ]
}
```

---

## 📊 Reports

### Generate AI Research Report
```http
POST /reports/:symbol
Content-Type: application/json

{
  "transcriptUrl": "https://... (optional)"
}
```

**Response**: Full AI-generated analysis report

---

## 🔔 Alerts

### Get User Alerts
```http
GET /alerts
```

### Create Alert
```http
POST /alerts
Content-Type: application/json

{
  "symbol": "AAPL",
  "condition": "price_above",
  "value": 230.00,
  "message": "AAPL crossed $230"
}
```

---

## 💼 Portfolio

### Get Portfolio
```http
GET /portfolio
```

### Add Position
```http
POST /portfolio
Content-Type: application/json

{
  "symbol": "AAPL",
  "shares": 100,
  "buyPrice": 225.50
}
```

---

## 🔐 Authentication

### Register
```http
POST /auth/register
Content-Type: application/json

{
  "username": "trader1",
  "password": "securepass123"
}
```

### Login
```http
POST /auth/login
Content-Type: application/json

{
  "username": "trader1",
  "password": "securepass123"
}
```

**Response**:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "username": "trader1"
}
```

---

## 📝 Notes

### Interval Parameters
- `1d` - Daily data (3 months)
- `1wk` - Weekly data (2 years)
- `1mo` - Monthly data (5 years)
- `all` - All available data (10 years)

### Color Codes
- **Green**: `#00c805` (Bullish/Buy)
- **Red**: `#ff5000` (Bearish/Sell)
- **Yellow**: Neutral/Warning

### Confidence Levels
- **High**: 80-100%
- **Medium**: 60-79%
- **Low**: <60%

---

## 🚀 Quick Test

Test all endpoints with this sequence:

```bash
# 1. Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test"}'

# 2. Get stock data
curl http://localhost:3001/api/stocks/AAPL \
  -H "Authorization: Bearer <token>"

# 3. Get signals
curl http://localhost:3001/api/signals/AAPL \
  -H "Authorization: Bearer <token>"

# 4. Get fundamentals
curl http://localhost:3001/api/fundamentals/AAPL \
  -H "Authorization: Bearer <token>"

# 5. Get news sentiment
curl http://localhost:3001/api/news/AAPL \
  -H "Authorization: Bearer <token>"

# 6. Get volume analysis
curl http://localhost:3001/api/volume/AAPL \
  -H "Authorization: Bearer <token>"

# 7. Detect patterns
curl http://localhost:3001/api/patterns/AAPL \
  -H "Authorization: Bearer <token>"
```

---

✅ **All endpoints are protected by JWT authentication except login/register**
