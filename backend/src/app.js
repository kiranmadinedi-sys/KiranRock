require('./bootstrapRuntime');

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
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
const stockFeedRoutes = require('./routes/stockFeedRoutes');
const systemRoutes = require('./routes/systemRoutes'); // Import the new system routes
const assetUniverseRoutes = require('./routes/assetUniverseRoutes');
const dailySignalsRoutes  = require('./routes/dailySignalsRoutes');
const localdataRoutes = require('./routes/localdataRoutes'); // Localdata tickers endpoint
const enquiryRoutes = require('./routes/enquiryRoutes'); // AI Enquiry endpoint
const { requestTracing } = require('./middleware/requestTracing');
const { pool } = require('./config/database');
const { getWorkerStatus } = require('./services/workerCoordinationService');
const { buildHealthResponse } = require('./services/healthStatusService');
const { buildWeeklyPredictionCacheKey } = require('./services/weeklyPredictionService');
const { getWeeklyPredictionSnapshotStatus } = require('./services/weeklyPredictionSnapshotService');
const { getReportSchedulerStatus } = require('./services/reportSchedulerStatusService');

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

// --- Serve static presentations from project root ---
const path = require('path');
app.use(express.static(path.join(__dirname, '../../'), {
  index: false, // don't auto-serve index.html for /
  dotfiles: 'deny',
  extensions: ['html']
}));

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

// Structured request tracing: assigns correlationId, sets X-Correlation-Id header,
// logs every response via Winston (health-poll paths sampled to reduce noise).
app.use(requestTracing);

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
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
app.use('/api/stock-feed', stockFeedRoutes);
app.use('/api/system', systemRoutes); // Use the new system routes
app.use('/api/asset-universe', assetUniverseRoutes);
app.use('/api/daily-signals', dailySignalsRoutes);
app.use('/api', localdataRoutes); // Register /api/localdata/tickers
app.use('/api', enquiryRoutes); // Register /api/enquiry

// --- Health Check & Status Endpoints ---
app.get('/health', async (req, res) => {
    const { pool } = require('./config/database');
    let dbOk = false;
  let workerStatus = {
    present: false,
    healthy: false,
    status: 'unknown'
  };

    try {
        await pool.query('SELECT 1');
        dbOk = true;
    } catch (_) { /* db down */ }

  if (dbOk) {
    try {
      workerStatus = await getWorkerStatus();
    } catch (error) {
      workerStatus = {
        present: false,
        healthy: false,
        status: 'error',
        error: error.message
      };
    }
  }

  const reportSnapshot = getWeeklyPredictionSnapshotStatus(
    buildWeeklyPredictionCacheKey({
      limit: Math.max(10, Number.parseInt(process.env.TELEGRAM_REPORT_FETCH_LIMIT || '25', 10) || 25),
      minScore: 60,
      universe: (process.env.TELEGRAM_REPORT_PRIMARY_UNIVERSE || 'ALL').toUpperCase()
    }),
    Math.max(30 * 60 * 1000, Number.parseInt(process.env.TELEGRAM_REPORT_SNAPSHOT_MAX_AGE_MS || `${12 * 60 * 60 * 1000}`, 10) || (12 * 60 * 60 * 1000))
  );

  const reportScheduler = getReportSchedulerStatus();

    const response = buildHealthResponse({
      dbOk,
      workerStatus,
      reportSnapshot,
      reportScheduler,
      uptimeSeconds: process.uptime(),
      timestamp: new Date().toISOString(),
      env: {
        NODE_ENV:      process.env.NODE_ENV,
        BROKER:        process.env.BROKER,
        DATA_PROVIDER: process.env.DATA_PROVIDER,
        ALPACA_PAPER:  process.env.ALPACA_PAPER,
        BOT_ENABLED:   process.env.BOT_ENABLED
      }
    });

    res.status(response.httpStatus).json(response.body);
});

// Global error handlers — prevent silent crashes from unhandled rejections
process.on('unhandledRejection', (reason) => {
  const { logger } = require('./utils/logger');
  logger.error('[App] Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack:  reason instanceof Error ? reason.stack : undefined
  });
});

process.on('uncaughtException', (err) => {
  const { logger } = require('./utils/logger');
  logger.error('[App] Uncaught exception — process will continue', {
    error: err.message,
    stack: err.stack
  });
});

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Server is running on ${HOST}:${PORT}`);
  console.log('✓ PostgreSQL database connected');
});

// ── Worker watchdog ───────────────────────────────────────────────────────────
// Runs in the backend (PM2-managed) so it keeps firing even when the worker
// process dies.  Sends a Telegram alert when the worker heartbeat goes stale
// and a recovery alert when it comes back.
{
  const { query: _wdQuery } = require('./config/database');
  const { sendTelegramMessage } = require('./services/telegramAlertService');
  const { logger: _wdLog } = require('./utils/logger');
  const CHAT_ID      = process.env.TELEGRAM_CHAT_ID || '';
  const STALE_MS     = 10 * 60 * 1000; // 10 min
  const CHECK_MS     = 5  * 60 * 1000; // check every 5 min
  let _workerDownAlerted = false;

  setInterval(async () => {
    if (!CHAT_ID) return;
    try {
      const r = await _wdQuery(
        `SELECT heartbeat_at FROM worker_runtime_status ORDER BY heartbeat_at DESC LIMIT 1`
      );
      const hb = r.rows[0]?.heartbeat_at;
      const ageMs = hb ? Date.now() - new Date(hb).getTime() : Infinity;

      if (ageMs > STALE_MS && !_workerDownAlerted) {
        _workerDownAlerted = true;
        const ageMin = Math.round(ageMs / 60000);
        _wdLog.warn('[Watchdog] Worker heartbeat stale — sending Telegram alert', { ageMin });
        await sendTelegramMessage(CHAT_ID,
          `⚠️ *Worker DOWN*\nHeartbeat is ${ageMin} min old — trading bot, schedulers, and alerts are paused.\n\nRestart: run \`start.ps1\` as Administrator.`
        );
      } else if (ageMs <= STALE_MS && _workerDownAlerted) {
        _workerDownAlerted = false;
        _wdLog.info('[Watchdog] Worker heartbeat recovered');
        await sendTelegramMessage(CHAT_ID,
          `✅ *Worker RECOVERED*\nHeartbeat is fresh — trading bot and schedulers are running again.`
        );
      }
    } catch (err) {
      _wdLog.warn('[Watchdog] Could not check worker heartbeat', { err: err.message });
    }
  }, CHECK_MS);
}
