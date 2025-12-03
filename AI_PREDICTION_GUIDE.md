## Daily Batch Job: Best Performing Prediction Stocks & VIX Analysis

This application now includes a daily batch job that analyzes all tradable stocks using all available features (AI, technical signals, portfolio logic, etc.) and incorporates real-time VIX (Volatility Index) data from Yahoo Finance.

### How It Works
- **Batch Job**: Runs once daily, analyzes all stocks, selects the best performers, and sends results via Telegram.
- **VIX Data**: Real-time VIX data is fetched and used to adjust AI trading logic and buy/sell signals.
- **Candlestick Chart Signals**: VIX analysis is fed into buy/sell/hold signals for candlestick chart visualizations.
- **AI Trading**: VIX data is used to adjust confidence and risk in AI trading recommendations.

### Example Output
```
Best Performing Prediction Stocks for 2025-11-10

VIX: 18.5 (1.2%)

1. AAPL - Score: 85 - Signal: BUY - Chart Signal: BUY
2. MSFT - Score: 80 - Signal: BUY - Chart Signal: BUY
3. NVDA - Score: 75 - Signal: BUY - Chart Signal: BUY
4. TSLA - Score: 70 - Signal: HOLD - Chart Signal: HOLD
5. META - Score: 68 - Signal: HOLD - Chart Signal: HOLD
```

### Integration
- The batch job is implemented in `backend/src/batchSendBestPredictions.js`.
- VIX data is fetched in real-time and passed to all AI and signal analysis functions.
- Candlestick chart buy/sell signals now reflect VIX-driven risk adjustments.
- Results are sent via Telegram and can be used for further automation or reporting.

For more details, see the batch job source or ask for code samples.
# AI Prediction System Guide

## Overview
The Stock Analysis Dashboard now features a **real AI/ML prediction system** using Hugging Face's FinBERT model for financial sentiment analysis, with an intelligent fallback to enhanced technical analysis.

## Architecture

### 1. AI Service (`backend/src/services/aiPredictionService.js`)

#### Primary AI Model: Hugging Face FinBERT
- **Model**: `ProsusAI/finbert` - A BERT model fine-tuned on financial text
- **Cost**: FREE (no API key required for basic usage)
- **Purpose**: Analyzes stock sentiment from news and price action
- **Timeout**: 5 seconds (falls back if model is slow/unavailable)

#### Fallback System: Enhanced Technical Analysis
When Hugging Face API is unavailable, the system uses a sophisticated multi-indicator analysis:
- **SMA Analysis**: 5, 10, and 20-day moving averages
- **Price Position**: Current price relative to moving averages
- **Volume Analysis**: Comparing current vs average volume
- **Momentum Calculation**: 5-day price trend strength
- **News Sentiment Integration**: Incorporates sentiment from news service

### 2. API Endpoint

**Route**: `GET /api/ai/prediction/:symbol`

**Authentication**: JWT token required

**Response Format**:
```json
{
  "signal": "Buy|Sell|Hold",
  "confidence": 75,
  "reasoning": "Detailed explanation of the prediction...",
  "model": "huggingface-finbert|technical-fallback",
  "technicalContext": {
    "priceChange": "2.5",
    "volumeTrend": "Above Average",
    "momentum": "Strong Bullish",
    "sma5": 150.25,
    "sma10": 148.50,
    "sma20": 145.75
  }
}
```

### 3. Frontend Component (`frontend/app/components/AIInsight.tsx`)

The AI Insight component now displays:
- **Signal Badge**: Buy/Sell/Hold with confidence percentage
- **Model Indicator**: 🤖 FinBERT AI or 📊 Technical Analysis
- **Confidence Score**: Percentage-based confidence level
- **Detailed Reasoning**: AI-generated explanation
- **Technical Context**: Supporting metrics (price change, volume, momentum, SMAs)

## How It Works

### AI Prediction Flow

1. **User selects a stock** → Dashboard passes symbol to AIInsight component
2. **Frontend calls** `/api/ai/prediction/:symbol`
3. **Backend service**:
   - Fetches recent stock data (30 days)
   - Calculates price change, volume trends, momentum
   - Fetches news sentiment from news service
   - **Attempts Hugging Face FinBERT prediction**:
     - Constructs financial analysis text
     - Sends to FinBERT model
     - Interprets sentiment score
     - Combines with technical indicators
   - **If API fails**: Uses enhanced technical fallback
   - Returns prediction with confidence and reasoning

### Signal Generation Logic

#### Buy Signal Criteria:
- Price increasing (positive % change)
- Volume above average
- Bullish momentum (positive 5-day trend)
- Price above SMA5 and SMA10
- Positive news sentiment (if available)
- FinBERT positive sentiment score

#### Sell Signal Criteria:
- Price decreasing (negative % change)
- Volume patterns suggest distribution
- Bearish momentum (negative 5-day trend)
- Price below key moving averages
- Negative news sentiment
- FinBERT negative sentiment score

#### Hold Signal:
- Mixed or neutral indicators
- Low confidence in either direction
- Conflicting signals

## Configuration

### Optional API Key (for higher rate limits)

While the system works **without an API key**, you can optionally configure one for production:

1. Get a free API key from [Hugging Face](https://huggingface.co/settings/tokens)
2. Create `.env` file in `backend/`:
   ```
   HUGGINGFACE_API_KEY=your_api_key_here
   ```
3. Update `aiPredictionService.js`:
   ```javascript
   headers: {
     'Authorization': `Bearer ${process.env.HUGGINGFACE_API_KEY || ''}`,
     'Content-Type': 'application/json'
   }
   ```

### Model Selection

The service is configured to use FinBERT but can be easily swapped:

**Available Models**:
- `ProsusAI/finbert` (current) - Financial sentiment
- `yiyanghkust/finbert-tone` - Alternative financial BERT
- `distilbert-base-uncased-finetuned-sst-2-english` - General sentiment

To change model, update `HUGGINGFACE_MODEL` constant in `aiPredictionService.js`.

## Advantages Over Previous System

### Old System (EMA Crossover Only):
- ❌ Simple moving average crossover
- ❌ No sentiment analysis
- ❌ No volume consideration
- ❌ No news integration
- ❌ Fixed confidence levels
- ❌ Limited reasoning

### New AI System:
- ✅ Real ML model (FinBERT)
- ✅ Financial text understanding
- ✅ Multi-factor analysis (price, volume, momentum, news)
- ✅ Dynamic confidence scoring
- ✅ Detailed, contextual reasoning
- ✅ Intelligent fallback system
- ✅ Free to use (no API costs)

## Technical Details

### Confidence Calculation

**Hugging Face Mode**:
```javascript
// Based on sentiment score strength
if (score > 0.3) confidence = 75-85% (Strong signal)
if (score > 0.1) confidence = 60-75% (Moderate signal)
else confidence = 50-60% (Weak signal)

// Adjusted by:
- Volume confirmation (+5-10%)
- News sentiment alignment (+5-10%)
- Price momentum strength (+5%)
```

**Fallback Mode**:
```javascript
// Multi-indicator consensus
Base: 50%
+ MA Alignment: +15% (all 3 SMAs agree)
+ Volume Confirmation: +10%
+ Momentum Strength: +10%
+ News Sentiment: +15%

Maximum confidence: 85% (fallback is conservative)
```

### Momentum Calculation

```javascript
function calculateMomentum(prices) {
  // Last 5 days trend
  const recent = prices.slice(-5);
  const older = prices.slice(-10, -5);
  
  const recentAvg = average(recent);
  const olderAvg = average(older);
  
  return ((recentAvg - olderAvg) / olderAvg) * 100;
}

// Classification:
> 2%: Strong Bullish
1-2%: Bullish
-1 to 1%: Neutral
-2 to -1%: Bearish
< -2%: Strong Bearish
```

## Usage Examples

### Example 1: Strong Buy Signal
```json
{
  "signal": "Buy",
  "confidence": 82,
  "reasoning": "FinBERT analysis indicates strong bullish sentiment. Stock has risen 3.2% with 25% above-average volume. Momentum is strongly bullish with price above all key moving averages. Recent positive news sentiment supports the upward trend.",
  "model": "huggingface-finbert",
  "technicalContext": {
    "priceChange": "3.2",
    "volumeTrend": "25% above average",
    "momentum": "Strong Bullish",
    "sma5": 152.30,
    "sma10": 150.15,
    "sma20": 148.90
  }
}
```

### Example 2: Fallback Analysis
```json
{
  "signal": "Hold",
  "confidence": 55,
  "reasoning": "Technical analysis shows mixed signals. Price is up 0.5% but volume is below average. Price is above SMA5 ($150.25) but below SMA10 ($151.30). Neutral momentum suggests waiting for clearer trend confirmation.",
  "model": "technical-fallback",
  "technicalContext": {
    "priceChange": "0.5",
    "volumeTrend": "Below Average",
    "momentum": "Neutral",
    "sma5": 150.25,
    "sma10": 151.30
  }
}
```

## Troubleshooting

### Issue: Always showing fallback mode
**Solution**: 
- Check internet connectivity
- Verify Hugging Face API is accessible
- Check browser console for errors
- API might be temporarily down (this is normal, fallback handles it)

### Issue: Low confidence scores
**Reason**: Stock might have:
- Mixed technical signals
- Low volume trading
- Conflicting news sentiment
- Choppy price action

**This is expected behavior** - the system is designed to be conservative when signals are unclear.

### Issue: Predictions seem delayed
**Expected**: 
- Frontend caches results briefly
- API has 5-second timeout for AI model
- Stock data is fetched in real-time

## Future Enhancements

Potential improvements:
1. **Multiple AI Models**: Ensemble of FinBERT + Technical models
2. **Historical Accuracy Tracking**: Track prediction success rate
3. **Custom Training**: Fine-tune model on your specific stocks
4. **Real-time Updates**: WebSocket for live predictions
5. **Confidence Calibration**: Adjust thresholds based on historical performance
6. **Sector Analysis**: Integrate sector-wide sentiment
7. **Options Data**: Incorporate options flow signals

## Performance Considerations

- **API Response Time**: 1-5 seconds (Hugging Face), <500ms (fallback)
- **Cache Duration**: None currently (each request is fresh)
- **Rate Limits**: ~1000 requests/hour (free tier, varies)
- **Recommended**: Add caching for frequently traded stocks

## Conclusion

The AI Prediction System provides **professional-grade stock analysis** using state-of-the-art NLP models, completely free of charge. The dual-mode approach ensures reliability while maintaining advanced capabilities when AI is available.

The system combines:
- 🤖 **Machine Learning** (FinBERT financial sentiment)
- 📊 **Technical Analysis** (Moving averages, volume, momentum)
- 📰 **News Sentiment** (NLP-based sentiment scoring)
- 💪 **Robust Fallback** (Never fails to provide analysis)

This makes it suitable for both **development** (free, no API keys) and **production** (reliable fallback ensures uptime).
