# Advanced Stock Analysis Trading Platform

A professional-grade stock analysis platform featuring **real AI/ML predictions**, comprehensive technical analysis, and institutional-level insights.

## 🚀 Key Features

### 1. **AI-Powered Predictions** 🤖
- **Real Machine Learning**: Hugging Face FinBERT model for financial sentiment analysis
- **Multi-Factor Analysis**: Combines price action, volume, momentum, and news sentiment
- **Intelligent Fallback**: Enhanced technical analysis when AI is unavailable
- **Free to Use**: No API keys required (optional for higher rate limits)
- **Confidence Scoring**: Dynamic confidence levels based on signal strength
- See [AI_PREDICTION_GUIDE.md](AI_PREDICTION_GUIDE.md) for details

### 2. **Technical Analysis Suite** 📊
- **RSI (Relative Strength Index)**: Overbought/oversold detection
- **MACD**: Trend following and momentum analysis
- **Moving Averages**: SMA 5, 10, 20, 50, 200-day
- **Volume Analysis**: Institutional buying/selling detection
- **Pattern Recognition**: 6 chart patterns (Head & Shoulders, Double Top/Bottom, etc.)
- **Real-time Charting**: Interactive candlestick charts with indicators

### 3. **Fundamental Analysis** 📈
- **Valuation Metrics**: P/E Ratio, PEG Ratio, Price-to-Book
- **Profitability**: EPS, ROE, Profit Margins
- **Growth Indicators**: Revenue growth, earnings growth
- **Analyst Ratings**: Strong Buy/Buy/Hold/Sell consensus
- **Price Targets**: High/Low/Average with upside/downside potential
- **Dividend Information**: Yield and payout ratios

### 4. **News & Sentiment Analysis** 📰
- **Advanced NLP**: 70+ financial keywords with weighted scoring
- **Context Awareness**: Handles negations, intensifiers, and diminishers
- **Historical Tracking**: Daily sentiment trends with visualization
- **Sentiment Summary**: AI-style insights with emoji indicators
- **Article Aggregation**: Multiple news sources with relevance scoring

### 5. **Institutional Money Flow** 💰
- **Order Size Analysis**: XL/Large/Medium/Small order categorization
- **Inflow/Outflow Tracking**: Real-time institutional activity
- **Visual Analytics**: Donut charts and bidirectional bar graphs
- **Net Flow Calculation**: Cumulative institutional positioning
- **Trend Detection**: Bullish/Bearish institutional sentiment

### 6. **Professional UI/UX** ✨
- **Slim Dashboard Design**: Optimized 4:1 grid layout
- **Tabbed Interface**: Chart, Fundamentals, News, Patterns, Money Flow
- **Dark/Light Themes**: Automatic theme switching
- **Responsive Design**: Mobile-friendly layouts
- **Real-time Updates**: Live stock data
- **Clickable Navigation**: Logo returns to dashboard

## 🛠️ Technology Stack

### Backend
- **Node.js** + **Express.js**: RESTful API server
- **Yahoo Finance API**: Real-time stock data (yahoo-finance2 v3.10.0)
- **Hugging Face API**: FinBERT ML model for predictions
- **JWT Authentication**: Secure user sessions
- **In-Memory Caching**: 5-minute TTL for performance

### Frontend
- **Next.js 14**: React framework with App Router
- **TypeScript**: Type-safe development
- **Tailwind CSS**: Utility-first styling
- **Lightweight Charts**: TradingView-quality charts

## 📦 Installation & Quick Start

### Prerequisites
- Node.js 18+ and npm

### Installation

```powershell
# 1. Clone repository (if from git)
git clone <repository-url>
cd SecondProject

# 2. Install backend dependencies
cd backend
npm install

# 3. Install frontend dependencies
cd ../frontend
npm install
cd ..

# 4. Start application (PowerShell)
.\start.ps1
```

### Access Application
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001

### Login
- Navigate to http://localhost:3000/login
- Create account or use demo credentials

## 📖 Usage Guide

### Understanding AI Predictions

The **AI Signal** card shows:
- **Model Badge**: 🤖 FinBERT AI or 📊 Technical Analysis
- **Confidence**: 50-90% based on signal strength
- **Signal**: Strong Buy, Strong Sell, or Neutral/Hold
- **Reasoning**: Detailed explanation
- **Technical Context**: Price change, volume, momentum, SMAs

**Example AI Signal**:
```
Strong Buy | 82% confidence
Model: 🤖 FinBERT AI

"FinBERT analysis indicates strong bullish sentiment. 
Stock has risen 3.2% with 25% above-average volume. 
Momentum is strongly bullish with price above all key 
moving averages."

Technical Context:
• Price Change: 3.2%
• Volume: 25% above average
• Momentum: Strong Bullish
• SMA5: $152.30
```

### Dashboard Tabs

1. **Chart**: Interactive candlestick chart with RSI/MACD
2. **Fundamentals**: Analyst ratings, price targets, valuation
3. **News**: Sentiment analysis and historical trends
4. **Patterns**: Detected chart patterns with confidence
5. **Money Flow**: Institutional order flow analysis

### Stock Search
- Type ticker symbol in top-right search bar
- Press Enter to load stock
- Stock added to watchlist automatically

## 🔧 Configuration (Optional)

### Environment Variables

**Backend** (`backend/.env`):
```env
PORT=3001
JWT_SECRET=your_secret_key
HUGGINGFACE_API_KEY=your_token  # Optional
```

**Frontend** (`frontend/.env.local`):
```env
NEXT_PUBLIC_API_URL=http://localhost:3001
```

### Theme Customization

Edit `frontend/app/globals.css`:
```css
:root {
  --color-success: #10b981;  /* Buy signals */
  --color-danger: #ef4444;   /* Sell signals */
}
```

## 📚 Documentation

- **[API Reference](API_REFERENCE.md)**: Complete API documentation
- **[AI Prediction Guide](AI_PREDICTION_GUIDE.md)**: Deep dive into AI system
- **[Advanced Features](ADVANCED_FEATURES_GUIDE.md)**: Feature overview
- **[Theme Guide](THEME_GUIDE.md)**: Theming system

## 📊 API Quick Reference

### Authentication
```bash
POST /api/auth/register
POST /api/auth/login
```

### Stock Data
```bash
GET /api/stocks/data/:symbol
GET /api/stocks/symbols
POST /api/stocks/symbols
```

### AI Predictions
```bash
GET /api/ai/prediction/:symbol  # New AI endpoint
```

### Signals & Analysis
```bash
GET /api/signals/:symbol
GET /api/indicators/:symbol
GET /api/volume/:symbol
GET /api/fundamentals/:symbol
GET /api/news/:symbol
GET /api/patterns/:symbol
GET /api/money-flow/:symbol
```

### Portfolio
```bash
GET /api/portfolio
POST /api/portfolio
DELETE /api/portfolio/:symbol
```

### Alerts
```bash
GET /api/alerts
POST /api/alerts
DELETE /api/alerts/:id
```

## 🎨 Features Showcase

### AI Prediction System
- ✅ Hugging Face FinBERT integration
- ✅ Multi-factor analysis (price, volume, momentum, news)
- ✅ Free to use (no API key required)
- ✅ Intelligent fallback to technical analysis
- ✅ Dynamic confidence scoring

### Technical Analysis
- ✅ 6 chart patterns with confidence levels
- ✅ RSI, MACD, Moving Averages
- ✅ Volume analysis (above/below average)
- ✅ Momentum calculation (5-day trend)
- ✅ Real-time indicator updates

### Fundamental Analysis
- ✅ Analyst ratings with consensus
- ✅ Price targets with upside/downside
- ✅ P/E, PEG, EPS, ROE metrics
- ✅ Revenue and earnings growth
- ✅ Dividend information

### News Sentiment
- ✅ NLP-based sentiment scoring
- ✅ 70+ financial keywords
- ✅ Context-aware analysis
- ✅ Historical sentiment trends
- ✅ Daily aggregation charts

### Money Flow
- ✅ Institutional order tracking
- ✅ XL/L/M/S order categorization
- ✅ Inflow/Outflow visualization
- ✅ Net flow calculation
- ✅ Bullish/Bearish indicators

## 📂 Project Structure

```
SecondProject/
├── backend/
│   ├── src/
│   │   ├── app.js                  # Express server
│   │   ├── controllers/            # API controllers
│   │   ├── middleware/             # Auth middleware
│   │   ├── routes/                 # API routes
│   │   │   ├── aiRoutes.js        # NEW: AI predictions
│   │   │   ├── fundamentalsRoutes.js
│   │   │   ├── newsRoutes.js
│   │   │   ├── moneyFlowRoutes.js
│   │   │   └── ...
│   │   └── services/               # Business logic
│   │       ├── aiPredictionService.js  # NEW: AI service
│   │       ├── newsSentimentService.js # Enhanced NLP
│   │       ├── fundamentalsService.js
│   │       ├── moneyFlowService.js
│   │       └── ...
│   └── package.json
├── frontend/
│   ├── app/
│   │   ├── components/
│   │   │   ├── AIInsight.tsx      # NEW: AI display
│   │   │   ├── CandlestickChart.tsx
│   │   │   ├── FundamentalsView.tsx
│   │   │   ├── NewsSentimentView.tsx
│   │   │   ├── MoneyFlowView.tsx
│   │   │   └── ...
│   │   ├── dashboard/page.tsx     # Main dashboard
│   │   ├── login/page.tsx
│   │   └── globals.css
│   └── package.json
├── AI_PREDICTION_GUIDE.md          # NEW: AI documentation
├── API_REFERENCE.md
├── ADVANCED_FEATURES_GUIDE.md
├── THEME_GUIDE.md
├── start.ps1                       # PowerShell startup
└── README.md
```

## 🚀 Performance

- **API Response**: 1-5 seconds (AI mode), <500ms (fallback)
- **Chart Rendering**: Real-time with 60fps
- **Data Caching**: 5-minute TTL
- **Memory Usage**: ~150MB backend, ~200MB frontend

## 🔐 Security

- JWT-based authentication
- Token expiration (24 hours)
- Protected API routes
- CORS configuration
- No sensitive data in localStorage (tokens only)

## 🛤️ Roadmap

### Completed ✅
- [x] AI/ML prediction system (FinBERT)
- [x] Technical indicators (RSI, MACD)
- [x] Volume analysis
- [x] Fundamental analysis with analyst ratings
- [x] News sentiment with NLP
- [x] Pattern detection (6 patterns)
- [x] Institutional money flow
- [x] Slim dashboard redesign
- [x] Dark/Light theme

### Planned 🔜
- [ ] Real-time WebSocket data
- [ ] Historical prediction accuracy tracking
- [ ] Backtesting engine
- [ ] Multiple AI model ensemble
- [ ] Options flow analysis
- [ ] Sector-wide analysis
- [ ] Custom alerts via email/SMS
- [ ] Mobile app (React Native)

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create feature branch
3. Commit changes
4. Push to branch
5. Open Pull Request

## 📝 License

MIT License - See LICENSE file

## 🆘 Troubleshooting

### "AI always showing fallback mode"
- Check internet connectivity
- Hugging Face API might be temporarily down (normal)
- Fallback system ensures continuous operation

### "Low confidence scores"
- Stock has mixed technical signals (expected behavior)
- System is conservative when signals are unclear
- This prevents false predictions

### "Port already in use"
- Stop existing servers: `Ctrl+C`
- Or change ports in .env files

### "Login not working"
- Check backend is running on port 3001
- Clear localStorage and try again
- Create new account

## 📧 Support

For issues or questions:
1. Check [AI_PREDICTION_GUIDE.md](AI_PREDICTION_GUIDE.md)
2. Review [API_REFERENCE.md](API_REFERENCE.md)
3. Open GitHub issue

---

**Happy Trading! 🚀📈**

*Built with ❤️ using Next.js, Node.js, and Hugging Face AI*
