# KiranRock AI Trading Platform — Complete Functional Guide

> **Version**: Feature branch `feature/trade-lots-migration` · **Updated**: 2026-05-22  
> **Stack**: Node.js · PostgreSQL · Alpaca Paper · Ollama (llama3.2:3b) · Next.js

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Environment Configuration](#2-environment-configuration)
3. [AI Components (PANTHEON)](#3-ai-components-pantheon)
   - 3.1 [ORACLE — Trade Verdict Agent](#31-oracle--trade-verdict-agent)
   - 3.2 [PROPHET — Earnings Forecaster](#32-prophet--earnings-forecaster)
   - 3.3 [LocalBrain — Statistical Learning](#33-localbrain--statistical-learning)
   - 3.4 [Ollama — Local LLM Backend](#34-ollama--local-llm-backend)
   - 3.5 [GEMINI PULSE — News Sentiment](#35-gemini-pulse--news-sentiment)
   - 3.6 [SHIELD — Macro Regime](#36-shield--macro-regime)
   - 3.7 [SONAR — Smart Money](#37-sonar--smart-money)
   - 3.8 [COMPASS — Sector Rotation](#38-compass--sector-rotation)
   - 3.9 [HERMES — Universe Filter](#39-hermes--universe-filter)
4. [Stock Universe & Scanning](#4-stock-universe--scanning)
   - 4.1 [Pre-Market Cache Build](#41-pre-market-cache-build)
   - 4.2 [Intraday Movers Refresh](#42-intraday-movers-refresh)
   - 4.3 [Adaptive Universe Cap](#43-adaptive-universe-cap)
5. [Market Regime Detection](#5-market-regime-detection)
6. [AI Scoring Pipeline](#6-ai-scoring-pipeline)
7. [Risk Management](#7-risk-management)
   - 7.1 [Position Sizing](#71-position-sizing)
   - 7.2 [Entry Gates](#72-entry-gates)
   - 7.3 [Exit Logic](#73-exit-logic)
   - 7.4 [Circuit Breakers](#74-circuit-breakers)
   - 7.5 [Swing Trade Rules](#75-swing-trade-rules)
8. [Sector & Industry Controls](#8-sector--industry-controls)
9. [Scheduler Reference](#9-scheduler-reference)
10. [Performance Analytics API](#10-performance-analytics-api)
11. [All API Endpoints](#11-all-api-endpoints)
12. [Database Schema — Key Tables](#12-database-schema--key-tables)
13. [Operational Runbook](#13-operational-runbook)
14. [Known Limitations & Roadmap](#14-known-limitations--roadmap)

---

## 1. System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    KiranRock Platform                   │
├───────────────────────┬─────────────────────────────────┤
│  Frontend (port 3000) │  Backend API (port 3001)         │
│  Next.js              │  Express.js                      │
│  Dashboard / Charts   │  Routes → Services → DB          │
└───────────────────────┴──────────────┬──────────────────┘
                                       │
              ┌────────────────────────┼────────────────────┐
              │                        │                    │
     ┌────────▼───────┐    ┌──────────▼──────┐   ┌────────▼──────┐
     │   PostgreSQL    │    │  Ollama (local) │   │  Alpaca API   │
     │  kiranrock_db   │    │  llama3.2:3b    │   │  Paper Trade  │
     │                 │    │  port 11434     │   │               │
     │ trades          │    │  ORACLE verdicts│   │  Buy / Sell   │
     │ holdings        │    │  PROPHET fcasts │   │  Positions    │
     │ ohlcv_cache     │    │  Brain coaching │   │  Account      │
     │ trade_decision_ │    └─────────────────┘   └───────────────┘
     │   _journal      │
     │ ai_performance_ │    ┌─────────────────┐   ┌───────────────┐
     │   _metrics      │    │  Yahoo Finance  │   │  Telegram Bot │
     └─────────────────┘    │  Quotes/OHLCV   │   │  Alerts       │
                            │  (pre-market    │   │  Reports      │
                            │   only)         │   │  Signals      │
                            └─────────────────┘   └───────────────┘

Worker Process (separate terminal):
  ├── Enhanced AI Scheduler   (runs trading cycles)
  ├── Asset Universe Scheduler (6 cron jobs)
  ├── AI Trading Scheduler    (autonomous bot)
  ├── Options Bot             (options strategies)
  └── News Monitor            (sentiment feeds)
```

**Two-process model**: `npm start` (API only) + `npm run start:worker` (all schedulers). This prevents the API from dying when a scheduler job OOMs.

---

## 2. Environment Configuration

File: `backend/.env` (copy from `backend/.env.example`)

### Core

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Backend API port |
| `NODE_ENV` | `development` | Environment flag |
| `JWT_SECRET` | — | Auth token signing key (required) |

### Database

| Variable | Default | Description |
|---|---|---|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `kiranrock_trading` | Database name |
| `DB_USER` | `postgres` | DB username |
| `DB_PASSWORD` | — | DB password (required) |

### Broker & Data

| Variable | Default | Description |
|---|---|---|
| `DATA_PROVIDER` | `yahoo` | `yahoo` \| `alpaca` \| `polygon` |
| `BROKER` | `simulated` | `simulated` \| `alpaca` |
| `ALPACA_KEY_ID` | — | Alpaca API key |
| `ALPACA_SECRET_KEY` | — | Alpaca secret |
| `ALPACA_PAPER` | `true` | `true` = paper trading |
| `BOT_ENABLED` | `true` | Enable automated trading |
| `MAX_BOT_INVESTMENT_USD` | `5000` | Max capital per session |

### AI Controls

| Variable | Default | Description |
|---|---|---|
| `OLLAMA_BASE_URL` | — | e.g. `http://localhost:11434` — enables local AI |
| `OLLAMA_MODEL` | `llama3.2:3b` | Local model name |
| `OLLAMA_TIMEOUT_MS` | `45000` | Per-request timeout |
| `AI_TRADING_ENABLED` | `true` | **Kill switch** — set `false` to pause all autonomous trades |
| `ORACLE_ALLOW_CLAUDE_FALLBACK` | `false` | Enable Anthropic Claude fallback (costs $) |
| `ANTHROPIC_API_KEY` | — | Only needed if Claude fallback is enabled |
| `CLAUDE_MODEL` | `claude-haiku-4-5-20251001` | Claude model when fallback is active |
| `GEMINI_API_KEY` | — | Google Gemini for news sentiment (free tier ok) |
| `GEMINI_MODEL` | `gemini-2.0-flash-lite` | Gemini model |

### Risk Tuning

| Variable | Default | Description |
|---|---|---|
| `STOCK_UNIVERSE` | `TOP_200` | `ALL` \| `SP500` \| `TOP_200` \| `WATCHLIST` |
| `CIRCUIT_HALT_STREAK` | `5` | Halt after N consecutive losing trades |
| `CIRCUIT_REDUCE_STREAK` | `3` | Half sizing after N consecutive losses |
| `MAX_DRAWDOWN_PCT` | `15` | Halt if portfolio drops this % from peak |
| `DATA_MAX_AGE_MS` | `120000` | Stale data guard (2 min) |
| `AI_TRADING_ENABLED` | `true` | Set `false` to pause bot without stopping process |

### PANTHEON Agent Keys

| Variable | Description |
|---|---|
| `FRED_API_KEY` | FRED macro data (SHIELD) — free at fred.stlouisfed.org |
| `FINNHUB_KEY` | Smart money / institutional data (SONAR) |
| `NEWSAPI_KEY` | News headlines |
| `ALPHA_VANTAGE_KEY` | Supplemental market data |
| `REDDIT_CLIENT_ID` | Reddit alt data (SONAR retail sentiment) |
| `REDDIT_SECRET` | Reddit app secret |

### Universe Tuning

| Variable | Default | Description |
|---|---|---|
| `HERMES_MIN_MARKET_CAP` | `2000000000` | Min $2B market cap |
| `HERMES_MIN_AVG_VOLUME` | `300000` | Min 300k avg daily volume |
| `HERMES_MAX_STOCKS` | `150` | Max stocks in universe |
| `DYNAMIC_UNIVERSE_MAX` | `400` | Pre-market cache cap |

### Scheduling

| Variable | Default | Description |
|---|---|---|
| `PROPHET_WINDOW_MIN_DAYS` | `15` | Min days to earnings for PROPHET to fire |
| `PROPHET_WINDOW_MAX_DAYS` | `45` | Max days to earnings for PROPHET to fire |
| `COMPASS_LOOKBACK_DAYS` | `20` | Sector RS lookback |
| `COMPASS_CACHE_TTL_MS` | `1800000` | Sector cache TTL (30 min) |
| `NEWS_SENTIMENT_CACHE_MS` | `1800000` | News cache TTL (30 min) |

---

## 3. AI Components (PANTHEON)

PANTHEON is the suite of AI/analytical agents that layer on top of the code-based scoring engine.

### 3.1 ORACLE — Trade Verdict Agent

**File**: `backend/src/services/oracleService.js` (Claude fallback) + `backend/src/services/ollamaService.js` (primary)

**Purpose**: Final pass verdict on each candidate stock — TRADE / WATCHLIST / SKIP.

**When it fires**: After the stock passes pre-score threshold in the scoring pipeline.

**Data it receives**:
- Price, Stage, Pattern, RSI, MACD, ATR
- SMA50 / SMA150 / SMA200
- Volume vs avg volume
- EPS growth, Revenue growth, Days to earnings
- Gemini sentiment label
- Smart money score
- Sector rank
- R/R ratio, Entry, Stop, Target
- Market regime
- Up to 60 days of OHLCV history (from `ohlcv_cache` table)

**ORACLE 8-Step Scoring Prompt**:
```
STEP 1 — WEINSTEIN GATE:  Stage 3 or 4 = SKIP immediately
STEP 2 — TREND TEMPLATE:  0-25 pts (5 MA conditions × 5 pts)
STEP 3 — PATTERN:         VCP=10, Cup&Handle=9, Darvas=8, None=0
STEP 4 — CANSLIM:         EPS 25%+=8, Rev 20%+=6, Margins+3, Catalyst+3
STEP 5 — WYCKOFF VOLUME:  VDU+5, Up>Down vol+5, Breakout vol+5
STEP 6 — JONES R/R:       ≥3:1=15, ≥2:1=10, <2:1=SKIP
STEP 7 — GEMINI BONUS:    Bullish+5, Neutral=0, Bearish=-10
STEP 8 — SMART MONEY:     Institutional+8, Insider buy+5
VERDICT: ≥70=TRADE, 50-69=WATCHLIST, <50=SKIP
```

**Score adjustment applied to final code score**:

| Verdict | Confidence | Adj |
|---------|-----------|-----|
| TRADE | HIGH | +8 |
| TRADE | MEDIUM | +5 |
| TRADE | LOW | +3 |
| WATCHLIST | any | 0 |
| SKIP | HIGH | −15 |
| SKIP | MEDIUM | −10 |
| SKIP | LOW | −5 |

**Caching**: 15-minute TTL per symbol. Scan cycles (~10 min) reuse the cached verdict — reduces Ollama calls by ~70–80%.

**Fallback chain**:
1. Ollama (local, zero cost) — primary
2. Claude API — only if `ORACLE_ALLOW_CLAUDE_FALLBACK=true` AND `ANTHROPIC_API_KEY` set
3. Code score only — if both are unavailable

---

### 3.2 PROPHET — Earnings Forecaster

**File**: `backend/src/services/ollamaService.js` → `forecastEarnings()`

**Purpose**: Predict earnings outcome (BEAT / IN_LINE / MISS) when an earnings date is approaching.

**Window**: Only fires when `daysToEarnings` is between `PROPHET_WINDOW_MIN_DAYS` (15) and `PROPHET_WINDOW_MAX_DAYS` (45).

**Score adjustment**:

| Verdict | Confidence | Adj |
|---------|-----------|-----|
| BEAT | HIGH | +8 |
| BEAT | MEDIUM | +4 |
| BEAT | LOW | +2 |
| IN_LINE | any | 0 |
| MISS | HIGH | −8 |
| MISS | MEDIUM | −4 |
| MISS | LOW | −2 |

---

### 3.3 LocalBrain — Statistical Learning

**File**: `backend/src/services/localBrainService.js`

**Purpose**: Score boost/penalty based on what has **actually worked for this account**. No GPU required — pure SQL statistics from your own trade history.

**How it works**:
1. Pairs all BUY→SELL trades from `trades` table
2. Builds win-rate lookup by `sector × pattern × regime` combinations
3. Compares each cell's win rate to your overall win rate
4. Converts edge into a score boost: **−6 to +6**

**Priority chain** (most specific first):
1. Combined cell: `Technology|VCP|BULL_STRONG` (needs ≥ 5 trades in that exact combo)
2. Pattern-only: `VCP` (needs ≥ 5)
3. Sector-only: `Technology` (needs ≥ 5)
4. Returns `boost: 0` if no cell has enough data

**Refresh interval**: Every 4 hours.

**Current status**: Mostly inactive until ~200+ closed trades accumulate (61 trades = too sparse for combined cells).

---

### 3.4 Ollama — Local LLM Backend

**File**: `backend/src/services/ollamaService.js`

**Setup**:
```bash
ollama pull llama3.2:3b        # ~2 GB, needs ~4 GB RAM
# OR
ollama pull llama3.1:8b        # ~4.7 GB, needs ~8-10 GB RAM (better reasoning)
```

**Model size vs quality**:

| Model | Disk | RAM | JSON reliability | Reasoning |
|-------|------|-----|-----------------|-----------|
| llama3.2:3b | 2 GB | 4 GB | ~75% | Basic |
| llama3.1:8b | 4.7 GB | 8-10 GB | ~90% | Good |
| llama3.1:70b | ~40 GB | 48 GB+ | ~98% | Excellent |

**Functions exposed**:
- `getVerdict(data)` — ORACLE trade verdict (JSON)
- `getVerdictWithDBHistory(data)` — same + 60 days OHLCV from DB
- `forecastEarnings(...)` — PROPHET earnings prediction
- `generate(prompt)` — free-form text (reports, coaching)
- `explainBacktestResults(...)` — backtest narrative
- `explainLocalBrain(snapshot)` — coaching advice from trade history

**Temperature settings**: 0.1 for verdicts (deterministic), 0.35–0.45 for narratives.

---

### 3.5 GEMINI PULSE — News Sentiment

**File**: `backend/src/services/enhancedSignalService.js` (or similar)

**Purpose**: Analyses recent news headlines for each stock, returns `BULLISH / NEUTRAL / BEARISH` label.

**Impact**: ORACLE Step 7 uses this label (+5 / 0 / −10).

**Cost**: Free tier with `gemini-2.0-flash-lite`.

---

### 3.6 SHIELD — Macro Regime

**File**: `backend/src/services/marketRegimeService.js`

**Purpose**: Classify the macro market environment using 7 signals.

**Signals used**:
1. SPY price vs 200-day MA (primary trend)
2. SPY price vs 50-day MA
3. VIX level (fear gauge)
4. QQQ 20-day return (tech divergence)
5. TLT 20-day return (bond direction = rate environment)
6. SPY 5-day price range % (chop detection)
7. ATR(5)/ATR(20) expansion ratio
8. SPY volume vs 20-day avg

**Regimes** (priority order):

| Regime | Trigger | Min Score | Size Multiplier | New Entries |
|--------|---------|-----------|----------------|-------------|
| PANIC | VIX > 40 or 20d drop < −15% | 92 | 0.25× | **BLOCKED** |
| BEAR | SPY well below 200MA + 20d < −8% | 80 | 0.50× | Allowed (very high bar) |
| CHOPPY | Tight 5d range + ATR contracting | 78 | 0.55× | **BLOCKED** |
| NEUTRAL | SPY below 200MA or elevated VIX | 70 | 0.75× | Allowed |
| BULL_MILD | Above 200MA with headwinds | 65 | 0.70–0.90× | Allowed |
| BULL_STRONG | SPY+QQQ above MAs, VIX < 20 | 62 | 1.00× | Full |

**Post-classification adjustments**:
- 3+ consecutive SPY down days → minBuyScore +5 (max 85)
- Rising rates in BULL → minBuyScore +3
- FOMC decision day → minBuyScore +10; FOMC eve → +5

**Effective minimum score**: `max(riskConfig.minBuyScore=82, regime.minBuyScore)`

---

### 3.7 SONAR — Smart Money

**File**: `backend/src/services/fundamentalsService.js` (Finnhub integration)

**Purpose**: Track institutional ownership and insider transactions.

**Score impact**: ORACLE Step 8 — Institutional confirmed +8, Insider buy +5.

**Requires**: `FINNHUB_API_KEY`

---

### 3.8 COMPASS — Sector Rotation

**Purpose**: Rank sectors by relative strength over `COMPASS_LOOKBACK_DAYS` (default 20).

**Score impact**: `sectorRank` is passed to ORACLE for context.

**Cache TTL**: 30 min (`COMPASS_CACHE_TTL_MS`).

---

### 3.9 HERMES — Universe Filter

**File**: `backend/src/services/marketScreenerService.js`

**Purpose**: Filter the full stock universe down to tradeable candidates.

**Filters** (`passesQuickFilter`):
- Price > $5 (no penny stocks)
- Avg daily volume ≥ 200k
- Volume ratio ≥ 0.3 (not dead)
- Within 60% of 52-week high (Minervini proximity, non-ETFs only)
- Market cap ≥ `HERMES_MIN_MARKET_CAP` ($2B default)

---

## 4. Stock Universe & Scanning

### 4.1 Pre-Market Cache Build

**File**: `backend/src/services/dynamicUniverseService.js`

**Triggered**: 8:45 AM ET Mon–Fri by `assetUniverseScheduler`

**Sources merged**:

| Source | Count | API calls |
|--------|-------|-----------|
| Static `static-major-us-tickers.json` | 244 symbols | None |
| DB asset universe (Alpaca) | ~100–500 | None |
| Yahoo trending symbols | up to 40 | 1 |
| Yahoo day_gainers + most_actives | up to 80 | 2 |
| Yahoo pre_market_gainers | up to 30 | 1 |
| **Total pool (deduplicated)** | ~350–600 | **4 calls** |

**Quote fetching**: Batches of 5 symbols, 2-second delay between batches → ~3–4 minutes.

**After filtering**: 150–300 stocks pass HERMES filters.

**Hard cap**: `DYNAMIC_UNIVERSE_MAX` (default 400), sorted by tier → RS score.

**Cache**: In-memory, expires at midnight ET. One build per calendar day.

**During market hours**: `getScanUniverse()` returns the cached array — **zero Yahoo API calls**.

---

### 4.2 Intraday Movers Refresh

**File**: `backend/src/services/dynamicUniverseService.js` → `refreshIntradayMovers()`

**Triggered**: Hourly 10 AM–3 PM ET, with internal 75-min cooldown (~3 actual refreshes/day)

**What it does**:
1. Fetches day_gainers (25) + most_actives (25) from Yahoo — 2 API calls
2. Finds symbols not already in the in-memory cache
3. Fetches quotes for ≤20 new candidates
4. Applies same HERMES filters
5. Merges qualified stocks into `_universeCache`

**Why it matters**: The pre-market build is a snapshot. Stocks that break out at 11 AM were not in the 8:45 AM universe — this refresh catches them.

**Guards**: Only runs during market hours (9:30–4:00 PM ET) + cache must exist + 75-min cooldown.

---

### 4.3 Adaptive Universe Cap

Applied in `enhancedAITradingBot.js` when reading the universe:

| Regime | Universe analyzed |
|--------|-----------------|
| BULL_STRONG | 400 stocks |
| BULL_MILD | 350 stocks |
| NEUTRAL | 250 stocks |
| BEAR | 150 stocks |

**Rationale**: In weak regimes, a larger universe mostly adds noise — more false signals, not more alpha.

---

## 5. Market Regime Detection

Detailed flow in `marketRegimeService.getMarketRegime()`:

```
Fetch: SPY (210 days), QQQ (60 days), TLT (30 days), VIX quote
         ↓
Compute: MA200, MA50, VIX, QQQ return, TLT return,
         5d range %, ATR expansion ratio, volume ratio
         ↓
Classify: PANIC → BEAR → CHOPPY → NEUTRAL → BULL_MILD → BULL_STRONG
         ↓
Adjust: FOMC window, consecutive loss days, rising rates
         ↓
Cache: 60 min (stale fallback: 6 hours)
```

Regime is cached for 60 min. All trading decisions in a session use the same regime snapshot.

---

## 6. AI Scoring Pipeline

Each stock goes through this pipeline in `scanMarketForOpportunities`:

```
1.  Minervini Quick Filter   (passesQuickFilter — eliminates ~60% immediately)
2.  Stage Detection          (Weinstein stage 1-4 via MA relationships)
3.  Pattern Recognition      (VCP, Cup&Handle, Darvas, Flag, None)
4.  Technical Indicators     (RSI, MACD, ATR, Bollinger Bands, momentum)
5.  Fundamental Overlay      (EPS growth, revenue growth, margins)
6.  Macro Model              (regime type + rising rates)
7.  Mean-Reversion Check     (RSI < 55, %B < 0.65)
8.  Sector Rank              (COMPASS relative strength)
9.  News Sentiment           (GEMINI PULSE label → score adj)
10. Smart Money              (Finnhub institutional/insider)
11. PROPHET                  (earnings forecast if 15-45 days away)
12. LocalBrain               (historical win-rate boost, −6 to +6)
13. Regime Alignment         (BULL_STRONG +8, BEAR −8)
14. ORACLE / Ollama          (full Bull/Bear verdict, score adj −15 to +8)
15. Confidence Formula       (aiScore − 50) / 50 × 100 → 0–100%
16. minBuyScore Gate         (≥ 82 required, regime-adjusted)
17. R/R Gate                 (≥ 2.0:1 required)
18. Sector / Industry Cap    (≤ 2 per industry, ≤ 30% per sector)
```

**Confidence formula**: `Math.min(100, Math.max(0, (aiScore - 50) / 50 * 100))`
- Score 82 → 64% confidence (minimum tradeable)
- Score 90 → 80% confidence
- Score 100 → 100% confidence

---

## 7. Risk Management

### 7.1 Position Sizing

Position size is computed as a chain of multipliers applied to Kelly fraction:

```
Base Kelly fraction (from last 90 days win rate + avg win/loss)
  × confidence multiplier  (opportunity.confidence / 100)
  × streak multiplier      (losing streak reduces size)
  × regime multiplier      (BULL_STRONG=1.0×, BEAR=0.5×, PANIC=0.25×)
  × expectancy multiplier  (recent P&L trend)
  ÷ ATR normalization      (position sized to 1 ATR of risk)
  → if drawdown Level 1:  × 0.5
  → confidence hard cap:  min(positionSize, portfolioValue × maxByConf)
  → maxOrderNotional cap: skip if notional > ~$5,000
```

**Confidence-based Kelly hard caps**:

| Confidence | Max % of portfolio |
|-----------|-------------------|
| ≥ 90% | 9% |
| ≥ 80% | 7% |
| ≥ 70% | 5% |
| ≥ 60% | 3% |
| < 60% | 2% |

**VIX-adaptive ATR scaling** (applied to sector stop/target multipliers):

| VIX | ATR scale |
|-----|---------|
| < 15 | × 0.90 |
| < 20 | × 1.00 |
| < 25 | × 1.25 |
| ≥ 25 | × 1.55 |

**Sector ATR trade profiles**:

| Profile | Sectors | Stop mult | Target mult |
|---------|---------|-----------|-------------|
| AGGRESSIVE | Technology, Comm Services, Consumer Disc | ATR × 2.0 | ATR × 4.0 |
| STANDARD | Financials, Healthcare, Industrials, Materials, Energy | ATR × 1.5 | ATR × 3.0 |
| DEFENSIVE | Utilities, Consumer Staples, Real Estate | ATR × 1.2 | ATR × 2.0 |

---

### 7.2 Entry Gates

All of these must pass before a buy executes:

| Gate | Threshold | Notes |
|------|-----------|-------|
| minBuyScore | ≥ 82 | Regime-adjusted upward in BEAR/PANIC |
| R/R ratio | ≥ 2.0:1 | Hard block if undefined or below |
| Max open positions | From DB config | Default 10 |
| Max daily trades | Session config | Circuit-breaker adjusted |
| Sector cap | ≤ 30% of portfolio | Prevents sector concentration |
| Industry cap | ≤ 2 per industry group | Prevents sub-sector clustering |
| Gross exposure | ≤ 75% of portfolio | SHIELD exposure cap |
| Portfolio beta | ≤ 1.5 | Correlation cap |
| Bleeding symbols | Block | Stocks that lost 3+ times |
| After 3:30 PM ET | Block | Swing trade guard — no late entries |
| PANIC regime | Block | Hard halt on new entries |
| CHOPPY regime | Block | Hard halt on new entries |
| AI_TRADING_ENABLED | Must be `true` | Kill switch |
| DATA_MAX_AGE_MS | Data < 2 min old | Stale data guard |
| FOMC day | Score +10 required | Higher bar on Fed decision days |

---

### 7.3 Exit Logic

Managed in `manageExistingPositions()` per holding each cycle:

| Exit type | Trigger | Swing guard |
|-----------|---------|-------------|
| Hard stop-loss | Position down −3% | None — fires always |
| Trailing stop | Current price ≤ peak × (1 − 3%) | Skip if held < 18 hours |
| Full take-profit | Position up +25% | Skip if held < 18 hours |
| Partial take-profit | Position up +15% (sells 50%) | Skip if held < 18 hours |
| Large loss alert | Down −10% | Alert only, no sell |

**Swing trade hold rule**: Trailing stop and take-profit are suppressed for positions opened within the last 18 hours. This prevents same-day exits — all trades are intended as multi-day swings. The hard stop-loss always fires regardless.

---

### 7.4 Circuit Breakers

Three-level system:

| Level | Trigger | Effect |
|-------|---------|--------|
| Reduce (Level 1) | ≥ 3 consecutive losses | Position sizes halved |
| Paper-only (Level 2) | Portfolio down > `MAX_DRAWDOWN_PCT` % from peak | No new live buys |
| Halt (Level 3) | ≥ 5 consecutive losses | Trading fully stopped |

**FOMC window protection**: Score threshold raised +10 on Fed decision day, +5 on eve.

**OPEX protection**: 3rd Friday of month — identified and score threshold raised.

---

### 7.5 Swing Trade Rules

Enforced as of the current build:

1. **No entries after 3:30 PM ET** — scan cycle skips buy loop, manages exits only
2. **18-hour minimum hold** — trailing stop and take-profits suppressed for same-day entries
3. **Hard stop-loss** always fires (−3%) — no time restriction on risk management
4. **Target hold**: 2–10 trading days (enforced behaviorally via ATR×3-4 targets and 3% trailing stop)

---

## 8. Sector & Industry Controls

**File**: `backend/src/services/sectorMetadataService.js`

### Sector Resolution Priority

```
1. Yahoo live sector (from quote)
2. Static SECTOR_MAP (~400 tickers hardcoded)
3. 'Unknown'
```

### Industry Correlation Groups (MAX 2 per group)

| Group | Key tickers |
|-------|------------|
| Trucking | SNDR, CVLG, HTLD, KNX, JBHT, MRTN, ARCB, WERN, ODFL, SAIA |
| Airlines | DAL, UAL, AAL, LUV, SAVE, JBLU, ALK |
| Semiconductors | NVDA, AMD, INTC, QCOM, AVGO, MU, TXN |
| Semiconductor Equipment | AMAT, LRCX, KLAC, ASML, ONTO |
| Regional Banks | WAL, PACW, ZION, RF, CFG, FITB |
| Money Center Banks | JPM, BAC, WFC, C, GS, MS |
| Oil & Gas E&P | XOM, CVX, COP, EOG, PXD, DVN |
| Biotech | MRNA, BNTX, REGN, BIIB, VRTX, GILD |
| Cloud Software | CRM, NOW, SNOW, DDOG, NET, ZS, OKTA |
| EV & Clean Energy | TSLA, RIVN, LCID, NIO, ENPH, SEDG |
| Homebuilders | LEN, DHI, PHM, TOL, MDC |
| Cruise Lines | CCL, RCL, NCLH |
| Digital Advertising | META, GOOGL, TTD, MGNI |

**Sector cap**: No single sector > 30% of open positions.
**Industry cap**: Max 2 positions per industry group.

---

## 9. Scheduler Reference

All times are **Eastern Time (ET)**. Managed in `assetUniverseScheduler.js`.

| Time | Days | Job | Description |
|------|------|-----|-------------|
| 7:30 AM | Mon–Fri | Pre-market refresh | Pull premarket movers, seed daily universe |
| 8:45 AM | Mon–Fri | Dynamic universe build | Full pre-market cache build (main scan universe) |
| Every 5 min 9–4 PM | Mon–Fri | Intraday DB discovery | Add trending symbols to DB universe |
| 10,11,12,1,2,3 PM | Mon–Fri | Intraday cache refresh | Merge ≤20 movers into live in-memory cache |
| 5:30 PM | Mon–Fri | After-close OHLCV | Download daily bars for 244 static symbols |
| 8:00 PM | Mon–Fri | Evening refresh | Full Alpaca asset refresh + rebuild daily universe |

**AI Trading Scheduler** (separate, in `enhancedAIScheduler.js`):
- Runs `scanMarketForOpportunities` + `manageExistingPositions` on a defined interval during market hours
- Respects `AI_TRADING_ENABLED` flag
- PANIC/CHOPPY regimes → exits only

**Report Scheduler**:
- Mon–Fri 7:00 AM — daily predictions Telegram report
- Mon–Fri 4:15 PM — AI bot daily summary Telegram report
- Sunday 8:00 AM — weekly buy list
- Sunday 9:00 AM — weekly recap

---

## 10. Performance Analytics API

All endpoints require JWT auth (`Authorization: Bearer <token>`).

### `GET /api/performance/scorecard`
Live dashboard: today's P&L, 30-day Sharpe, drawdown, win rate, circuit breaker status, Kelly metrics, current market regime.

### `GET /api/performance/advanced`
Extended analytics from trade history:
- **holdTime**: avg/median/min/max hold hours
- **timeOfDay**: win rate broken down by entry hour (ET)
- **slippage**: signal price vs fill price stats
- **maeMfe**: MAE/MFE excursion analytics (requires OHLCV history in DB)

**MAE/MFE fields**:

| Field | Meaning |
|-------|---------|
| `avgMaePct` | Avg max adverse excursion (negative = how far price went against you) |
| `avgMfePct` | Avg max favorable excursion (positive = how far price went in your favour) |
| `avgProfitCapturePct` | Realised PnL as % of MFE — if < 50%, exits are too early |
| `medianMaePct` | Median MAE |
| `medianMfePct` | Median MFE |

### `GET /api/performance/overfit`
Overfitting risk report (5 checks):

| Check | What it measures | HIGH trigger |
|-------|-----------------|--------------|
| Walk-forward stability | σ of win rates across 30-trade windows | σ > 18% |
| OOS decay | Last 30 vs prior 31-90 trades | Decay < −12% |
| Regime concentration | Top regime share of profitable P&L | > 75% with 3+ regimes |
| Consistency | % of 10-trade windows with ≥ 60% win rate | < 40% |
| Confidence calibration | Predicted confidence vs actual win rate per bucket | Error > 15% |

**Composite**: 2+ HIGH checks → overall HIGH overfit risk.

### `GET /api/performance/regime?days=180`
P&L breakdown by market regime:

| Field | Description |
|-------|-------------|
| `regime` | BULL_STRONG, BULL_MILD, NEUTRAL, BEAR, etc. |
| `totalTrades` | Trade count |
| `winRatePct` | Win rate % |
| `netPnl` | Total net P&L |
| `avgPnlPerTrade` | Average P&L per trade |
| `avgScore` | Average AI score of trades taken |
| `avgConfidence` | Average confidence % |

### `GET /api/performance/kelly`
Kelly Criterion inputs from last 90 days: win rate, avg win, avg loss, full Kelly fraction, half-Kelly.

### `GET /api/performance/history?days=30`
Daily P&L history array for charting. Max 90 days.

### `GET /api/performance/intelligence?days=180`
Aggregated AI learning view from `trade_decision_journal` — setup families, strategy families, regime breakdown.

### `GET /api/performance/sharpe?days=30`
Sharpe ratio for last N days.

---

## 11. All API Endpoints

### Auth
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`

### Trading
- `GET /api/trading/positions` — current holdings
- `POST /api/trading/buy` — manual buy
- `POST /api/trading/sell` — manual sell
- `GET /api/trading/history` — trade history
- `GET /api/trading/account` — account balance

### Enhanced AI Trading
- `POST /api/enhanced-ai-trading/scan` — trigger market scan
- `GET /api/enhanced-ai-trading/status` — bot status
- `POST /api/enhanced-ai-trading/manage-positions` — trigger exit management
- `GET /api/enhanced-ai-trading/opportunities` — latest scored opportunities

### AI Trading (Autonomous)
- `POST /api/ai-trading/start` — start autonomous bot
- `POST /api/ai-trading/stop` — stop autonomous bot
- `GET /api/ai-trading/status`

### Performance (see section 10)
- `GET /api/performance/scorecard`
- `GET /api/performance/advanced`
- `GET /api/performance/overfit`
- `GET /api/performance/regime`
- `GET /api/performance/kelly`
- `GET /api/performance/history`
- `GET /api/performance/intelligence`
- `GET /api/performance/intelligence/drilldown`
- `GET /api/performance/sharpe`
- `GET /api/performance/daily`
- `GET /api/performance/weekly`
- `GET /api/performance/monthly`
- `POST /api/performance/sync-balance`

### Backtest
- `POST /api/backtest/run` — run historical backtest
- `GET /api/backtest/results`

### Stocks & Signals
- `GET /api/stocks/:symbol` — stock quote + indicators
- `GET /api/signals/:symbol` — trading signals
- `GET /api/enhanced-signals/:symbol`

### Screener
- `GET /api/screener/universe` — current universe
- `GET /api/screener/top` — top scored stocks

### Asset Universe
- `GET /api/asset-universe/status` — universe cache status + scheduler status
- `POST /api/asset-universe/build-dynamic` — manual trigger of pre-market build

### News
- `GET /api/news/:symbol` — news headlines
- `GET /api/news-aggregation/summary`

### System
- `GET /health` — health check (DB, provider, version)
- `GET /api/system/status` — full system status

---

## 12. Database Schema — Key Tables

### `trades`
```
id, user_id, symbol, action (BUY/SELL), quantity, price, total,
commission, trade_date, executed_by, notes (JSON), ai_score, sector
```

### `holdings`
```
id, user_id, symbol, quantity, average_price, current_price,
market_value, gain_loss, gain_loss_percent, peak_price,
partial_profit_taken, sector, purchase_date, updated_at
```

### `ohlcv_cache`
```
symbol, date, open, high, low, close, volume (NUMERIC 14,4)
```
Used for: MAE/MFE retroactive computation, Ollama DB-enriched verdicts (60 days of history), backtest engine.

### `trade_decision_journal`
```
id, user_id, bot_type, symbol, setup_family, strategy_family,
regime, decision_phase (CANDIDATE|EXECUTED|CLOSED), score,
score_adjustment, confidence, pnl, pnl_percent, metadata (JSON),
opened_at, closed_at
```
Used for: Intelligence reports, regime P&L breakdown, overfit detection.

### `ai_performance_metrics`
```
id, user_id, date, total_trades, winning_trades, losing_trades,
win_rate, total_profit_loss, average_profit, average_loss,
profit_factor, sharpe_ratio, max_drawdown, current_streak,
consecutive_losses, daily_loss
```

### `asset_universe` / `asset_universe_daily`
Alpaca-sourced master + daily analysis universe. Separate from the in-memory `_universeCache`.

---

## 13. Operational Runbook

### Start Everything
```powershell
# From c:\MyProject\KiranRock
.\start.ps1
```
Opens 4 terminals: backend, worker, signal delivery, frontend.

### Stop Everything
Re-run `start.ps1` — it kills existing KiranRock processes before restarting.

Or kill individual terminals manually.

### Kill Switch (pause trading without restart)
```bash
# In backend/.env
AI_TRADING_ENABLED=false
```
Restart worker only. EOD cleanup and position monitoring continue. No new buys.

### Trigger Manual Market Scan
```bash
curl -X POST http://localhost:3001/api/enhanced-ai-trading/scan \
  -H "Authorization: Bearer <your_token>"
```

### Trigger Pre-Market Universe Build Manually
```bash
curl -X POST http://localhost:3001/api/asset-universe/build-dynamic \
  -H "Authorization: Bearer <your_token>"
```

### Check System Health
```bash
curl http://localhost:3001/health
```

### Check Universe Cache Status
```bash
curl http://localhost:3001/api/asset-universe/status \
  -H "Authorization: Bearer <your_token>"
```

### Start Ollama (if not running)
```bash
ollama serve
# In another terminal:
ollama run llama3.2:3b
```

### Memory Limits
```bash
# Set in package.json scripts (already done):
node --max-old-space-size=512 src/app.js
node --max-old-space-size=512 src/worker.js
```

### Check Logs
Worker logs show ORACLE verdicts, trade decisions, circuit breaker events, and regime changes in real time.

### Upgrade Ollama Model (better ORACLE reasoning)
```bash
ollama pull llama3.1:8b     # needs 8 GB RAM minimum
# Update backend/.env:
OLLAMA_MODEL=llama3.1:8b
OLLAMA_TIMEOUT_MS=90000     # longer timeout for larger model
```

---

## 14. Known Limitations & Roadmap

### Current Limitations

| Area | Issue | Impact |
|------|-------|--------|
| Ollama model size | llama3.2:3b has weak structured reasoning | ORACLE verdicts may be noisy |
| LocalBrain data | Only 61 trades — most cells too sparse | Brain mostly inactive |
| MAE/MFE | Needs OHLCV history in `ohlcv_cache` | Report shows "no data" until backfill runs |
| Exit sophistication | No time-based or momentum-based exit | Exits are mechanical (% thresholds only) |
| Benchmark comparison | No SPY/QQQ comparison in reports | Can't prove alpha vs passive |

### Implemented Protections

- [x] PANIC/CHOPPY hard block on new entries
- [x] BEAR regime −8 score penalty + 50% sizing
- [x] minBuyScore = 82 (targets ≤35 trades/month)
- [x] 2:1 minimum R/R gate (hard block)
- [x] VIX-adaptive ATR stops (0.90×–1.55×)
- [x] Industry correlation caps (max 2 per group)
- [x] Confidence formula calibrated (score 82 → 64%, not inflated 79%)
- [x] ORACLE score cap (+8 max, was +12) — prevents weak code scores rescued by AI alone
- [x] Walk-forward / OOS / consistency / calibration overfit checks
- [x] Dynamic pre-market universe (zero Yahoo calls during market hours)
- [x] Intraday movers refresh (75-min, ≤20 new symbols)
- [x] Adaptive universe cap by regime
- [x] ORACLE 15-min verdict cache (~70–80% compute reduction)
- [x] Swing trade guards (no entries after 3:30 PM, 18-hr min hold)
- [x] Kelly confidence hard caps by tier
- [x] MAE/MFE analytics endpoint
- [x] Regime P&L breakdown endpoint

### Roadmap (Priority Order)

**Tier 1 — High value, relatively easy**
- [ ] Benchmark expectancy: compare bot returns vs SPY buy-and-hold over same period
- [ ] Upgrade Ollama to llama3.1:8b (if 16 GB RAM available)
- [ ] Rejected-symbol tracking: log SKIP decisions + future price to discover hidden alpha archetypes

**Tier 2 — Medium complexity**
- [ ] Exit optimization engine: dynamic exits based on MAE/MFE patterns once data accumulates
- [ ] Adaptive stop-loss: widen stop during high ATR expansion, tighten in compression
- [ ] Spread/slippage simulation: estimate realistic fill costs in backtest

**Tier 3 — Advanced / future**
- [ ] Walk-forward live validation: auto-compare paper vs live once live trading enabled
- [ ] Ensemble signal voting: majority vote across multiple scoring models
- [ ] Dynamic factor rotation: shift between momentum / value / quality factors by regime
- [ ] Bayesian confidence calibration: update confidence priors from actual outcomes

---

*Document generated 2026-05-22. Reflects codebase state on branch `feature/trade-lots-migration`.*
