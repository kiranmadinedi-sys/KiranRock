# KiranRock AI Trading Platform — Feature Reference

> **Last updated:** 2026-07-07  
> **Stack:** Node.js + Express (backend) · Next.js 14 App Router (frontend) · PostgreSQL · PM2  
> **Data providers:** Polygon.io (primary) · Yahoo Finance (fallback) · Alpaca (brokerage)  
> **Ports:** Backend `3001` · Frontend `3000`

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Data Infrastructure](#2-data-infrastructure)
3. [Trading Bots](#3-trading-bots)
4. [Nightly Scan Engine](#4-nightly-scan-engine)
5. [Risk Management](#5-risk-management)
6. [Performance & Analytics](#6-performance--analytics)
7. [Options System](#7-options-system)
8. [Alerts & Notifications](#8-alerts--notifications)
9. [UI Pages & Navigation](#9-ui-pages--navigation)
10. [Market Intelligence](#10-market-intelligence)
11. [Database Tables](#11-database-tables)
12. [Scheduled Jobs (Cron)](#12-scheduled-jobs-cron)
13. [API Endpoints Reference](#13-api-endpoints-reference)
14. [Known Limitations & Roadmap](#14-known-limitations--roadmap)
15. [Signal & Pick Logic — Deep Dive](#15-signal--pick-logic--deep-dive)
16. [Session Updates — 2026-07-06](#16-session-updates--2026-07-06)

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Frontend  (Next.js 14, port 3000)                              │
│  18+ pages · Dark/Light theme · JWT auth · Telegram-linked      │
└────────────────────────┬────────────────────────────────────────┘
                         │ REST API
┌────────────────────────▼────────────────────────────────────────┐
│  Backend  (Express, port 3001, PM2-managed)                     │
│  35+ route files · 20+ services · WebSocket broadcasts          │
└──────┬──────────┬──────────┬──────────┬──────────┬─────────────┘
       │          │          │          │          │
  PostgreSQL  Polygon.io  Alpaca    Yahoo Fin.  Telegram
  (primary    (market     (broker:  (fallback)  (alerts)
   storage)    data)      paper+live)
```

**Process management:** Single PM2 process (`kiranrock-backend`). Frontend runs separately via `npm start`.

**Authentication:** JWT tokens stored in `localStorage`. `AuthGuard` middleware protects all pages. Token cookie set alongside localStorage for SSR middleware.

---

## 2. Data Infrastructure

### 2.1 Local Data Warehouse — `daily_bars`

- **112,000+ rows** of OHLCV daily bar data across all traded symbols
- **Cache-first strategy:** `localProvider` serves from DB; only fetches from Polygon when tail is missing
- **Delta-fetch:** On subsequent calls, only fetches days not yet in the DB (no full re-pull)
- **Post-scan backfill:** After nightly scan completes, missing bars for newly encountered symbols are backfilled
- **Source:** `backend/src/services/dataProvider.js` → `localProvider`

### 2.2 Fundamentals Cache — `fundamentals_cache`

- Company fundamentals (P/E, market cap, sector, EPS, revenue growth) stored per symbol
- Populated during nightly scan; serves from DB during trading hours
- Avoids per-request external fundamentals calls

### 2.3 Sector Learning Cache — `sectorLearnedCache.json`

- Auto-discovers sector for tickers not in the built-in sector map
- Saved to `backend/src/services/sectorLearnedCache.json` on each new discovery
- Expanded sector map covers 200+ tickers across 11 GICS sectors

### 2.4 Options Data

- **`options_chain_cache`** — Rolling cache: one row per symbol, always the freshest intraday fetch
- **`options_chain_history`** — Append-only historical record: one row per (symbol, date, expiration, type, strike). Every fetched contract is persisted here permanently, building a long-term IV and options price dataset

### 2.5 Data Provider Routing

```
DATA_PROVIDER=polygon (current setting)

getOptionsChain  → Polygon /v3/snapshot/options (requires Options tier — NOT on current plan)
                 → Yahoo Finance fallback (rate-limited during heavy usage)
getBars          → Local DB first → Polygon on cache miss
getQuote         → Alpaca IEX (real-time during market hours) → Polygon (15-min delayed)
```

---

## 3. Trading Bots

### 3.1 Enhanced AI Stock Bot

**File:** `backend/src/services/enhancedAITradingBot.js`  
**Scheduler:** `backend/src/services/tradingScheduler.js`  
**Scan times (ET):** 10:00, 11:00, 12:00, 13:30, 14:30, 15:15  

**Entry flow:**
1. Pulls nightly scan results (`daily_universe_analysis` table) as the candidate universe
2. Checks market regime (BULL/BEAR/NEUTRAL) and ATLAS global sentiment
3. Filters by: regime gate → earnings guard → RS filter → cash guard → position limits
4. Scores each candidate (AI score 0–100 from nightly scan)
5. Executes BUY via Alpaca if score ≥ threshold
6. Writes entry to `trades` + `trade_decision_journal` (TDJ) with full metadata

**Exit flow:**
- Stop-loss and take-profit orders placed at entry
- Monitored every 5 minutes
- On close: writes outcome (win/loss/breakeven), exitReason, dteAtExit, atrPct to TDJ

**Key guards (all configurable per user):**
- **Cash guard:** Blocks new positions if account cash < minimum threshold
- **Earnings guard:** Skips stocks with earnings within 3 days
- **RS filter:** Requires relative strength vs SPY above configurable floor
- **Fractional shares:** Enables sub-$1 position sizing for high-priced stocks
- **Max open positions:** Configurable per-user limit
- **Max daily loss:** Hard stop on total daily drawdown

**Paper vs Live:** Controlled by `alpaca_paper` flag per user. Paper uses Alpaca paper credentials; live uses live credentials. Options bot currently restricted to paper accounts only.

### 3.2 Options Bot

**File:** `backend/src/services/autonomousOptionsBot.js`  
**Scheduler:** `backend/src/services/optionsBotScheduler.js`  
**Scan times (ET):** 9:45, 11:00, 13:00, 15:00  

**Strategies:**
| Strategy | Allocation | Target | Status |
|---|---|---|---|
| Directional Swing | 40% | +35% per trade | Enabled |
| Credit Spreads | 20% | +15% per trade | Enabled |
| Delta-Neutral Scalping | 30% | +20% per trade | Disabled (needs precise Greeks) |
| Protective Puts | 10% | Hedge | Disabled |

**Universe:** Top 20 STRONG BUY/BUY signals from latest nightly scan; falls back to default 10 liquid stocks (SPY, QQQ, AAPL, MSFT, NVDA, AMZN, AMD, META, TSLA, PANW).

**Data pipeline:**
- Pre-market warmup at 8:00 AM ET: fetches options chains for all universe symbols, saves to `options_chain_cache` and `options_chain_history`
- Trading session: reads from cache first (23-hour window) — no live API calls during market hours
- Evening refresh at 6:00 PM ET

**Current limitation:** Polygon subscription does not include the Options data tier (HTTP 403 on `/v3/snapshot/options`). Yahoo Finance fallback is rate-limited during heavy usage. Bot will execute once Polygon Options tier is activated or Yahoo rate limit clears during off-peak warmup.

**Stored trades:** `options_trades` table (paper account only).

### 3.3 Swing Trading Bot

**File:** `backend/src/services/swingTradingService.js`  
**Page:** `/swing-trading`  
Longer hold periods (2–14 days). Uses the same nightly scan signals as the main bot but with wider stops and larger position sizes for swing setups.

### 3.4 Scalping Bot

**File:** `backend/src/services/scalpingService.js`  
**Page:** `/scalping`  
Intraday mean-reversion and momentum scalps. Uses 5-minute bars from Polygon.

### 3.5 Trade Intelligence Layer

**File:** `backend/src/services/tradeIntelligenceService.js`  

- **Expectancy-based score adjustment:** Historical win-rate and average return per (botType, setupFamily, regime) feed a multiplier that adjusts the bot's entry score up/down
- **Candidate recording:** Every evaluated setup (even rejected ones) is logged to `trade_candidates` for ML training
- **`getExpectancyAdjustment()`:** Returns `{ scoreAdjustment, sizeMultiplier, expectancy, confidence }` based on 30+ historical trades in the same category

---

## 4. Nightly Scan Engine

**File:** `backend/src/services/nightlyScanService.js`  
**Cron:** Runs nightly after market close (configurable, typically 6–8 PM ET weekdays)  
**Output table:** `daily_universe_analysis`

**Scan flow:**
1. Pulls watchlist + sector universe (~200 symbols)
2. For each symbol: fetches bars, runs 20+ technical indicators
3. Computes composite AI score (0–100) from weighted signals
4. Generates recommendation: STRONG BUY / BUY / HOLD / SELL / STRONG SELL
5. Writes one row per symbol per date to `daily_universe_analysis`
6. Triggers post-scan backfill of missing `daily_bars` rows
7. Sends morning briefing summary via Telegram

**Date lookback:** 4-day lookback on `analysis_date` to handle weekends and holidays.

**Indicators used:** RSI, MACD, Bollinger Bands, ATR, OBV, EMA crossovers, Volume surge, Sector momentum, Relative Strength vs SPY, Earnings proximity check.

---

## 5. Risk Management

### Per-Trade Controls
- **Stop-loss:** Configurable % (default 8%); placed as Alpaca bracket order at entry
- **Take-profit:** Configurable % (default 20%)
- **Trailing stop:** Optional, activates after take-profit threshold is approached
- **ATR-based sizing:** Position size scales with ATR to maintain constant risk per trade

### Account-Level Controls
- **Cash guard:** `brokerService.js` checks available cash before any new order — blocks if below minimum to prevent over-deployment
- **Max open positions:** Hard cap per user (default 5 stock + 5 options)
- **Max daily loss:** If total day's P&L exceeds configured loss, all bots halt for the day
- **Margin guard:** Blocks orders that would require margin usage (paper/live)

### Market-Level Controls
- **Market regime gate:** Reduces position sizes in BEAR regime; raises score threshold
- **ATLAS global sentiment gate:** Blocks or scales down in RISK_OFF / BEARISH global conditions
- **VIX gate (options):** Options bot checks VIX regime (LOW/NORMAL/HIGH/EXTREME) and adjusts strategy mix
- **Earnings guard:** Queries `earnings_calendar` table; blocks entry within 3 days of earnings

### Adaptive Position Management (added 2026-07-06 — see [§16](#16-session-updates--2026-07-06) for full detail)
- **Quality Score Decay:** Open positions are periodically re-scored (~every 20h) with the same PANTHEON engine used at entry. Score <65 for 2 consecutive re-scores forces an exit; intermediate tiers progressively tighten the trailing stop.
- **Portfolio Heat Gate:** Aggregate dollar-risk-to-stop across all open + newly-sized positions is capped as a % of equity (`MAX_PORTFOLIO_RISK_PCT`, default 2.5%). New positions shrink to fit remaining budget rather than being rejected outright.
- **Regime Transition Response:** On a detected regime *downgrade* (not just any change), pending buy orders are cancelled immediately and trailing stops get an extra temporary tightening — rather than waiting for the next scheduled re-evaluation.

---

## 6. Performance & Analytics

### 6.1 Performance Page (`/performance`)

**File:** `frontend/app/performance/page.tsx`  
**Backend:** `backend/src/routes/performanceRoutes.js`

**Sections:**

#### Daily History Table
- P&L per day, cumulative, win rate, best/worst trade
- Filterable by date range

#### Trade Attribution (`GET /api/performance/trade-attribution`)
Queries closed rows in `trade_decision_journal`. Returns per-trade data + 7 aggregation dimensions:

| Tab | Groups by | Extras |
|---|---|---|
| Score Bucket | <80 / 80-84 / 85-89 / 90-94 / 95-100 | — |
| Confidence | high/medium/low | — |
| Sector | GICS sector | — |
| Regime | BULL/BEAR/NEUTRAL | — |
| Exit Reason | stopped_out/target_hit/manual/untagged | +5d drift, +10d drift |
| Hold Period | 0-1d / 2-3d / 4-7d / 8-14d / 15+d | — |
| Trade List | Per-trade rows | post-exit drift |

**Expectancy column (%):**  
`Expectancy% = (WinRate × AvgWin%) − (LossRate × |AvgLoss%|)`  
Expressed in percentage units, not dollar amounts.

#### Post-Exit Drift Analysis
- For each closed trade: looks up `daily_bars` 5 and 10 trading days after exit
- Computes `(post_exit_price − exit_price) / exit_price × 100`
- Positive drift = stock kept rising after we sold (left money on table)
- Negative drift = stock fell after we sold (good exit)
- Color coding is inverted: green = stock fell (we exited well), red = stock rose

#### Exit Quality Dashboard
Banner in the Exit Reason tab showing auto-generated verdicts:
- `stopped_out` avg 10d drift > +2% → "Stops may be too tight"
- `stopped_out` avg 10d drift < −2% → "Stop timing effective"
- `target_hit` avg 10d drift > +2% → "Targets too conservative — stock kept moving"

#### Weekly Reports
**Auto-generated every Friday at 3:45 PM ET** by `backend/src/services/weeklyReportService.js`  
Stored permanently in `weekly_performance_reports` table. Browsable by week via the `/weekly` page.

Report includes: week summary, P&L, win rate, best/worst trades, sector breakdown, regime context, AI insights.

### 6.2 Trade Decision Journal (TDJ)

**Table:** `trade_decision_journal`  
Written on every bot decision (entry, monitoring, exit). Fields include:
- `bot_type`, `decision_phase` (ENTRY/MONITORING/CLOSED)
- `symbol`, `score`, `confidence`, `regime`
- `setup_family`, `strategy_family`
- `pnl`, `pnl_percent`, `outcome` (win/loss/breakeven)
- `exit_price`, `closed_at`, `hold_days`
- `win_loss_reason`, `dte_at_exit`, `atr_pct`, `bull_bear_ratio`
- `metadata` (JSONB): sector, exitReason, autoTags, atlasLabel, ivRankLabel, etc.

### 6.3 `trade_attribution` DB View

Lazily created on first call to `/api/performance/trade-attribution`. Provides a SQL-queryable view over closed TDJ rows with all computed fields — useful for ad-hoc analysis.

---

## 7. Options System

### 7.1 Options Chain Viewer (`/options-chain`)

**File:** `frontend/app/options-chain/page.tsx`  
**Backend:** `GET /api/options/chain?symbol=AAPL&expiration=<unix_ts>`

**Features:**
- Ticker search → Load
- Expiration date tabs (horizontal scroll, green = selected)
- Three view modes:
  - **Side-by-Side:** OI | Vol | IV | **Bid** | **Ask** || Strike || **Bid** | **Ask** | IV | Vol | OI
  - **Calls only:** Full details table, sorted by strike descending
  - **Puts only:** Same layout
- Current stock price separator (dashed row with price pill) between ITM and OTM strikes
- Color coding: Bid = orange, Ask = green; ITM rows have subtle highlight
- Summary bar: call count, put count, Put/Call OI ratio, avg IV (calls)
- Falls back to DB cache when Yahoo is rate-limited; shows 503 with guidance if neither source works

**Data persistence:** Every live fetch also writes to `options_chain_history` (fire-and-forget, doesn't delay response).

### 7.2 Options Bot Settings (`/options-bot`)

Settings page for the autonomous options bot per user. Controls: enabled toggle, strategy enable/disable, position limits, take-profit/stop-loss %, score thresholds.

### 7.3 `options_chain_history` Table

Schema: `(symbol, captured_date, expiration_date, option_type, strike, bid, ask, last_price, volume, open_interest, implied_volatility, delta, gamma, theta, vega, stock_price, days_to_exp, source)`  
Unique constraint: `(symbol, captured_date, expiration_date, option_type, strike)` — upsert on conflict.  
Indexed by `(symbol, captured_date)` and `(symbol, expiration_date)`.

This table grows daily and becomes the platform's own IV history dataset — no external API needed for historical options analysis once enough data is collected.

---

## 8. Alerts & Notifications

### Telegram Integration

**Service:** `backend/src/services/telegramAlertService.js`  
Per-user Telegram chat ID configured in profile. Alerts sent for:
- Trade entry / exit
- Daily P&L summary (4:15 PM ET)
- Weekly report ready
- Options pre-market cache warmup result
- Daily loss limit reached
- Max positions reached

### In-App Alerts (`/alerts`)

- Notification bell in header with unread badge count
- Alert types: signal alerts, trade executions, risk warnings, news alerts
- Stored in `alerts` table; mark-as-read per alert

---

## 9. UI Pages & Navigation

| Route | Label | Purpose |
|---|---|---|
| `/portfolio` | Portfolio | Open positions, P&L, account value, allocation chart |
| `/dashboard` | Dashboard | Selected stock deep-dive, AI signals, chart |
| `/performance` | Performance | P&L history, Trade Attribution, Weekly Reports |
| `/analytics` | Trade Review | Trade Log, Equity Curve, Score Analysis, Hold Time, Exit Breakdown, Holdback Simulation, **Market Review** (added 2026-07-06) |
| `/recommendations` | Picks | Nightly scan top picks by AI score |
| `/alerts` | Alerts | In-app notification center |
| `/news` | News | News aggregation with sentiment scores |
| `/weekly` | Weekly | Weekly performance report browser |
| `/ai-trading` | AI Bot | Bot activity log, regime status, manual trigger |
| `/options-chain` | Chains | Options chain viewer (new) |
| `/options-bot` | Options Bot | Options bot settings |
| `/swing-trading` | Swing | Swing trading bot status and history |
| `/backtest` | Backtest | Strategy backtesting on historical data |
| `/scalping` | Scalping | Scalping bot status |
| `/scenarios` | Scenarios | What-if scenario analysis |
| `/enquiry` | Enquiry | Stock deep-dive search |
| `/localdata` | Data | Local bar cache browser, DB stats |
| `/universe` | Universe | Full nightly scan universe with scores |
| `/signals` | Signals | Signal history and quality metrics |
| `/live-readiness` | SENTINEL | System health, live trading checklist |
| `/profile` | (menu) | Account settings, Telegram config, API keys |
| `/login` | — | JWT login |

**Navigation:** `AppHeader.tsx` renders the full nav bar. `AppHeaderMobile.tsx` + `MobileMenu.tsx` for responsive mobile layout.

---

## 10. Market Intelligence

### ATLAS Global Sentiment (`globalSentimentService.js`)

Composite global macro score (−1 to +1) from:
- VIX level
- SPY trend
- DXY (dollar)
- TLT (bonds)
- GLD (gold)
- International market breadth

Labels: STRONG_BULLISH / BULLISH / NEUTRAL / BEARISH / RISK_OFF  
Cached 15 minutes. Used by both stock bot and options bot to gate trades.

### Market Regime (`marketRegimeService.js`)

Intraday regime detection: BULL / BEAR / NEUTRAL  
Based on: advance/decline ratio, SPY momentum, sector breadth, VIX level.

### Live Score Cache (`liveScoreCacheService.js`)

Caches composite AI scores for recently evaluated symbols (15-minute TTL). Prevents redundant score recalculations when multiple bot cycles run close together.

### Morning Briefing

Sent via Telegram each weekday morning after nightly scan completes:
- Top 5 STRONG BUY picks with scores
- Market regime summary
- ATLAS global sentiment
- Notable earnings this week

---

## 11. Database Tables

| Table | Purpose |
|---|---|
| `users` | User accounts (id, email, alpaca credentials, alpaca_paper flag) |
| `trading_accounts` | Simulated paper account balances and P&L tracking |
| `trades` | All executed trades (entry + exit, P&L, AI score) |
| `trade_decision_journal` | Full bot decision log — every candidate evaluated |
| `trade_candidates` | Bot candidates with score/outcome for ML training |
| `daily_universe_analysis` | Nightly scan results (one row per symbol per date) |
| `daily_bars` | OHLCV daily bar history (112K+ rows, local warehouse) |
| `fundamentals_cache` | Company fundamentals per symbol |
| `options_trades` | Options bot executed trades (paper) |
| `options_bot_config` | Per-user options bot settings |
| `options_chain_cache` | Latest options chain per symbol (rolling, single-row) |
| `options_chain_history` | Historical options chain records (append-only, permanent) |
| `weekly_performance_reports` | Auto-generated weekly reports (JSON + summary) |
| `alerts` | In-app notification records |
| `earnings_calendar` | Upcoming earnings dates (used for earnings guard) |
| `market_regime_history` | Historical regime records |
| `nightly_scan_history` | Audit log of scan runs |
| `calibration_suggestions` | Daily score-threshold recommendations from `scoreCalibratorService.js` (recommend-only by default; see §16) |
| `market_review_snapshots` | Daily capture of the **full** scan universe (every ticker analyzed, not just traded) with 1d/3d/5d forward returns backfilled — added 2026-07-06, see §16 |

**`holdings` columns added 2026-07-06:** `last_rescore_score`, `last_rescore_at`, `low_score_streak` — support Quality Score Decay (§16).

---

## 12. Scheduled Jobs (Cron)

All times Eastern US.

| Time | Days | Job |
|---|---|---|
| 6:00 AM | Mon–Fri | Nightly scan (runs overnight after market close) |
| 8:00 AM | Mon–Fri | Options chain pre-market cache warmup |
| 9:45 AM | Mon–Fri | Options bot scan #1 (post-open) |
| 10:00 AM | Mon–Fri | Stock bot scan #1 |
| 11:00 AM | Mon–Fri | Stock bot scan #2 + Options bot scan #2 |
| 12:00 PM | Mon–Fri | Stock bot scan #3 |
| 1:00 PM | Mon–Fri | Options bot scan #3 |
| 1:30 PM | Mon–Fri | Stock bot scan #4 |
| 2:30 PM | Mon–Fri | Stock bot scan #5 |
| 3:00 PM | Mon–Fri | Options bot scan #4 |
| 3:15 PM | Mon–Fri | Stock bot scan #6 |
| 3:45 PM | Fridays | Weekly report generation |
| 4:15 PM | Mon–Fri | Daily summary Telegram + options summary |
| 4:25 PM | Mon–Fri | **Market Review capture** — snapshots full scan universe + backfills forward returns (added 2026-07-06, see §16) |
| 5:00 PM | Mon–Fri | Position monitoring / reconciliation |
| 6:00 PM | Mon–Fri | Options chain evening refresh |

**Position monitoring:** Every 5 minutes during 9:35 AM – 4:05 PM for stop-loss / take-profit exits.

---

## 13. API Endpoints Reference

### Auth
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/auth/login` | Get JWT token |
| POST | `/api/auth/register` | Create account |

### Trading & Positions
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/portfolio` | Current positions + account value |
| GET | `/api/trading/trades` | Trade history |
| POST | `/api/ai-trading/trigger` | Manual bot scan trigger |
| GET | `/api/ai-trading/status` | Bot status, regime, last scan |
| GET | `/api/daily-signals` | Latest nightly scan signals |

### Performance
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/performance/summary` | P&L summary by day |
| GET | `/api/performance/trade-attribution` | Full attribution with aggregations |
| GET | `/api/performance/weekly` | Weekly report list |
| GET | `/api/performance/weekly/:weekId` | Single week report |
| GET | `/api/performance/exit-breakdown?days=` | Closed-trade P&L grouped by exit type |
| GET | `/api/performance/holdback-sim?days=` | Simulates holding trailing/break-even exits one extra day |
| GET | `/api/performance/market-review?days=` | Score vs actual forward-return comparison across the **full** scan universe — added 2026-07-06, see §16 |
| GET | `/api/performance/calibration` | Score-bucket profit-factor/expectancy report from `scoreCalibratorService.js` |

### Options
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/options/chain?symbol=&expiration=` | Options chain viewer data |
| GET | `/api/options/:symbol` | Options chain + Greeks (bot format) |
| GET | `/api/options-bot/config` | Options bot user settings |
| PUT | `/api/options-bot/config` | Update options bot settings |
| GET | `/api/options-bot/trades` | Options trade history |
| GET | `/api/options-bot/status` | Scheduler + bot status |
| POST | `/api/options-bot/trigger` | Manual options scan trigger |

### Market Data
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/signals/:symbol` | Signal history for symbol |
| GET | `/api/universe` | Full nightly scan universe |
| GET | `/api/recommendations` | Top picks from latest scan |
| GET | `/api/news` | News with sentiment scores |
| GET | `/api/localdata/stats` | Daily bars DB stats |
| GET | `/api/localdata/bars/:symbol` | Local bar data for symbol |

### System
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/system/health` | Backend health check |
| GET | `/api/live-readiness` | SENTINEL checklist |

---

## 14. Known Limitations & Roadmap

### Current Limitations

| Issue | Impact | Fix |
|---|---|---|
| Polygon subscription excludes Options tier (403) | Options bot cannot fetch live options chains; falls back to Yahoo | Upgrade Polygon plan to include Options add-on |
| Yahoo Finance 429 rate limiting during peak hours | Options chain viewer shows 503; pre-market warmup may fail for some symbols | Fixed by cache-first approach (23h TTL); warmup at 8 AM off-peak usually succeeds |
| TDJ exit prices for 6 corrected trades (CEVA, ALGM, TJX, CSX, TREX, LEVI) | `trades` table has corrected prices; TDJ may have stale `exit_price`/`pnl` | Sync script needed |
| Options bot 0 trades (paper account) | No live options data reaching the bot | Resolved once Polygon Options tier activated |
| Market cap not stored in `trading_accounts` | Options bot market cap check uses quote every call | Low priority |

### Architecture Decisions

- **Local-first data:** All bar data cached in PostgreSQL; API calls only for tail days. Over time, entire history is local.
- **Options history as asset:** `options_chain_history` accumulates daily. After 6–12 months, this table enables backtesting option strategies without any external data.
- **Cache-first options:** Bot reads from DB cache during market hours; live API only called during pre-market warmup. Reduces rate-limit exposure to 1 daily window.
- **Evidence generation over signal chasing:** Trade Attribution + Expectancy framework measures what's actually working before scaling. 30-day paper period ongoing.

### Next Steps (Planned)

- [ ] Upgrade Polygon to Options tier → enables live options bot execution
- [ ] Sample size confidence indicators in Attribution tables (dim rows where n < 10)
- [ ] Sync TDJ exit prices for 6 corrected historical trades
- [ ] Sector-specific score floors (JSON config per sector based on Attribution data)
- [ ] `options_chain_history` → IV percentile rank calculator once 60+ days of data collected
- [ ] Live pilot ($500–$2K) after 30-day paper evidence period completes

---

*KiranRock platform built incrementally for personal trading research and live trading. All live trading risk-managed with hard stops and cash guards.*

---

## 15. Signal & Pick Logic — Deep Dive

This section documents exactly how the system goes from raw market data to a trade execution. It covers the full scoring pipeline (PANTHEON), how picks are selected from that score, how the AI Stock Bot and Options Bot consume those picks, and the precise stock selection criteria.

---

### 15.1 Stock Universe — What We Scan

**File:** `backend/src/services/stockUniverse.js`

The nightly scan covers 800+ US-listed stocks drawn from:
- S&P 500 constituents
- NASDAQ 100 constituents
- Russell 1000 high-volume names

Stocks are organized by sector (Technology, Financials, Healthcare, Consumer Discretionary, Communication Services, Industrials, Energy, Materials, Utilities, Consumer Staples, Real Estate). The sector map auto-expands via `sectorLearnedCache.json` when new tickers are encountered.

**Hard eligibility gates (applied before scoring):**
| Gate | Value | Source |
|---|---|---|
| US-listed, not OTC | Required | symbol format check |
| Market cap | ≥ $2B | `fundamentals_cache` / Yahoo quote |
| Bar history | ≥ 50 trading days | `daily_bars` count |
| Price | > $0 | quote |
| Avg daily volume | ≥ 150K–500K (varies by sector profile) | 20-day bar average |

Stocks failing any gate are skipped entirely — not scored, not logged.

---

### 15.2 PANTHEON Scoring Engine

**File:** `backend/src/services/enhancedAITradingBot.js` → `analyzeStockWithAI()`

Every eligible stock receives a composite 0–100 score. Each component adds or subtracts points. The components run in order:

#### Gate 0 — Weinstein Stage Filter (Hard Gate, not scored)

Before any scoring, the system checks whether the stock is in **Weinstein Stage 2** (uptrend):
- Price > 200-day SMA
- 200-day SMA is rising (today > 10 days ago)
- 50-day SMA > 200-day SMA

If Stage 3 or Stage 4 (below SMA200 or SMA200 falling), the stock is **rejected immediately** — no score generated. Only Stage 2 stocks enter the scoring pipeline.

#### Component 1 — Trend Template (±15 pts)

5 moving average conditions checked. Each TRUE condition adds +3; each FALSE subtracts −1:
- Price > SMA50 → +3 / −1
- Price > SMA200 → +3 / −1
- SMA50 > SMA200 → +3 / −1
- Price > SMA20 → +3 / −1
- SMA20 > SMA50 → +3 / −1

Max: +15 | Penalty cap: −5

#### Component 2 — Momentum (±13 pts)

- **10-day ROC (Rate of Change):** ROC > 5% → +10; ROC 2–5% → +5; ROC 0–2% → +2; ROC < −5% → −10; ROC −2 to −5% → −5
- **Day change:** change > 1.5% → +3; change < −1.5% → −3

#### Component 3 — Volume Analysis (±10 pts)

Compares today's volume to 20-day average volume:
- > 200% of avg → +10
- 150–200% → +7
- 120–150% → +4
- 80–120% → 0
- 50–80% → −3
- < 50% → −6

#### Component 4 — RSI Suite (±variable)

- **RSI (14):** RSI 55–70 → +8 (momentum zone); RSI 70–80 → +3 (hot but still ok); RSI > 80 → −5 (overbought); RSI 40–55 → +2; RSI 30–40 → −3; RSI < 30 → −8
- **Stochastic RSI:** stochRSI < 0.2 (oversold) → +8; stochRSI > 0.8 (overbought) → −5; crossover up → +4
- **Williams %R:** %R < −80 → +7; %R > −20 → −5

#### Component 5 — MACD (±variable)

- MACD line > signal line (bullish cross) → +8
- MACD > 0 (positive histogram) → +4
- Bearish cross or MACD < 0 → −5 to −8

#### Component 6 — Bollinger Bands & Mean Reversion (±variable)

- **Bollinger squeeze** (bands narrow): +5 (coiling for breakout)
- **Price near upper band** (>95%): −3
- **Price near lower band** (<5%): +5
- **Mean reversion — SMA20 distance:** price < SMA20 by >5% → +10 (pullback entry); price > SMA20 by >15% → −12 (extended); price > SMA20 by >8% → −5
- **5-day gain overbought guard:** if 5-day gain > 12% AND Bollinger position > 90% → −10

#### Component 7 — Relative Strength vs SPY (±8 pts)

Compares stock's 20-day return vs SPY 20-day return:
- Outperforming by > 5% → +8
- Outperforming by 2–5% → +5
- Underperforming by > 5% → −8
- Underperforming by 2–5% → −4

#### Component 8 — 52-Week High Proximity (±7 pts)

- Within 5% of 52-week high (breakout zone) → +7
- Within 10–20% → +3
- Below 40% of 52-week high → −7

#### Component 9 — Earnings Risk (−15 to +5)

Queries `earnings_calendar` table:
- **0–4 days to earnings** → hard penalty −15 (earnings are binary risk, skip)
- **5–15 days** → score adjusted by PROPHET forecast (see AI Agents below)
- **> 30 days** → +5 (clear runway)

#### Component 10 — VIX (±10 pts)

- VIX < 15 (calm market) → +10
- VIX 15–18 → +5
- VIX 18–22 → 0
- VIX 22–27 → −5
- VIX > 30 → hard block: returns 0 score (bot halts all buys)
- VIX 27–30 → −10

#### Component 11 — News Sentiment (±8 pts, configurable weight)

Pulled from Polygon news or Gemini analysis. Sentiment score −1.0 to +1.0:
- > +0.7 → +8; +0.3 to +0.7 → +4; −0.3 to +0.3 → 0; −0.3 to −0.7 → −4; < −0.7 → −8

**Geopolitical risk keyword filter:** If news headlines contain terms like "war", "invasion", "sanctions", "tariff", "default", "nuclear", etc. → −10 flat penalty on top of sentiment.

#### Component 12 — VCP Pattern (Minervini, ±8 pts)

Volatility Contraction Pattern detection:
- 3+ consecutive weekly ranges contracting (each week's range < prior week) → +8
- 2-week contraction → +4
- Volume drying up during contraction → +5 additional bonus

#### Component 13 — Market Cap Quality (±5 pts)

- Market cap > $20B (mega cap) → +5
- $5B–$20B → +3
- $2B–$5B → 0
- < $2B → not eligible (filtered earlier)

#### Component 14 — Sector Rotation via COMPASS (±8 pts)

**Agent:** COMPASS (`compassService.js`)  
Ranks all sector ETFs (XLK, XLF, XLV, XLY, etc.) by 20-day relative strength. If the stock's sector is in the top 3 ranked sectors → +8; top half → +4; bottom half → −4; bottom 2 sectors → −8.

#### Component 15 — SONAR Smart Money / Institutional Flow (±8 pts)

**Agent:** SONAR (`sonarService.js`)  
Analyzes unusual options volume, dark pool prints, and institutional accumulation signals. SONAR score 0–100 maps to −8 to +8 adjustment.

#### Component 16 — CANSLIM Fundamentals (±14 pts)

- **EPS growth** > 25% YoY → +7; 15–25% → +4; 5–15% → +2; negative → −5
- **Revenue growth** > 20% → +7; 10–20% → +4; 0–10% → +1; declining → −5

#### Component 17 — Reddit Alternative Data (±6 pts)

**Agent:** Reddit Alt Data  
Counts 24h mentions across WSB + investing subreddits. Score based on mention velocity and sentiment polarity:
- High mentions + bullish sentiment → +6; high mentions + bearish → −6; neutral → 0

#### Component 18 — GEMINI PULSE AI News (±5 pts)

**Agent:** `geminiPulseService.js` — calls Google Gemini to analyze last 5 news headlines and return a directional score. Adds ±5 to overall score.

#### Component 19 — Wyckoff Volume Analysis (±15 pts)

Analyzes volume patterns for accumulation vs distribution phases:
- Clear accumulation (rising price + rising OBV + volume above average) → +15
- Neutral → 0
- Distribution pattern → −10

#### Component 20 — ORACLE Chart Patterns (±10 pts)

**Agent:** ORACLE (`oracleService.js`)  
Only activates when `aiScore >= 55` AND remaining budget slots > 0 (`ORACLE_MAX_PER_CYCLE = 25` per scan).

Claude API call analyzes 220-day price/volume chart for:
- **VCP (Volatility Contraction Pattern)** → +10
- **Cup & Handle** → +8
- **Darvas Box breakout** → +7
- No pattern found → 0
- Bearish patterns → −5

Results cached 1 hour per symbol to avoid redundant API calls. HERMES RS sort guarantees the highest-momentum stocks consume budget slots first.

#### Component 21 — PROPHET Earnings Forecast (±8 pts)

**Agent:** PROPHET (`prophetService.js`)  
Applied when earnings are 5–15 days away. Analyzes historical post-earnings reactions, analyst estimate revisions, options market implied move:
- Expected beat + positive setup → +8; miss risk → −8; uncertain → 0

#### Component 22 — VISION Directional Signal (±8 pts)

Rule-based directional engine using: price action, volume, MA relationships, gap analysis. Produces a BULLISH/BEARISH/NEUTRAL directional label → ±8.

#### Component 23 — SAGE Self-Learning (±5 pts)

**Agent:** SAGE (`sageService.js`)  
Reads `trade_decision_journal` for past trades in the same (sector, regime, score band). If historical win rate in that category > 60% → +5; < 40% → −5.

#### Component 24 — LOCAL BRAIN (±6 pts)

Uses the **account's own win-rate statistics** for the (sector × score_bucket × regime) combination, from the past 30 days:
- Win rate > 65% with ≥ 5 trades → +6; < 35% → −6

#### Component 25 — EVOLVE Decision-Table ML (±8 pts)

**Agent:** EVOLVE  
Trained on 2-year OHLCV + indicator data using a decision-table approach. Produces a directional probability score. If probability > 0.65 → +8; < 0.35 → −8.

#### Component 26 — Regime Alignment (±8 pts)

Checks current market regime (BULL/BEAR/NEUTRAL from `marketRegimeService.js`):
- BULL regime → +8
- NEUTRAL → 0
- BEAR regime → −8 (plus raises `minBuyScore` by 10 points)

#### Component 27 — Weekly Timeframe Alignment (±8 pts)

Checks weekly chart indicators (weekly RSI, weekly MACD) for alignment with daily signal:
- Weekly bullish + daily bullish → +8
- Conflicting → 0 or −4

#### Component 28 — ATLAS Global Market Intelligence (±10 pts)

**Agent:** ATLAS (`globalSentimentService.js`)  
Composite global macro score from VIX, SPY trend, DXY, TLT, GLD, international breadth:
- STRONG_BULLISH → +10; BULLISH → +6; NEUTRAL → 0; BEARISH → −6; RISK_OFF → −10

#### FOMC Adjustment

On Federal Reserve decision days and the day before:
- Decision day → `minBuyScore` raised by +10
- Eve of decision → `minBuyScore` raised by +5
- (Prevents entering new positions into binary Fed risk events)

---

### 15.3 Score Smoothing (3-Day EMA)

**File:** `backend/src/services/nightlyUniverseScanService.js`

Raw daily scores are smoothed before storage using a 3-day exponential moving average:

```
smoothedScore = today×0.50 + yesterday×0.30 + dayBefore×0.20
```

This prevents single-day noise from generating false signals and rewards stocks with consistent scoring over multiple days.

---

### 15.4 Score Classification → Recommendation

After smoothing, scores are classified into actionable recommendations:

| Smoothed Score | Recommendation |
|---|---|
| ≥ 75 | **STRONG BUY** |
| ≥ 65 | **BUY** |
| 36–64 | HOLD |
| ≤ 35 | SELL |
| ≤ 25 | **STRONG SELL** |

One row per (symbol, date) written to `daily_universe_analysis` table.

---

### 15.5 How the AI Stock Bot Uses Signals

**File:** `backend/src/services/enhancedAITradingBot.js` → `runAutonomousTrading()`

The bot runs 6× per day (10:00, 11:00, 12:00, 13:30, 14:30, 15:15 ET). Each cycle:

#### Step 1 — Candidate Universe

Reads the latest `daily_universe_analysis` rows (4-day lookback to handle weekends). Filters to only STRONG BUY / BUY rated symbols. These become the candidates list. Sorted descending by score — highest-scoring stocks evaluated first.

If no nightly scan results exist (rare), falls back to a default watchlist of liquid stocks.

#### Step 2 — Pre-Flight Gates

Before evaluating any individual stock, the bot checks global gates:

| Gate | Condition | Source |
|---|---|---|
| Market open | 9:35 AM – 3:55 PM ET | time check |
| ATLAS regime | Not RISK_OFF | `globalSentimentService` |
| Market regime | Not BEAR (or score raised) | `marketRegimeService` |
| FOMC window | Raises minBuyScore on Fed days | `checkFomcWindow()` |
| Daily loss limit | Total day P&L > −$300 | Alpaca account |
| Max daily trades | < 5 trades today | trade count query |

#### Step 3 — Per-Candidate Evaluation

For each candidate from the universe:

1. **Fetch live quote** (Alpaca IEX → Polygon fallback)
2. **Check earnings guard:** skip if earnings within 3 days (`earnings_calendar` table)
3. **Check existing position:** skip if already holding this symbol
4. **Check max open positions:** skip if at cap (default 4)
5. **Cash guard:** skip if account cash < minimum threshold (`brokerService.checkCashAvailable`)
6. **RS filter:** skip if relative strength vs SPY below floor
7. **Sector profile gate:** apply `SECTOR_TRADE_PROFILES` — AGGRESSIVE requires score ≥ 65, DEFENSIVE requires ≥ 78, STANDARD requires ≥ 65
8. **Live score check:** if `liveScoreCache` has a fresh score (<15 min old), use it; otherwise run `analyzeStockWithAI()` live for the candidate
9. **minBuyScore gate:** final score must be ≥ configured threshold (default 85; DB per-user value overrides)

#### Step 4 — Position Sizing

**File:** `positionSizingService.js`

ATR-based sizing with fractional share support:
```
riskPerTrade = accountValue × maxPositionSize (10%)
stopDistance = ATR × sectorProfile.stopMult
shares = riskPerTrade / stopDistance
notional = shares × price
notional = min(notional, maxOrderNotional=$500)
```

Fractional shares enabled for high-priced stocks (GOOGL, AMZN, etc.) so the bot can take meaningful positions below $500.

#### Step 5 — Order Execution

Places an Alpaca bracket order:
- **Buy:** market or limit order
- **Stop-loss:** ATR × stopMult below entry (max 7–10% depending on sector profile)
- **Take-profit:** ATR × targetMult above entry (full exit at 20%)
- **Partial take-profit:** 50% position exit at 12% gain

Writes to `trades` table + `trade_decision_journal` (TDJ) with full metadata: score, sector, regime, ATLAS label, all agent outputs.

#### Step 6 — Position Monitoring

Every 5 minutes (9:35 AM – 4:05 PM ET):
- Checks stop-loss and take-profit triggers
- On exit: updates TDJ with outcome, exit reason, hold days, ATR%, post-exit setup for drift analysis

---

### 15.6 Sector Trade Profiles

Each sector gets an ATR-based stop/target multiplier and minimum score requirement:

| Profile | Sectors | Stop | Target | Min Score | Min Volume |
|---|---|---|---|---|---|
| **AGGRESSIVE** | Technology, Consumer Discretionary, Communication Services | ATR × 2.0 | ATR × 4.0 | 65 | 500K |
| **DEFENSIVE** | Utilities, Consumer Staples, Real Estate | ATR × 1.2 | ATR × 2.0 | 78 (rarely reached) | 150K |
| **STANDARD** | All other sectors | ATR × 1.5 | ATR × 3.0 | 65 | 200K |

Defensive sectors have a 78 minimum score — since momentum signals almost never reach 78 for slow-moving utility/staple stocks, this effectively blocks them without maintaining a hard-coded exclusion list.

---

### 15.7 What Stocks We Buy — Full Criteria Summary

A stock must satisfy ALL of the following to generate a BUY:

**Universe requirements:**
- US-listed (not OTC / pink sheet)
- Market cap ≥ $2B
- 50+ trading days of bar history in local DB
- Avg daily volume ≥ 150K (DEFENSIVE), 200K (STANDARD), 500K (AGGRESSIVE)
- Preferred sectors: Technology, Healthcare, Financials, Consumer Discretionary, Communication Services

**Technical requirements:**
- Weinstein Stage 2: price > SMA200, SMA200 rising, SMA50 > SMA200
- VIX < 30 at time of entry
- ATLAS global sentiment ≠ RISK_OFF

**Score requirements:**
- Smoothed PANTHEON score ≥ 85 (per-user configurable in `risk_configs` DB table)
- Score ≥ sector profile minimum (AGGRESSIVE: 65; DEFENSIVE: 78; STANDARD: 65)
- Score raised by 10 on FOMC decision days; by 5 on eve of decision

**Account requirements:**
- No existing position in the same symbol
- Open positions < max (default 4)
- Available cash above minimum threshold
- Daily trade count < 5
- Day's total P&L > −$300

**Earnings safety:**
- No earnings within 3 days of entry

---

### 15.8 Options Bot Signal Flow

**Files:** `backend/src/services/autonomousOptionsBot.js`, `optionsBotScheduler.js`

The Options Bot runs only for users with `options_bot_config.enabled = true`. Currently enabled for paper account only (user 83f08677). Disabled for live account (kmadined).

#### Step 1 — Universe Selection

At each scan (9:45, 11:00, 13:00, 15:00 ET):
1. Reads latest nightly scan results, filters to **STRONG BUY** (score ≥ 75) and **BUY** (score ≥ 65) — top 20 symbols
2. Falls back to default liquid options universe (SPY, QQQ, AAPL, MSFT, NVDA, AMZN, AMD, META, TSLA, PANW) if scan results unavailable

**Additional options-specific filters:**
- Price > $20 (options premiums are impractical below this)
- Avg volume > 1M shares/day (ensures liquid options market)
- Market cap > $5B (institutional liquidity in options chain)

#### Step 2 — Options Chain Fetch (Cache-First)

For each candidate symbol:
1. Checks `options_chain_cache` table — if data is < 23 hours old, uses it directly (no API call)
2. If cache miss: calls Yahoo Finance `yf.options(symbol)` (single call, nearest expiration)
3. Saves result to `options_chain_cache` + appends to `options_chain_history` (permanent record)

Pre-market warmup at **8:00 AM ET** pre-fetches all universe symbols, so trading session reads from cache with zero live API exposure.

#### Step 3 — Greek Filtering

For each contract in the options chain, filters by:
- **Delta:** 0.3–0.7 (directional calls/puts; not deep ITM/OTM lottery tickets)
- **Gamma:** > 0.01
- **Theta:** < −0.5 (avoids very slow time decay if buying premium)
- **Volume:** > 100 (morning), 200 (pre-close), 500 (after-hours)
- **Open Interest:** > 500 (morning), 1000 (after-hours)
- **Days to Expiration:** 7–60 days (no weeklies, no LEAPs for primary strategy)

#### Step 4 — Strategy Selection

The bot selects from 4 strategies based on allocation percentages and VIX regime:

| Strategy | Allocation | Target P&L | VIX Regime |
|---|---|---|---|
| **Directional Swing** (long call/put) | 40% | +35% | LOW / NORMAL |
| **Credit Spreads** | 20% | +15% | NORMAL / HIGH |
| **Delta-Neutral Scalping** | 30% | +20% | LOW only |
| **Protective Puts** (portfolio hedge) | 10% | N/A (hedge) | ANY |

For STRONG BUY signals: buys calls (directional long)  
For STRONG SELL signals: buys puts or sells credit call spreads

#### Step 5 — Sizing and Execution

Options position sizing:
- Notional per trade ≤ configured `maxPositionNotional`
- Max open options positions: per-user configurable
- Premium paid < 5% of account value per trade

Executed via Alpaca options orders (paper). Written to `options_trades` table.

#### Step 6 — Alert Generation

For high-quality setups (|delta| > 0.6, volume > 500):
- Saves to `options_alerts` table
- Sends Telegram alert to user
- Visible in `/alerts` page

---

### 15.9 Nightly Scan → Morning Briefing Flow

The full daily cycle:

```
[After close ~6 PM ET]
nightlyUniverseScanService.js
  → 800+ symbols × analyzeStockWithAI()
  → Score smoothing (3-day EMA)
  → Write daily_universe_analysis rows
  → Post-scan backfill of daily_bars

[Overnight]
  → Telegram morning briefing prepared

[8:00 AM ET]
optionsBotScheduler.js warmup
  → Pre-fetch options chains for top 20 universe symbols
  → Write to options_chain_cache + options_chain_history

[9:35 AM ET — Market Open]
enhancedAITradingBot.js
  → Read daily_universe_analysis (pre-computed scores)
  → Apply live gates → execute trades → monitor

[Every 5 min, 9:35–4:05 PM]
  → Check stops/targets
  → Close positions → write TDJ outcome

[3:45 PM ET — Fridays]
weeklyReportService.js → generate + store weekly report

[4:15 PM ET]
  → Daily P&L Telegram summary

[6:00 PM ET]
  → Options chain evening refresh
```

---

### 15.10 Trade Intelligence Feedback Loop

**File:** `backend/src/services/tradeIntelligenceService.js`

After enough trades accumulate (≥ 30 in a category), `getExpectancyAdjustment()` modifies future scoring:

```
expectancy = winRate × avgWin% − lossRate × |avgLoss%|
```

- If historical expectancy in (sector, regime, score_bucket) is positive → score nudged up, position size multiplier > 1.0
- If negative → score nudged down, position size multiplier < 1.0

This creates a closed feedback loop: the platform improves entry selection based on its own trade history, without any manual intervention.

Every evaluated candidate (including rejections) is written to `trade_candidates` — building a supervised learning dataset for future ML model training.

---

## 16. Session Updates — 2026-07-06

Five functional additions and two bug fixes made in this session, all reviewed against a ChatGPT-authored strategy critique before implementation. Three items from that critique turned out to already exist in the codebase (correlation filter, Kelly/expectancy sizing, gap-chase guard) and needed no changes — noted here for context, not re-documented.

### 16.1 Quality Score Decay

**File:** `enhancedAITradingBot.js` → `manageExistingPositions()`

Previously, once a position opened, every exit decision was purely price-driven — the rich entry score (technicals + news + AI overlays) was never revisited. Now each open position is re-scored with the same `analyzeStockWithAI()` engine used at entry, throttled to once per ~20 hours per symbol (persisted via new `holdings` columns: `last_rescore_score`, `last_rescore_at`, `low_score_streak`).

**Tiered response:**
| Re-score | Effect |
|---|---|
| ≥ 85 | Normal — no change |
| 75–84 | Trailing stop tightened ×0.7 |
| 65–74 | Trailing stop tightened ×0.5 |
| < 65, 2 consecutive re-scores | Forced exit, regardless of hold-time guard |

Requiring **two consecutive** low re-scores (not one) before exiting avoids reacting to a single noisy recalculation. Confirmed live on 2026-07-06: CL and AMGN both flagged in the decay tier closed as small wins instead of round-tripping further — the tightening working as designed on its first day live.

### 16.2 Portfolio Heat Gate

**File:** `enhancedAITradingBot.js` → buy loop in `runTradingSession()`

A read-only dashboard endpoint (`/api/ai-trading/portfolio-heat`) already computed aggregate dollar-risk-to-stop across open positions but never enforced it. Now wired into the buy loop: before sizing any new position, aggregate risk (existing holdings + this cycle's new sizes) is checked against a budget (`MAX_PORTFOLIO_RISK_PCT` env var, default 2.5% of equity — shared with the dashboard so what's displayed is what's enforced). A qualifying trade that would exceed budget is **shrunk to fit** rather than rejected outright; once budget is fully exhausted, no further new positions open that cycle.

### 16.3 Regime Transition Response

**File:** `enhancedAITradingBot.js` — extends the existing `_lastRegimePerUser` regime-shift tracker

The regime-shift detector previously only sent a Telegram alert on transition. It now also distinguishes a genuine **downgrade** (via an ordinal rank: BULL_STRONG > BULL > NEUTRAL/CHOPPY > BEAR_MILD > BEAR/RISK_OFF/PANIC) and reacts immediately:
- Cancels any pending unfilled buy orders for that user
- Applies an extra 25% trailing-stop tightening for a 2-hour window (stacks with the Quality Score Decay multiplier)

Regime-scaled exit thresholds already recompute every cycle from current regime — this addition is specifically for reacting to the *moment of transition* rather than waiting for the next scheduled evaluation.

### 16.4 Score Calibration — confirmed already built, not re-implemented

`scoreCalibratorService.js` already implements sector-specific score floors, exit-reason attribution, confidence-bucket calibration, and score×signal-clarity cross-analysis — considerably more sophisticated than initially assumed. Runs daily, persists to `calibration_suggestions`, sends a Telegram report, and has a stability-gated (3-day same-suggestion, ±2 max step) Phase 2 auto-apply — **disabled by default** (`AUTO_ACCEPT_THRESHOLD_CHANGES` env flag, confirmed unset). No code changes made; documented here so it isn't mistaken for a gap in future reviews.

### 16.5 Market Review — full scan universe vs. actual outcome

**New table:** `market_review_snapshots` — see §11  
**New service:** `marketReviewService.js` (`captureDailySnapshot()`, `backfillForwardReturns()`, `runDailyMarketReview()`)  
**New scheduled job:** 4:25 PM ET daily, in `scheduleTelegramReport.js` — see §12  
**New endpoint:** `GET /api/performance/market-review?days=` — see §13  
**New UI:** "Market Review" tab on `/analytics` — see §9

Motivated by a real observed gap: on 2026-07-06, several memory/semiconductor names (AMD +8.97%, WDC +7.35%, MU +3.64%) rallied hard while the bot's actual holdings (TREX, EAT) went negative — and the scan had in fact evaluated and passed on all of the rallying names (scored 36–56, below the BUY threshold) because its momentum component penalizes stocks with a recent sharp decline, missing the snapback. Market Review captures **every** scanned ticker daily (not just traded ones) with 1d/3d/5d forward returns and the regime at scan time, so score-vs-outcome and regime-vs-outcome can be validated with real data over time instead of single-day anecdotes.

### 16.6 Bug fix — stale Alpaca IEX quote could block all new buys for hours

**File:** `dataProvider.js`

QQQ's real intraday price stayed in a 720–726 range all day on 2026-07-06 (verified via actual 15-min bars), yet `[QQQGate]` — which blocks all new buys bot-wide on a red QQQ day — logged a constant, incorrect "‑1.76%" reading for 6+ hours, spanning a mid-day backend restart (ruling out our own 60-second quote cache as the cause). Root cause: Alpaca's free-tier IEX snapshot feed served a stuck trade. Fix: a staleness guard scoped to `QQQ`/`SPY` (the two gate-critical symbols) rejects an IEX quote whose `LatestTrade` hasn't updated in 5+ minutes during regular market hours, falling back to Polygon automatically via the existing fallback path — no changes needed to any calling code.

### 16.7 Bug fix — duplicate stop order created a naked short position

**Files:** `enhancedAITradingBot.js` (`[StopRepair]` block), `trailingStopService.js`

A real-money incident on the live account: EAT's stop-loss fired and correctly closed a 2-share long position at 14:43:55 UTC. Three minutes later, the stop-repair cycle — working off a holdings snapshot taken *before* that fill was reconciled — saw "no stop order" for EAT and placed a fresh one. That duplicate order sat resting and fired again three hours later against zero remaining shares, opening an **unmonitored naked short** (invisible to the `holdings` table, no stop protecting it).

This exact class of bug (time-of-check-to-time-of-use race between a DB snapshot and live broker state) existed independently in **two separate places**:
1. `enhancedAITradingBot.js`'s `[StopRepair]` block
2. `trailingStopService.js` — a wholly separate service, also on a 5-minute cycle, with three of its own "no stop found → create one" branches

Both were fixed the same way: a live `getPosition()` check immediately before placing any "missing stop" order, skipping if the broker's live quantity doesn't match the snapshot. Fixing only one would have left the other as a live path for the identical failure mode.

The naked short itself required manual closing (not something a code fix can undo) — a buy order to flatten it was placed manually via the Alpaca dashboard, pending fill at next market open.

### 16.8 Operational note — nightly scan resilience under real network outages

Two separate wifi/DNS outages hit during this session's nightly scan window, degrading `daily_universe_analysis` coverage (as low as 368/556 valid scores at one point). Recovery used the scan service's existing `missingOnly: true` resume mode (`runNightlyUniverseScan({ missingOnly: true })`) — re-processing only symbols still missing a score rather than a wasteful full re-scan, and deliberately *not* run concurrently with the worker's own in-progress scan to avoid doubling load on already rate-limited external APIs (Yahoo/Gemini/X News). No code changes; documented as an operational pattern for the next time this happens.
