const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const authRoutes = require('./routes/authRoutes');
const stockRoutes = require('./routes/stockRoutes');
const reportRoutes = require('./routes/reportRoutes');
const indicatorRoutes = require('./routes/indicatorRoutes');
const alertRoutes = require('./routes/alertRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const signalRoutes = require('./routes/signalRoutes');
const fundamentalsRoutes = require('./routes/fundamentalsRoutes');
const newsRoutes = require('./routes/newsRoutes');
const volumeRoutes = require('./routes/volumeRoutes');
const patternRoutes = require('./routes/patternRoutes');
const moneyFlowRoutes = require('./routes/moneyFlowRoutes');
const aiRoutes = require('./routes/aiRoutes');
const weeklyRoutes = require('./routes/weeklyRoutes');
const profileRoutes = require('./routes/profileRoutes');
const tradingRoutes = require('./routes/tradingRoutes');
const aiTradingRoutes = require('./routes/aiTradingRoutes');
const earningsRoutes = require('./routes/earningsRoutes');
const newsAlertsRoutes = require('./routes/newsAlertsRoutes');
const backtestRoutes = require('./routes/backtestRoutes');
const swingTradingRoutes = require('./routes/swingTradingRoutes');
const optionsRoutes = require('./routes/optionsRoutes');
const scalpingRoutes = require('./routes/scalpingRoutes');
const scenarioRoutes = require('./routes/scenarioRoutes');
const screenerRoutes = require('./routes/screenerRoutes');
const aiTradingScheduler = require('./services/aiTradingScheduler');
const optionsScheduler = require('./services/optionsScheduler');
const newsMonitoringService = require('./services/newsMonitoringService');

const app = express();

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    // Allow localhost and common development origins
    const allowedOrigins = [
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://192.168.1.206:3000',
      'http://99.47.183.33:3000'
    ];
    
    // Allow any origin that ends with common ports (for dynamic IPs)
    if (origin.match(/^https?:\/\/.*:3000$/)) {
      return callback(null, true);
    }
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    console.log(`CORS blocked origin: ${origin}`);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));
app.options('*', cors());
app.use(bodyParser.json());

// Middleware to log client IP addresses
app.use((req, res, next) => {
  const clientIP = req.ip || 
                   req.connection.remoteAddress || 
                   req.socket.remoteAddress ||
                   (req.connection.socket ? req.connection.socket.remoteAddress : null);
  
  const forwardedFor = req.headers['x-forwarded-for'];
  const realIP = req.headers['x-real-ip'];
  
  // Get the most accurate IP
  const ip = realIP || 
             (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) || 
             clientIP;
  
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - IP: ${ip} - User-Agent: ${req.get('User-Agent') || 'Unknown'}`);
  
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/stocks', stockRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/indicator', indicatorRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/signals', signalRoutes);
app.use('/api/fundamentals', fundamentalsRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/volume', volumeRoutes);
app.use('/api/patterns', patternRoutes);
app.use('/api/moneyflow', moneyFlowRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/weekly', weeklyRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/trading', tradingRoutes);
app.use('/api/ai-trading', aiTradingRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/news-alerts', newsAlertsRoutes);
app.use('/api/backtest', backtestRoutes);
app.use('/api/swing-trading', swingTradingRoutes);
app.use('/api/options', optionsRoutes);
app.use('/api/scalping', scalpingRoutes);
app.use('/api/scenarios', scenarioRoutes);
app.use('/api/screener', screenerRoutes);

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server is running on ${HOST}:${PORT}`);
  
  // Start AI Trading automated scheduler
  aiTradingScheduler.startScheduler();
  
  // Start Options scanner scheduler
  optionsScheduler.startOptionsScheduler();
  
  // Start News monitoring service
  const defaultSymbols = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA', 'NVDA', 'META', 'NFLX'];
  newsMonitoringService.startNewsMonitoring(defaultSymbols);
});
