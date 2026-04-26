require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

// ─── DATA PROVIDER PATCH ─────────────────────────────────────────────────────
// When DATA_PROVIDER != yahoo, intercept every yahooFinance.quote() and
// yahooFinance.chart() call across ALL services and route them through the
// active dataProvider (Alpaca/Polygon) so real-time prices appear everywhere.
// Must run before any service is required.
;(function patchYahooFinance() {
    const provider = (process.env.DATA_PROVIDER || 'yahoo').toLowerCase();
    if (provider === 'yahoo') return; // no patch needed

    const YahooFinance = require('yahoo-finance2').default;
    const proto = YahooFinance.prototype;

    // --- quote() → dataProvider.getQuote() ---
    const _origQuote = proto.quote;   // save original before overwriting
    const _origChart = proto.chart;   // save original before overwriting
    proto.quote = async function(symbol) {
        // Index symbols (^VIX, ^GSPC) go direct to Yahoo — Alpaca doesn't support them
        if (symbol.startsWith('^') || symbol.startsWith('=')) {
            return _origQuote.call(this, symbol);
        }
        try {
            const dp = require('./services/dataProvider');
            const q  = await dp.getQuote(symbol);
            // Return in yahoo-finance2 shape so callers need no changes
            return {
                symbol,
                regularMarketPrice:         q.price,
                regularMarketChange:        q.change,
                regularMarketChangePercent: q.changePercent,
                regularMarketVolume:        q.volume,
                averageDailyVolume10Day:    q.avgVolume,
                marketCap:                  q.marketCap  || 0,
                fiftyTwoWeekHigh:           q.high52w    || q.price,
                fiftyTwoWeekLow:            q.low52w     || q.price,
                sector:                     q.sector     || null,
                exchange:                   q.exchange   || null,
                preMarketPrice:             null,
                postMarketPrice:            null
            };
        } catch (e) {
            console.warn(`[DataPatch] quote(${symbol}) failed, no fallback:`, e.message);
            return { regularMarketPrice: 0, symbol };
        }
    };

    // --- chart() → dataProvider.getBars() ---
    proto.chart = async function(symbol, opts = {}) {
        // Index symbols (^VIX, ^GSPC) go direct to Yahoo
        if (symbol.startsWith('^') || symbol.startsWith('=')) {
            return _origChart.call(this, symbol, opts);
        }
        // Some callers pass { interval, period1, period2 } or { interval, range }
        // We translate to dataProvider.getBars(symbol, interval, lookbackDays)
        try {
            const dp = require('./services/dataProvider');
            const interval    = opts.interval || '1d';
            let lookbackDays  = 90;
            if (opts.period1) {
                const diff = Date.now() - new Date(opts.period1).getTime();
                lookbackDays = Math.ceil(diff / 86400000) + 5;
            } else if (opts.range) {
                const rangeMap = { '1d': 2, '5d': 6, '1mo': 35, '3mo': 95, '6mo': 185, '1y': 370, '2y': 730, '5y': 1830 };
                lookbackDays = rangeMap[opts.range] || 90;
            }
            const bars = await dp.getBars(symbol, interval, lookbackDays);
            // Return in yahoo-finance2 chart shape: { quotes: [{date,open,high,low,close,volume}] }
            return {
                quotes: bars.map(b => ({
                    date:   new Date(b.time),
                    open:   b.open,
                    high:   b.high,
                    low:    b.low,
                    close:  b.close,
                    volume: b.volume
                }))
            };
        } catch (e) {
            console.warn(`[DataPatch] chart(${symbol}) failed, no fallback:`, e.message);
            return { quotes: [] };
        }
    };

    console.log(`[DataPatch] yahoo-finance2 patched → routing quote()+chart() through ${provider.toUpperCase()}`);
})();

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
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
const recommendationRoutes = require('./routes/recommendationRoutes');
const enhancedAITradingRoutes = require('./routes/enhancedAITradingRoutes');
const earningsRoutes = require('./routes/earningsRoutes');
const newsAlertsRoutes = require('./routes/newsAlertsRoutes');
const newsAggregationRoutes = require('./routes/newsAggregationRoutes');
const backtestRoutes = require('./routes/backtestRoutes');
const swingTradingRoutes = require('./routes/swingTradingRoutes');
const optionsRoutes = require('./routes/optionsRoutes');
const scalpingRoutes = require('./routes/scalpingRoutes');
const scenarioRoutes = require('./routes/scenarioRoutes');
const screenerRoutes = require('./routes/screenerRoutes');
const enhancedSignalRoutes = require('./routes/enhancedSignalRoutes');
const watchlistRoutes = require('./routes/watchlistRoutes');
const optionsBotRoutes = require('./routes/optionsBotRoutes');
const performanceRoutes = require('./routes/performanceRoutes');
const aiTradingScheduler = require('./services/aiTradingScheduler');
const enhancedAIScheduler = require('./services/enhancedAIScheduler');
const optionsScheduler = require('./services/optionsScheduler');
const optionsBotScheduler = require('./services/optionsBotScheduler');
const newsMonitoringService = require('./services/newsMonitoringService');
const { pool } = require('./config/database');
// Load enhanced Telegram weekly report scheduler
require('./scheduleTelegramReport');

const app = express();

function isLocalOrDevRequest(req) {
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }

  const forwardedFor = req.headers['x-forwarded-for'];
  const rawIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : (forwardedFor || req.ip || req.connection?.remoteAddress || '');

  const ip = String(rawIp).trim();
  return (
    ip === '127.0.0.1' ||
    ip === '::1' ||
    ip === '::ffff:127.0.0.1' ||
    ip.startsWith('192.168.') ||
    /^10\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)
  );
}

// --- Security & performance middleware ---
app.use(helmet({
  contentSecurityPolicy: false, // disabled so the Next.js frontend can load freely
  crossOriginEmbedderPolicy: false
}));
app.use(compression());

// Trusted origins for CORS (read from env in production)
const TRUSTED_ORIGINS = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const LOCAL_NET_RE = /^https?:\/\/192\.168\.\d+\.\d+(:\d+)?$/;

app.use(cors({
  origin: function (origin, callback) {
    // Same-origin / mobile / curl (no Origin header)
    if (!origin) return callback(null, true);
    // Localhost always allowed (development)
    if (LOCALHOST_RE.test(origin)) return callback(null, true);
    // LAN IPs always allowed (development)
    if (LOCAL_NET_RE.test(origin)) return callback(null, true);
    // Explicitly whitelisted origins from env
    if (TRUSTED_ORIGINS.includes(origin)) return callback(null, true);
    // Any IP-based origin — allow in non-production (covers external IP during dev/paper trading)
    if (process.env.NODE_ENV !== 'production') return callback(null, true);

    // Return 403 properly instead of crashing with 500
    const err = new Error(`CORS: origin '${origin}' not allowed`);
    err.status = 403;
    callback(err);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 600,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));
app.options('*', cors());

// --- Rate limiting ---
// Global: 300 req / 15 min per IP (generous for a personal app)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  skip: (req) => isLocalOrDevRequest(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});
app.use(globalLimiter);

// Tighter limit on auth endpoints to block brute-force
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  skip: (req) => isLocalOrDevRequest(req),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again in 15 minutes.' }
});
app.use('/api/auth', authLimiter);

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
app.use('/api/recommendations', recommendationRoutes);
app.use('/api/enhanced-ai-trading', enhancedAITradingRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/news-alerts', newsAlertsRoutes);
app.use('/api/news-aggregation', newsAggregationRoutes);
app.use('/api/backtest', backtestRoutes);
app.use('/api/swing-trading', swingTradingRoutes);
app.use('/api/options', optionsRoutes);
app.use('/api/scalping', scalpingRoutes);
app.use('/api/scenarios', scenarioRoutes);
app.use('/api/screener', screenerRoutes);
app.use('/api/enhanced-signals', enhancedSignalRoutes);
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/options-bot', optionsBotRoutes);
app.use('/api/performance', performanceRoutes);

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/health', async (req, res) => {
    const { pool } = require('./config/database');
    let dbOk = false;
    try {
        await pool.query('SELECT 1');
        dbOk = true;
    } catch (_) { /* db down */ }

    const status = dbOk ? 'ok' : 'degraded';
    res.status(dbOk ? 200 : 503).json({
        status,
        timestamp: new Date().toISOString(),
        uptime:    Math.round(process.uptime()),
        db:        dbOk ? 'connected' : 'unreachable',
        broker:    process.env.BROKER     || 'simulated',
        provider:  process.env.DATA_PROVIDER || 'yahoo',
        botEnabled: process.env.BOT_ENABLED !== 'false'
    });
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server is running on ${HOST}:${PORT}`);
  console.log('✓ PostgreSQL database connected');
  
  // Start ENHANCED AI Trading automated scheduler (analyzes ALL stocks)
  console.log('\n🤖 Starting Enhanced AI Trading Bot...');
  enhancedAIScheduler.startScheduler();
  
  // Keep old scheduler for backward compatibility
  // aiTradingScheduler.startScheduler();
  
  // Start Options scanner scheduler
  optionsScheduler.startOptionsScheduler();
  
  // Start Autonomous Options Trading Bot
  console.log('\n⚡ Starting Autonomous Options Trading Bot...');
  optionsBotScheduler.startOptionsScheduler();
  
  // Start News monitoring service
  const defaultSymbols = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA', 'NVDA', 'META', 'NFLX'];
  newsMonitoringService.startNewsMonitoring(defaultSymbols);
  
  // Enhanced Telegram weekly report scheduler is loaded via require('./scheduleTelegramReport')
  // It auto-sends on startup and schedules Monday & Wednesday 6 AM EST
});
