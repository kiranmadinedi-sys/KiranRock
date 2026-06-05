# KiranRock Autonomous Trading System
## Technical Reference & Architecture Guide

**Version:** 2.0  
**Last Updated:** May 2026  
**Author:** Rock  
**Stack:** Node.js · PostgreSQL · Next.js · Alpaca Markets · Yahoo Finance · Polygon.io

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Data Provider Layer](#3-data-provider-layer)
   - 3.1 [Provider Chain & Fallback Logic](#31-provider-chain--fallback-logic)
   - 3.2 [Provider Capabilities Matrix](#32-provider-capabilities-matrix)
   - 3.3 [Caching Strategy](#33-caching-strategy)
4. [Broker Abstraction Layer](#4-broker-abstraction-layer)
   - 4.1 [Broker Selection](#41-broker-selection)
   - 4.2 [ARROW Order Lifecycle](#42-arrow-order-lifecycle)
   - 4.3 [Safety Controls](#43-safety-controls)
5. [AI Intelligence Pipeline (PANTHEON)](#5-ai-intelligence-pipeline-pantheon)
   - 5.1 [Scoring Architecture](#51-scoring-architecture)
   - 5.2 [Agent Directory](#52-agent-directory)
6. [Market Regime Engine](#6-market-regime-engine)
   - 6.1 [Regime Classification](#61-regime-classification)
   - 6.2 [Regime Impact on Trading](#62-regime-impact-on-trading)
7. [Stock Universe & Screener](#7-stock-universe--screener)
   - 7.1 [Dynamic Universe Service](#71-dynamic-universe-service)
   - 7.2 [Quick Filter Rules](#72-quick-filter-rules)
8. [Autonomous Trading Bot](#8-autonomous-trading-bot)
   - 8.1 [Trade Execution Loop](#81-trade-execution-loop)
   - 8.2 [Position Sizing (Kelly Criterion)](#82-position-sizing-kelly-criterion)
   - 8.3 [Exit Strategy](#83-exit-strategy)
   - 8.4 [Risk Guards](#84-risk-guards)
9. [Autonomous Options Bot](#9-autonomous-options-bot)
10. [Scheduler & EOD Automation](#10-scheduler--eod-automation)
11. [Performance Analytics](#11-performance-analytics)
12. [Weekly Prediction Engine](#12-weekly-prediction-engine)
13. [Telegram Alerts](#13-telegram-alerts)
14. [API Endpoint Reference](#14-api-endpoint-reference)
    - 14.1 [Authentication](#141-authentication)
    - 14.2 [Trading (Manual)](#142-trading-manual)
    - 14.3 [AI Trading (Basic)](#143-ai-trading-basic)
    - 14.4 [Enhanced AI Trading](#144-enhanced-ai-trading)
    - 14.5 [Options Bot](#145-options-bot)
    - 14.6 [Performance](#146-performance)
    - 14.7 [Backtest](#147-backtest)
    - 14.8 [Weekly Predictions](#148-weekly-predictions)
    - 14.9 [Market Data & Signals](#149-market-data--signals)
    - 14.10 [Watchlist & Screener](#1410-watchlist--screener)
    - 14.11 [System](#1411-system)
15. [Database Schema](#15-database-schema)
16. [Redis State Management](#16-redis-state-management)
17. [Environment Variables Reference](#17-environment-variables-reference)
18. [Deployment & Operations](#18-deployment--operations)
19. [News & Sentiment Architecture](#19-news--sentiment-architecture)
    - 19.1 [News Sources](#191-news-sources)
    - 19.2 [X/Twitter Integration](#192-xtwitter-integration)
    - 19.3 [Sentiment Scoring Flow](#193-sentiment-scoring-flow)
20. [Multi-Model AI Ensemble](#20-multi-model-ai-ensemble)
21. [Historical Backtest Engine](#21-historical-backtest-engine)
    - 21.1 [Methodology](#211-methodology)
    - 21.2 [Go-Live Criteria](#212-go-live-criteria)
22. [Trade Intelligence & Expectancy](#22-trade-intelligence--expectancy)
23. [Trade Auto-Tagging System](#23-trade-auto-tagging-system)
24. [Activation Gates — PANTHEON Progression](#24-activation-gates--pantheon-progression)
25. [Sector Trade Profiles](#25-sector-trade-profiles)
26. [Worker Coordination](#26-worker-coordination)
27. [Complete Database Table Reference](#27-complete-database-table-reference)
28. [Frontend Page Map](#28-frontend-page-map)
29. [Setup & Installation Guide](#29-setup--installation-guide)
30. [Troubleshooting Guide](#30-troubleshooting-guide)
31. [Glossary](#31-glossary)

---

## 1. System Overview

KiranRock is a fully autonomous AI-driven trading platform that combines:

- **Real-time market data** from multiple providers with automatic failover
- **PANTHEON AI pipeline** — 10 specialized agents that each contribute a bounded score adjustment to a composite trade decision
- **Market regime detection** — 5-regime classification that dynamically adjusts position sizing, entry bar, and exit thresholds
- **Autonomous stock and options trading** via Alpaca Markets paper/live accounts
- **Sector rotation intelligence** via COMPASS (11-sector RS tracking vs SPY)
- **End-of-day automation** — anomaly detection, auto-pause, daily digest, weekly health reports
- **Backtest engine** — walk-forward validation with Sharpe, Calmar, and win-rate metrics

The system is designed for a single operator managing a paper-trading portfolio with the option to switch to live trading via environment variable.

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        NEXT.JS FRONTEND (Port 3000)                 │
│              Dashboard · Charts · Trade History · Controls           │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ HTTP / REST
┌───────────────────────────────▼─────────────────────────────────────┐
│                     EXPRESS API SERVER (Port 3001)                   │
│  Auth · Trading · AI Trading · Options · Performance · Weekly · ...  │
│                    JWT Auth · Helmet · Rate-Limit                    │
└──┬──────────────────┬──────────────────┬────────────────────────────┘
   │                  │                  │
   ▼                  ▼                  ▼
┌──────────┐  ┌───────────────┐  ┌───────────────────────────────────┐
│PostgreSQL│  │  Redis State  │  │        DATA PROVIDER LAYER         │
│  (Main   │  │  HALT_ALL     │  │  Primary → Fallback → Emergency    │
│  Store)  │  │  POSITIONS    │  │  Alpaca/Polygon → Yahoo Finance    │
│          │  │  AGENT_HEALTH │  │  (auto-switch on 429/error)        │
└──────────┘  └───────────────┘  └───────────────────────────────────┘
                                              │
┌─────────────────────────────────────────────▼──────────────────────┐
│                   PANTHEON AI SCORING PIPELINE                      │
│  ORACLE · VISION · PROPHET · SAGE · SONAR · PULSE · LOCAL BRAIN    │
│  EVOLVE · SHIELD (FRED Macro) · COMPASS (Sector RS)                │
└────────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼────────────────────────────────────┐
│                   ENHANCED AI TRADING BOT                           │
│  Market Regime → Universe Filter → Score → Kelly Size → Execute    │
└───────────────────────────────┬────────────────────────────────────┘
                                │
                     ┌──────────▼──────────┐
                     │   BROKER LAYER       │
                     │  Simulated (DB)      │
                     │  Alpaca Markets      │
                     └──────────────────────┘
                                │
                     ┌──────────▼──────────┐
                     │  TELEGRAM ALERTS     │
                     │  Trade · Risk · EOD  │
                     └──────────────────────┘
```

---

## 3. Data Provider Layer

**Primary file:** `backend/src/services/dataProvider.js`

### 3.1 Provider Chain & Fallback Logic

The system uses a **three-tier provider chain** selected by the `DATA_PROVIDER` environment variable. All providers are wrapped in `withYahooFallback()` — if the primary provider fails or returns null, the system automatically retries via Yahoo Finance before throwing.

```
Request for market data
        │
        ▼
┌─────────────────────────┐
│  Is symbol an index?    │──YES──▶  Yahoo Finance (always)
│  (^VIX, ^GSPC, etc.)   │          [5-min TTL cache]
└────────────┬────────────┘
             │ NO
             ▼
┌─────────────────────────┐
│  Is symbol Yahoo-only?  │──YES──▶  Yahoo Finance (always)
│  (DIA, IWM, GLD, TLT,  │
│   sector ETFs, VXX...)  │
└────────────┬────────────┘
             │ NO
             ▼
┌─────────────────────────────────────────────────────┐
│  DATA_PROVIDER env var                              │
│                                                     │
│  alpaca  ──▶  Alpaca Markets API                   │
│               ↓ on error/null                       │
│               Yahoo Finance (emergency fallback)    │
│                                                     │
│  polygon ──▶  Polygon.io API                       │
│               ↓ on error/null                       │
│               Yahoo Finance (emergency fallback)    │
│                                                     │
│  yahoo   ──▶  Yahoo Finance (default)              │
│  (default)    No fallback needed                    │
└─────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────┐
│  Local PostgreSQL Cache  │  (daily bars only, checked first)
│  before any API call     │
└─────────────────────────┘
```

**Why Yahoo Finance is always available:** Yahoo Finance requires no API key and provides sufficient data for scoring. It serves as the universal safety net so the system never halts due to a paid-provider outage.

### 3.2 Provider Capabilities Matrix

| Capability | Yahoo Finance | Alpaca Markets | Polygon.io |
|------------|:------------:|:--------------:|:----------:|
| Real-time quotes | ❌ (~15 min delay) | ✅ | ✅ |
| Historical OHLCV | ✅ | ✅ | ✅ |
| Options chains | ⚠️ Limited | ❌ | ✅ Full |
| Pre-market / AH data | ✅ | ✅ | ✅ |
| Index symbols (^VIX) | ✅ | ❌ | ❌ |
| API key required | ❌ Free | ✅ | ✅ |
| Rate limit concern | ⚠️ 429s frequent | Low | Low |

**Recommendation:** Set `DATA_PROVIDER=alpaca` for real-time quotes during trading hours. Yahoo Finance handles all index/ETF data automatically.

### 3.3 Caching Strategy

| Data Type | Cache Location | TTL |
|-----------|---------------|-----|
| Index quotes (^VIX, ^GSPC) | In-memory | 5 minutes |
| Daily OHLCV bars | PostgreSQL `daily_bars` | Until next trading day |
| SPY 20-day return | In-memory (`cacheService`) | 15 minutes |
| SPY 60-day return series | In-memory | 15 minutes |
| Fundamentals (CANSLIM) | `cacheService` | 4 hours |
| News sentiment per symbol | `cacheService` | 30 minutes |
| News sentiment stale fallback | `cacheService` | 6 hours |
| Market regime | In-memory | 60 minutes |
| Bleeding symbols (chronic losers) | In-memory per user | 4 hours |
| System health multiplier | In-memory per user | 30 minutes |
| COMPASS sector RS | `cacheService` | 30 minutes |
| SONAR smart money score | In-memory | 24 hours |
| ORACLE verdict per symbol | In-memory | 1 hour |
| GEMINI PULSE sentiment | In-memory | 30 minutes |
| LOCAL BRAIN win-rate table | File (`data/sage/`) | 4 hours |
| EVOLVE decision table | File | 24 hours |

---

## 4. Broker Abstraction Layer

**Primary file:** `backend/src/services/brokerService.js`

### 4.1 Broker Selection

The broker is selected via the `BROKER` environment variable:

| `BROKER` value | Description | Order Storage |
|----------------|-------------|---------------|
| `simulated` (default) | Paper trades stored in PostgreSQL | `trades`, `holdings` tables |
| `alpaca` | Real orders via Alpaca API (paper or live) | Alpaca + audit log |

Switch between brokers by changing `BROKER=alpaca` in `.env` — no code changes required.

**Alpaca paper vs live:** Controlled by `ALPACA_PAPER=true/false`. Paper trading uses Alpaca's sandbox environment with fake money. The system defaults to paper mode.

### 4.2 ARROW Order Lifecycle

All orders pass through the **ARROW order state machine** — an append-only audit log that prevents duplicate submissions and provides full traceability.

```
CREATED
   │
   ▼
VALIDATED ──── fails validation ──▶ REJECTED (terminal)
   │
   ▼
SUBMITTED
   │
   ▼
PENDING_FILL
   │         │
   ▼         ▼
PARTIALLY  FILLED
_FILLED       │
   │          ▼
   │       OPEN_WITH_STOP
   │          │         │
   └──────────▼         ▼
           STOPPED    CLOSED
              │         │
              └────┬────┘
                   ▼
               JOURNALED (terminal)
                   │
        CANCELED (terminal — EOD cleanup at 15:45 ET)
```

**Idempotency:** Each order has a unique key. Duplicate submissions are silently rejected.

**Order execution by broker:**

| Operation | Simulated | Alpaca |
|-----------|-----------|--------|
| `buyMarket(symbol, shares)` | Instant fill at quote | Limit order at ask + 0.5% |
| `buyBracket(symbol, shares, stop, target)` | Falls back to buyMarket | Atomic bracket: entry + stop-loss + take-profit |
| `sellMarket(symbol, shares)` | Instant fill at quote | Limit order at bid − 0.5% |
| `getAccountInfo()` | DB balance | Live Alpaca account |
| `getPositions()` | DB holdings | Live Alpaca positions |

### 4.3 Safety Controls

Controls are layered from broadest to narrowest:

| Layer | Control | Default |
|-------|---------|---------|
| Environment | `BOT_ENABLED=false` | Bot never places orders |
| Environment | `AI_TRADING_ENABLED=false` | Scan runs but no new entries |
| Redis | `HALT_ALL` key | All scheduler cycles skip |
| Database | Global trading kill switch | Operator-set via `/api/system` |
| Database | Per-user trading controls | User-set via settings UI |
| Code | `MAX_BOT_INVESTMENT_USD` | Max $ per single order |
| Code | Daily loss limit | Defined in `risk_configs` table |
| Code | Weekly loss limit | SHIELD circuit breaker |
| Code | Drawdown circuit breaker | Halts if equity drops > threshold |

---

## 5. AI Intelligence Pipeline (PANTHEON)

The PANTHEON pipeline scores every candidate stock on a 0–100 scale. Each agent contributes a **bounded score adjustment** — no single agent can override the consensus. The final score gates order execution.

### 5.1 Scoring Architecture

```
Base Score: Technical indicators (RSI, MACD, BB, Stoch-RSI, Williams %R)
                │
                ▼ Each agent adds or subtracts bounded points
┌──────────────────────────────────────────────────────────────────┐
│  Agent          │  Max Contribution  │  Direction               │
│─────────────────┼────────────────────┼──────────────────────────│
│  SONAR          │  ±8 pts            │  Smart money alignment   │
│  GEMINI PULSE   │  ±8 pts            │  News headline sentiment │
│  PROPHET        │  ±8 pts            │  Earnings forecast       │
│  VISION         │  ±8 pts            │  Directional probability │
│  SAGE           │  ±3 pts            │  Historical win-rate adj │
│  LOCAL BRAIN    │  ±6 pts            │  Pattern × sector × reg  │
│  EVOLVE         │  ±8 pts            │  ML decision-table boost │
│  ORACLE         │  ±15 pts           │  AI master verdict       │
│  FRED MACRO     │  Score adj / halt  │  Macro environment gate  │
│  COMPASS        │  Sector tailwind   │  Sector RS vs SPY        │
└──────────────────────────────────────────────────────────────────┘
                │
                ▼
        Final Score (0–100)
        Clipped to [0, 100]
                │
                ▼
    minBuyScore gate (default 82, regime-adjusted)
                │
                ▼
        Execute or reject
```

**Oracle budget:** Max 25 fresh Claude API calls per scan cycle. Cached results (1-hour TTL) are free and do not count toward the cap. HERMES RS sort ensures the highest-momentum stocks consume the budget first.

### 5.2 Agent Directory

#### ORACLE — Trade Strategist
- **File:** `backend/src/services/oracleService.js`
- **Trigger:** Pre-score ≥ 55
- **Engine:** Claude (primary) → Ollama llama3.2:3b (fallback)
- **Methodology:** 8-step scoring combining Minervini, O'Neil, Livermore, Weinstein, Wyckoff, Jones, Darvas, Druckenmiller
- **Output:** `TRADE (+15)`, `WATCHLIST (0)`, `SKIP (−15)`
- **Cache:** 1 hour per symbol
- **Budget:** 25 calls/cycle (env: `ORACLE_MAX_PER_CYCLE`)

#### VISION — Pattern Prophet
- **File:** `backend/src/services/visionService.js`
- **Engine:** Rule-based (no external API)
- **Logic:** MA alignment + momentum + RSI + volume trend + breakout proximity → 5-day directional probability
- **Output:** `UP / DOWN / NEUTRAL`, probability %, confidence, scoreAdj (−8 to +8)
- **Cache:** None (pure computation, instantaneous)

#### PROPHET — Earnings Forecaster
- **File:** `backend/src/services/prophetService.js`
- **Trigger:** 15–45 days before earnings (configurable via `PROPHET_WINDOW_MIN/MAX_DAYS`)
- **Engine:** Claude → Ollama fallback
- **Output:** `BEAT / IN_LINE / MISS`, confidence, thesis, scoreAdj (−8 to +8)
- **Cache:** 6 hours per symbol

#### SAGE — Learning Brain
- **File:** `backend/src/services/sageService.js`
- **Engine:** Pure statistics (no external API)
- **Logic:** Reads closed `trade_decision_journal` rows → computes Kelly metrics (win rate + win/loss ratio) → generates `learned_adjustments.json`
- **Output:** scoreAdj (±3 pts, governed by PANTHEON rules)
- **Refresh:** Fire-and-forget after each trading session end

#### SONAR — Institutional Tracker
- **File:** `backend/src/services/sonarService.js`
- **Engine:** Yahoo Finance institutional/insider data
- **Logic:** Institutional ownership score (60%) + insider transaction score (40%) → 0–1 smart money index
- **Output:** Score boost proportional to smart money interest
- **Cache:** 24 hours

#### GEMINI PULSE — News Analyst
- **File:** `backend/src/services/geminiPulseService.js`
- **Engine:** Google Gemini API (disabled gracefully without `GEMINI_API_KEY`)
- **Logic:** Analyzes up to 12 recent news headlines for sentiment
- **Output:** Sentiment score (0–100, 50=neutral), label (Bullish/Neutral/Bearish), one-liner thesis, scoreAdj (−8 to +8)
- **Cache:** 30 minutes per symbol

#### LOCAL BRAIN — Historical Pattern Intelligence
- **File:** `backend/src/services/localBrainService.js`
- **Engine:** In-memory win-rate lookup table (no external API, no GPU)
- **Key:** `sector × chart_pattern × market_regime`
- **Logic:** Minimum 5 historical trades per cell required; returns boost/penalty based on this account's actual history
- **Output:** scoreAdj (−6 to +6)
- **Refresh:** Every 4 hours

#### EVOLVE — Decision-Table ML
- **File:** `backend/src/services/evolveService.js`
- **Engine:** Feature-bucket win-rate model built from 2 years of cached OHLCV data
- **Logic:** Computes 5+ technical features per bar, labels WIN (5d return > 2%) / LOSS, builds lookup table — no library, no GPU
- **Output:** Historical win-rate as scoreAdj (−8 to +8)
- **Rebuild:** Every 24 hours

#### SHIELD — FRED Macro Gate
- **File:** `backend/src/services/fredMacroService.js`
- **Engine:** FRED API (Federal Reserve Economic Data)
- **Signals:** Federal Funds Rate, 10Y−2Y Spread (yield curve), Unemployment Rate
- **Logic:** Bearish macro signal with `scoreAdj ≤ −8` halts all new buys for the cycle
- **Cache:** 6 hours
- **Disabled gracefully** without `FRED_API_KEY`

#### COMPASS — Sector Navigator
- **File:** `backend/src/services/compassService.js`
- **Engine:** Yahoo Finance sector ETF data
- **Sectors tracked:** XLK · XLF · XLV · XLY · XLP · XLE · XLI · XLB · XLRE · XLU · XLC
- **Logic:** RS = sector ETF return / SPY return over lookback period. RS > 1 = tailwind, RS < 1 = headwind
- **Output:** Hot sectors (RS ≥ 1.05) get score boost; cold sectors get penalty
- **Cache:** 30 minutes (env: `COMPASS_CACHE_TTL_MS`)

---

## 6. Market Regime Engine

**Primary file:** `backend/src/services/marketRegimeService.js`

### 6.1 Regime Classification

The regime engine reads 7 market signals and classifies the current environment into one of 5 regimes. All results are cached for **60 minutes** (with a 6-hour stale fallback).

**7 signals used:**

| Signal | Source | Purpose |
|--------|--------|---------|
| SPY price vs 200-day MA | Yahoo Finance | Primary trend direction |
| SPY price vs 50-day MA | Yahoo Finance | Short-term trend |
| VIX level | ^VIX (Yahoo) | Fear gauge |
| QQQ trend | Yahoo Finance | Tech divergence detection |
| TLT 20-day return | Yahoo Finance | Bond / rate environment |
| SPY 5-day price range % | Yahoo Finance | Chop detection |
| ATR(5) / ATR(20) ratio | Computed | Volatility expansion |

**5 regimes and their characteristics:**

| Regime | Trigger Condition | New Entries | Position Size |
|--------|-------------------|-------------|---------------|
| `PANIC` | VIX > 40 OR catastrophic 20d drop | ❌ Halted | N/A |
| `BEAR` | SPY below 200MA + poor returns | ⚠️ Score ≥ 90 only | 25% |
| `CHOPPY` | Tight 5d range + ATR contracting | ❌ Momentum blocked | 50% |
| `NEUTRAL` | SPY below 200MA OR VIX elevated | ⚠️ Score ≥ 87 | 60% |
| `BULL_MILD` | Above 200MA with headwinds | ✅ Score ≥ 84 | 80% |
| `BULL_STRONG` | SPY+QQQ above MAs, VIX low, no rate pressure | ✅ Score ≥ 82 | 100% |

### 6.2 Regime Impact on Trading

Each regime change triggers a **Telegram alert** to the operator describing exactly what behaviour changed (tighter exits, higher score bar, blocked strategies).

**Exit thresholds by regime:**

| Regime | Early Partial | Main Partial | Full Exit |
|--------|:-------------:|:------------:|:---------:|
| BEAR | 7% | 12% | 20% |
| NEUTRAL | 10% | 15% | 25% |
| BULL (any) | 12% | 18% | 30% |

**ATR-based trailing stop (all regimes):**

| Gain | Trail % | ATR Floor |
|------|---------|-----------|
| ≥ 20% | 10% | 2× ATR / peakPrice |
| ≥ 10% | 8% | 2× ATR / peakPrice |
| ≥ 5% | 7% | 2× ATR / peakPrice |
| < 5% | 6% | 2× ATR / peakPrice |

---

## 7. Stock Universe & Screener

### 7.1 Dynamic Universe Service

**Primary file:** `backend/src/services/dynamicUniverseService.js`

The dynamic universe is built **once per trading day pre-market** from four sources, then served from an in-memory cache until midnight ET. This eliminates intraday API hammering that previously caused OOM errors.

```
Universe build order (sources merged and deduplicated):
  1. Static 244-symbol base list (established liquid names)
  2. PostgreSQL asset_universe_daily (Alpaca universe, RS-sorted)
  3. Yahoo Finance: day_gainers + most_actives + trending
  4. Pre-market movers (velocity screener)

→ Symbols sorted by RS score DESC
→ Capped per regime:
    BEAR        = 150 symbols
    NEUTRAL     = 250 symbols
    BULL_MILD   = 350 symbols
    BULL_STRONG = 400 symbols
```

**Important:** Trending stocks are **never hardcoded**. The dynamic screener discovers them fresh each morning.

### 7.2 Quick Filter Rules

Before expensive per-symbol AI analysis, `passesQuickFilter()` eliminates poor candidates:

- Market cap ≥ `HERMES_MIN_MARKET_CAP` (default $5B)
- Average daily volume ≥ `HERMES_MIN_AVG_VOLUME` (default 500K shares)
- Price > $5 (no penny stocks)
- Not in Weinstein Stage 3 or 4 (topping / downtrend)
- Not in earnings blackout window (configurable)
- Not in asset blacklist (stop-loss cooldowns, chronic losers)

---

## 8. Autonomous Trading Bot

**Primary file:** `backend/src/services/enhancedAITradingBot.js`  
**Scheduler file:** `backend/src/services/enhancedAIScheduler.js`

The bot runs every **5 minutes** during market hours (9:30 AM – 4:00 PM ET, Monday–Friday).

### 8.1 Trade Execution Loop

```
Every 5 minutes:
  1. Check HALT_ALL (Redis) → skip if set
  2. Check global kill switch (DB) → skip if set
  3. Check AI_TRADING_ENABLED (env) → skip if false
  4. Check market open → skip if closed
  5. getSystemHealthMultiplier(userId) [30-min cache]
  6. getMarketRegime() [60-min cache]
     └─ Detect regime change → send Telegram shift alert
  7. Apply regime caps:
     effectiveMaxRisk    = min(riskConfig.maxRisk, regime.maxRisk)
     effectiveMinScore   = max(riskConfig.minBuyScore, regime.minBuyScore)
     effectiveSizeMulti  = regime.positionSizeMultiplier × healthMultiplier
  8. manageExistingPositions(userId)
     ├─ For each holding: fetch current price
     ├─ ATR trailing stop check
     ├─ Break-even stop protection
     ├─ Regime-adaptive partial exits (3 tiers)
     └─ Hard stop-loss → insert cooldown, send alert
  9. Scan market universe (batch of 5, 3s delay between batches):
     └─ Per symbol: PANTHEON scoring pipeline
  10. Filter opportunities:
      ├─ Earnings blackout check
      ├─ Bleeding symbols gate (chronic losers, 4h cache)
      ├─ In-session duplicate check
      ├─ Stop-loss cooldown check (batch-loaded, O(1) lookup)
      ├─ Abnormal gap filter (>20% hard block, 12–20% needs score ≥ 86)
      ├─ Regime gate (breakout_leader blocked in non-bull unless score ≥ 88)
      ├─ R/R gate (min 2:1)
      ├─ Sector limit (max 3 positions per sector)
      ├─ Industry limit (max 2 per industry)
      ├─ Correlation check
      ├─ Position sizing (Kelly)
      └─ Liquidity cap (max 0.5% of avg daily dollar volume)
  11. Execute BUY orders → store in trade_decision_journal with autoTags
  12. Update Redis open positions list
  13. Fire-and-forget: SAGE learning regeneration
```

### 8.2 Position Sizing (Kelly Criterion)

```
Kelly fraction = W − (1−W) / R
  W = historical win rate for this setup/sector combination
  R = avg win / avg loss ratio

Half-Kelly = Kelly × 0.5  (standard safety factor)

Combined multiplier:
  = effectiveSizeMultiplier × streakBreaker.multiplier × expectancySizeMultiplier
  = (regime.positionSizeMultiplier × healthMultiplier) × streakMult × expectancyMult

Position $ = accountBalance × kellyFraction × combinedMultiplier
  Capped at: maxPortfolioRisk (from risk_configs)
  Floored at: minPositionSize (from risk_configs)
  Liquidity cap: ≤ 0.5% of symbol's avg daily dollar volume
```

**System Health Multiplier** reduces position size when the bot is underperforming:

| Condition | Penalty |
|-----------|---------|
| 7-day WR < 40% while prior 7-day WR ≥ 50% | −0.15 |
| 14-day WR < 35% (prolonged weakness) | −0.15 |
| ≥ 2 setup families showing alpha decay (>15pt WR drop) | −0.20 |
| **Floor** | **0.5× (never below half size)** |

### 8.3 Exit Strategy

**Break-even protection:** Once a position gains 3%, stop moves to entry price (locked-in).

**ATR trailing stop:** Dynamic stop based on unrealized gain percentage (see [Section 6.2](#62-regime-impact-on-trading)).

**Partial exits (regime-adaptive):**
- Tier 1 (early partial): Sell 25% of position at first threshold
- Tier 2 (main partial): Sell 50% at second threshold
- Tier 3 (full exit): Sell remaining at final threshold

**Stop-loss cooldown:** After a stop-loss triggers, the symbol is added to `asset_blacklist` with `COOLDOWN_{userId}_{symbol}` key for 24 hours. The bot will not re-enter the same symbol during cooldown.

### 8.4 Risk Guards

| Guard | Trigger | Action |
|-------|---------|--------|
| Daily loss limit | Daily P&L < limit | Stop new buys for day |
| Weekly loss limit (SHIELD) | Weekly P&L < limit | Stop new buys for week |
| Drawdown circuit breaker | Equity drops > `MAX_DRAWDOWN_PCT` | Halt + reduce sizing |
| Streak breaker | N consecutive losses | Reduce sizing multiplier |
| PANIC regime | VIX > 40 | Skip buy loop entirely |
| CHOPPY regime | Range-bound market | Skip momentum entries |
| FRED macro gate | Severe bearish macro | Halt new buys |
| Auto-pause (EOD) | WR < 20% vs baseline > 40% (n≥3) OR trades > 5× baseline | `setHaltAll()` + urgent Telegram |

---

## 9. Autonomous Options Bot

**Primary file:** `backend/src/services/autonomousOptionsBot.js`  
**Scheduler:** `backend/src/services/optionsBotScheduler.js`

The options bot runs four concurrent strategies with independent allocation buckets:

| Strategy | Allocation | Take-Profit | Typical Use |
|----------|:----------:|:-----------:|-------------|
| Delta-Neutral Scalping | 30% | 20% | High-IV, range-bound |
| Directional Swing | 40% | 35% | Trending markets |
| Credit Spreads | 20% | 15% | High-IV premium selling |
| Protective Puts | 10% | Hedge cost | Portfolio insurance |

**Greeks-based selection:**
- Delta, Gamma, Theta, Vega computed per position
- Credit spreads: probability of profit ≈ 100% − |delta × 100|
- Max 5 concurrent positions; 10% max account risk

---

## 10. Scheduler & EOD Automation

**File:** `backend/src/services/enhancedAIScheduler.js`

The scheduler runs on a **5-minute interval** with time-gated functions:

| Function | When | Purpose |
|----------|------|---------|
| `runScheduledTrading()` | Every 5 min during market hours | Main buy/sell loop |
| `runEodCleanup()` | 15:44–15:59 ET, once/day | Cancel partial fills, anomaly detection, daily digest |
| `runWeeklyParameterHealthCheck()` | Friday 15:45 ET, once/week | Win-rate by score bucket, alpha decay, slippage, what-if simulator, backtest |

### EOD Automation Detail (15:44 ET)

1. **ARROW EOD** — cancel all partial-fill orders before NYSE close
2. **Anomaly detection** — compare today's trade count and win rate vs 90-day baseline:
   - Trade count > 2.5× baseline → `⚠️ TRADE FLOW ANOMALY` alert
   - Trade count > 5× baseline → `🚨 AUTO-PAUSE ACTIVATED` + `setHaltAll()`
   - Win rate < 20% vs baseline > 40% (n≥3) → `🚨 AUTO-PAUSE ACTIVATED` + `setHaltAll()`
   - Zero trades on a normal day → informational alert
3. **Daily EOD digest** — one Telegram message per user with:
   - Today's trade count, win rate, total P&L
   - Best trade story (symbol + auto-tags + setup + exit reason)
   - Worst trade story (same fields)
   - Open positions with unrealized % at close

### Weekly Health Check (Friday 15:45 ET)

Delivered as Telegram message:
- Win rate by score bucket (30d) with `⚠️` flags and SQL suggestions
- Win rate by market regime (30d)
- Alpha decay per setup family (30d vs prior 60d)
- Execution slippage by setup (avg + max)
- Top 5 / worst 5 symbols by total P&L (30d, n≥2)
- **What-if simulator** — CROSS JOIN with score thresholds [82, 84, 85, 86, 88, 90]; shows win rate + P&L at each threshold
- Backtest on top 20 RS symbols from `asset_universe_daily`

---

## 11. Performance Analytics

**Routes file:** `backend/src/routes/performanceRoutes.js`  
**Service:** `backend/src/services/performanceMetricsService.js`

### Key Metrics Computed

| Metric | Description |
|--------|-------------|
| **Sharpe Ratio** | Risk-adjusted return over N days (default 30) |
| **Calmar Ratio** | Annualized return / max drawdown |
| **Max Drawdown** | Largest peak-to-trough equity decline |
| **Kelly Fraction** | Optimal bet size from win rate + win/loss ratio |
| **Win Rate** | % of closed trades with positive P&L |
| **Avg Hold Time** | Mean position duration in hours |
| **Time-of-Day Win Rate** | Performance breakdown by hour (pre-market, open, midday, close) |
| **Slippage** | Avg difference between signal price and fill price |
| **Overfitting Score** | Walk-forward stability + OOS decay + regime concentration |

### Trade Decision Journal

Every trade decision (candidate, execution, close) is written to `trade_decision_journal` with full context:

```
Fields: symbol, bot_type, decision_phase, score, setup_family, regime,
        entry_price, exit_price, pnl, pnl_percent, metadata (JSONB)

metadata includes:
  - autoTags: [gap_play, news_driven, 52w_breakout, stage2_uptrend,
               oversold, momentum, catalyst, bull_regime_entry]
  - signalPrice: price when signal fired
  - slippage: actual_fill − signal_price
  - slippagePct: slippage as % of signal price
  - exitReason: TAKE_PROFIT | STOP_LOSS | TRAILING_STOP | PARTIAL_PROFIT
  - scoringLog: contribution from each agent
```

---

## 12. Weekly Prediction Engine

**Service:** `backend/src/services/weeklyPredictionService.js`  
**Report sender:** `backend/src/sendWeeklyReportToTelegram.js`

### Universe Options

| Universe | Symbols | Est. Runtime | Use Case |
|----------|:-------:|:------------:|----------|
| `MEGA_CAP` | 50 | ~30–60 s | Quick pulse check |
| `TOP_200` | 200 | ~2–3 min | Default weekly report |
| `ALL` | 820 | ~10–15 min | Comprehensive (requires pre-warming) |

### Report Fetch Chain

```
1. Check persisted snapshot (age < snapshotMaxAgeMs, default 12h)
   └─ If valid and topPicks ≥ minTopPicks (3) → use snapshot

2. Live API call to /api/weekly/predictions?universe=TOP_200
   ├─ Timeout: 240s (TOP_200) / 600s (ALL) / 90s (MEGA_CAP)
   └─ If topPicks ≥ minTopPicks → use response

3. If TOP_200 returns 0 picks → fallback to MEGA_CAP (90s timeout)

4. If all universes fail → throw with descriptive error listing each failure
```

**Default primary universe:** `TOP_200` (set `TELEGRAM_REPORT_PRIMARY_UNIVERSE=ALL` in `.env` only when the snapshot pre-warm cron runs reliably).

### Scoring Components

| Component | Weight |
|-----------|:------:|
| AI signal (multi-model ensemble) | 25% |
| Technical indicators | 20% |
| Fundamentals & analyst ratings | 15% |
| Price momentum | 15% |
| News sentiment | 10% |
| Volume trends | 10% |
| Volatility (lower is better for weekly) | 5% |

---

## 13. Telegram Alerts

**Service:** `backend/src/services/telegramAlertService.js`

All Telegram messages include a `📦 Holdings:` line showing currently open symbol names (60-second cache to prevent redundant DB queries on clustered alerts).

| Alert Type | Trigger |
|------------|---------|
| `🤖 AI TRADING STARTED` | Bot cycle begins |
| `✅ TRADE EXECUTED` | BUY order filled |
| `📤 TRADE EXECUTED` | SELL order filled |
| `🛑 STOP LOSS TRIGGERED` | Hard stop hit |
| `🎯 TAKE PROFIT EXECUTED` | Profit target reached |
| `🚨 LARGE LOSS ALERT` | Position down > 10% |
| `⚠️ DAILY LOSS WARNING` | Daily loss > 80% of limit |
| `🔴 DAILY LOSS LIMIT REACHED` | Trading halted for day |
| `⚠️ HIGH VOLATILITY WARNING` | VIX > threshold |
| `ℹ️ AI TRADING UPDATE` | No opportunities found (once/day max) |
| `📊 DAILY TRADING SUMMARY` | End-of-day stats |
| `🔄 MARKET REGIME SHIFT` | Regime changes |
| `🚨 TRADE FLOW ANOMALY` | Unusual trade volume or WR drop |
| `🚨 AUTO-PAUSE ACTIVATED` | Catastrophic anomaly → HALT_ALL set |
| `📅 EOD DAILY DIGEST` | 15:44 ET — full day summary |
| `📊 Weekly Parameter Health Check` | Friday 15:45 ET |
| Options-specific alerts | Options trade, spread, position closed |

---

## 14. API Endpoint Reference

All endpoints require JWT authentication (`Authorization: Bearer <token>`) unless noted.

**Base URL:** `http://localhost:3001/api`

---

### 14.1 Authentication

| Method | Endpoint | Auth | Description |
|--------|----------|:----:|-------------|
| POST | `/auth/login` | ❌ | Login with username + password → returns JWT |
| POST | `/auth/register` | ❌ | Register new user |
| GET | `/auth/profile` | ✅ | Get current user profile |
| POST | `/auth/change-password` | ✅ | Change password |

---

### 14.2 Trading (Manual)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/trading/account` | Account balance and info |
| POST | `/trading/deposit` | Add virtual funds |
| POST | `/trading/withdraw` | Remove virtual funds |
| POST | `/trading/reset-balance` | Reset to a specific amount |
| POST | `/trading/clear-all` | Wipe all holdings and history |
| POST | `/trading/buy` | Execute manual buy order |
| POST | `/trading/sell` | Execute manual sell order |
| GET | `/trading/history` | Trade history (last 50) |
| GET | `/trading/holdings` | Current open positions |
| GET | `/trading/portfolio` | Portfolio summary with live valuations |
| GET | `/trading/ledger` | Ledger reconciliation |
| GET | `/trading/ledger/trades` | Ledger trade lines (up to 1000) |
| GET | `/trading/ledger/export` | Export ledger as CSV |
| GET | `/trading/performance` | Performance analytics |
| GET | `/trading/risk` | Risk metrics |
| GET | `/trading/transactions` | Deposit/withdrawal history |
| GET | `/trading/quote/:symbol` | Current price for a symbol |
| GET | `/trading/portfolio-history` | Portfolio value over time (chart data) |
| GET | `/trading/news-signals` | AI signals enriched with news sentiment |

---

### 14.3 AI Trading (Basic)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/ai-trading/settings` | Get AI trading configuration |
| POST | `/ai-trading/settings` | Save AI settings (stopLoss, takeProfit, minCashReserve) |
| POST | `/ai-trading/initialize` | Initialize AI-managed portfolio |
| POST | `/ai-trading/rebalance` | Rebalance portfolio per AI recommendations |
| GET | `/ai-trading/recommendations` | Current AI stock recommendations |
| GET | `/ai-trading/status` | AI portfolio status and performance |
| GET | `/ai-trading/analyze/:symbol` | AI analysis for a specific symbol |

---

### 14.4 Enhanced AI Trading

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/enhanced-ai-trading/toggle` | Enable / disable autonomous trading for user |
| GET | `/enhanced-ai-trading/status/:userId?` | Scheduler status, risk config, last activity |
| POST | `/enhanced-ai-trading/config/:userId?` | Update risk configuration (minBuyScore, maxRisk, etc.) |
| GET | `/enhanced-ai-trading/log/:userId?` | Trading activity log (last 50 entries) |
| POST | `/enhanced-ai-trading/scan` | Manually trigger market scan |
| POST | `/enhanced-ai-trading/execute` | Manually trigger one trading cycle |
| GET | `/enhanced-ai-trading/scheduler/status` | Global scheduler state |
| GET | `/enhanced-ai-trading/market/status` | Is market currently open? |

---

### 14.5 Options Bot

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/options-bot/status` | Bot status and current configuration |
| POST | `/options-bot/enable` | Enable or disable the options bot |
| PUT | `/options-bot/config` | Update bot config (strategies, risk limits, take-profit, stop-loss) |
| GET | `/options-bot/positions` | Open options positions |
| GET | `/options-bot/history` | Closed positions (last 50) |
| GET | `/options-bot/performance` | Performance metrics by period and strategy |
| POST | `/options-bot/manual-scan` | Trigger options market scan |
| POST | `/options-bot/close-position/:id` | Manually close a specific position |
| GET | `/options-bot/alerts` | Options bot alerts |
| PUT | `/options-bot/alerts/:id/read` | Mark alert as read |

---

### 14.6 Performance

| Method | Endpoint | Query Params | Description |
|--------|----------|-------------|-------------|
| GET | `/performance/scorecard` | — | Live scorecard: daily P&L, Sharpe, drawdown, Kelly, regime |
| GET | `/performance/daily` | `date=YYYY-MM-DD` | Single-day performance metrics |
| GET | `/performance/weekly` | — | Weekly performance summary |
| GET | `/performance/monthly` | — | Monthly performance summary |
| GET | `/performance/sharpe` | `days=30` | Sharpe ratio over N days |
| GET | `/performance/kelly` | — | Kelly criterion metrics |
| POST | `/performance/sync-balance` | — | Recompute cash balance from history |
| GET | `/performance/history` | `days=30` | Daily P&L time series for charts |
| GET | `/performance/intelligence` | `days=180` | Aggregated AI learning from trade journal |
| GET | `/performance/intelligence/drilldown` | — | Raw journal rows by setup / strategy / regime |
| GET | `/performance/advanced` | — | Hold time, time-of-day win rate, slippage analysis |
| GET | `/performance/overfit` | — | Walk-forward stability, OOS decay, regime concentration |
| GET | `/performance/regime` | `days=180` | P&L breakdown by market regime |

---

### 14.7 Backtest

| Method | Endpoint | Query Params | Description |
|--------|----------|-------------|-------------|
| GET | `/backtest/report` | `type=stocks\|options`, `dateRange=all\|30d\|90d`, `strategy=all` | AI bot backtest report |
| GET | `/backtest/ai-analysis` | — | Deep AI analysis via Ollama (llama3.2:3b) |
| GET | `/backtest/stats` | — | Raw pre-computed trade statistics |

**Go-live criteria (from Historical Backtest Engine):**
- Sharpe Ratio > 1.5
- Max Drawdown < 15%
- Win Rate > 52% (out-of-sample)

---

### 14.8 Weekly Predictions

| Method | Endpoint | Query Params | Description |
|--------|----------|-------------|-------------|
| GET | `/weekly/predictions` | `limit=20`, `minScore=60`, `universe=TOP_200`, `sectors`, `marketCapMin`, `volatilityMax` | Top weekly picks |
| GET | `/weekly/ranked` | `universe=ALL` | Full ranked universe list |
| GET | `/weekly/snapshot-status` | — | Snapshot freshness for each universe |
| GET | `/weekly/export` | `universe=ALL` | Download ranked list as CSV |
| GET | `/weekly/analyze/:symbol` | — | Detailed weekly analysis for one symbol |
| GET | `/weekly/performance` | `weeks=4` | Historical prediction accuracy |
| POST | `/weekly/update-results` | — | Manually trigger last-week result update |

---

### 14.9 Market Data & Signals

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/stocks/quote/:symbol` | Real-time quote |
| GET | `/stocks/history/:symbol` | Historical OHLCV data |
| GET | `/stocks/search` | Symbol search |
| GET | `/indicator/:symbol` | Technical indicators |
| GET | `/signals/:symbol` | Buy/sell signal analysis |
| GET | `/enhanced-signals/:symbol` | Multi-indicator confluence signals |
| GET | `/patterns/:symbol` | Chart pattern detection |
| GET | `/fundamentals/:symbol` | Company fundamentals (CANSLIM) |
| GET | `/volume/:symbol` | Volume analysis |
| GET | `/moneyflow/:symbol` | Money flow indicators |
| GET | `/earnings/:symbol` | Earnings data and calendar |
| GET | `/news/:symbol` | News feed for symbol |
| GET | `/news-aggregation/ticker/:symbol` | Aggregated news by ticker |
| GET | `/news-aggregation/category/macro` | Macro market news |
| GET | `/ai/analyze/:symbol` | General AI analysis |
| GET | `/recommendations` | AI-recommended stocks |
| GET | `/screener` | Stock screener with filters |
| GET | `/swing-trading/opportunities` | Swing trading setups |
| GET | `/scalping/setups` | Scalping setups |
| GET | `/options/:symbol` | Options chain and analysis |
| GET | `/scenarios/:symbol` | Scenario modeling |

---

### 14.10 Watchlist & Screener

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/watchlist` | Get user watchlist |
| POST | `/watchlist` | Add symbol to watchlist |
| DELETE | `/watchlist/:symbol` | Remove from watchlist |
| GET | `/screener` | Screener with market cap, sector, signal filters |
| GET | `/asset-universe` | View current dynamic universe |

---

### 14.11 System

| Method | Endpoint | Auth | Description |
|--------|----------|:----:|-------------|
| GET | `/health` | ❌ | DB status, uptime, scheduler, worker state |
| GET | `/system/status` | ✅ | Detailed system health (agents, Redis, feeds) |
| POST | `/system/halt-trading` | ✅ | Set global trading kill switch |
| POST | `/system/resume-trading` | ✅ | Clear kill switch |
| GET | `/profile` | ✅ | User profile and Telegram config |
| PUT | `/profile` | ✅ | Update profile |

---

## 15. Database Schema

**Type:** PostgreSQL  
**Database name:** `kiranrock_trading`  
**Connection pool:** 20 connections, 30s idle timeout

### Core Tables

| Table | Purpose |
|-------|---------|
| `users` | User accounts, JWT auth, Telegram chat ID |
| `trading_accounts` | Cash balance per user |
| `holdings` | Open positions (symbol, quantity, avg price, peak price, ATR, partial_profit_taken) |
| `trades` | Buy/sell history with fill prices |
| `order_audit_log` | ARROW state machine — append-only order lifecycle |
| `risk_configs` | Per-user risk parameters (minBuyScore, maxPortfolioRisk, stopLoss, takeProfit, dailyLossLimit) |
| `ai_trading_logs` | Per-cycle scheduler output |

### AI & Intelligence Tables

| Table | Purpose |
|-------|---------|
| `trade_decision_journal` | Full audit trail: candidate → executed → closed, with score, regime, setup, P&L, JSONB metadata |
| `asset_blacklist` | Stop-loss cooldowns and chronic-loser blocks (TTL via `expires_at`) |
| `asset_universe_daily` | Dynamic universe from Alpaca, RS-scored, date-partitioned |

### Options Tables

| Table | Purpose |
|-------|---------|
| `options_trades` | Open and closed options positions |
| `options_bot_config` | Per-user bot settings |
| `options_performance` | Daily performance snapshots by strategy |
| `options_alerts` | Bot-generated alerts |

### Analytics Tables

| Table | Purpose |
|-------|---------|
| `ai_performance_metrics` | Daily scorecard: P&L, Sharpe, drawdown, win rate |
| `portfolio_snapshots` | Daily equity snapshots for chart history |
| `daily_bars` | Cached OHLCV data (avoids repeated API calls) |
| `weekly_predictions` | Saved weekly picks for accuracy tracking |

---

## 16. Redis State Management

**File:** `backend/src/services/redisStateService.js`

Redis is used for **multi-process coordination** (AWS multi-EC2 scenarios). All methods fail gracefully when Redis is unavailable — trading never halts due to a Redis outage.

| Key | TTL | Purpose |
|-----|-----|---------|
| `HALT_ALL` | Persistent | Global kill-switch. Set by auto-pause or operator. Checked every cycle. |
| `POSITIONS_OPEN:{userId}` | 10 minutes | JSON array of open symbol names. Updated after each cycle. |
| `ORACLE_WATCHLIST` | 1 hour | Symbols queued for ORACLE review |
| `REGIME:usa` | 15 minutes | Current market regime string |
| `DATA_STALE:atlas` | 5 minutes | Flag when data feed is overdue |
| `AGENT_HEALTH:{agent}` | 5 minutes | Last heartbeat ISO timestamp per agent |
| `PIPELINE_LOCK:{userId}` | 30 minutes | Mutex to prevent double-run across EC2 instances |
| `IST_STAGE:{userId}` | 1 hour | Current pipeline stage name |

**Clearing HALT_ALL after auto-pause:**
```bash
redis-cli DEL HALT_ALL
# or set AI_TRADING_ENABLED=true and restart the process
```

---

## 17. Environment Variables Reference

Create `backend/.env` from `backend/.env.example`. All variables with `*required*` must be set for the system to start.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Express server port |
| `HOST` | `0.0.0.0` | Bind address |
| `NODE_ENV` | `development` | `production` enables stricter security |
| `CORS_ORIGINS` | `http://localhost:3000` | Allowed frontend origins |

### Database *(required)*

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_HOST` | `localhost` | PostgreSQL host |
| `DB_PORT` | `5432` | PostgreSQL port |
| `DB_NAME` | `kiranrock_trading` | Database name |
| `DB_USER` | `postgres` | DB username |
| `DB_PASSWORD` | — | DB password *(required)* |

### Authentication *(required)*

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Long random hex string *(required)* |

### Data Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_PROVIDER` | `yahoo` | `yahoo` \| `alpaca` \| `polygon` |
| `ALPACA_KEY_ID` | — | Alpaca API key (required for `alpaca` provider) |
| `ALPACA_SECRET_KEY` | — | Alpaca secret key |
| `ALPACA_PAPER` | `true` | `true` = paper, `false` = live |
| `POLYGON_API_KEY` | — | Polygon.io key (required for `polygon` provider) |

### Broker

| Variable | Default | Description |
|----------|---------|-------------|
| `BROKER` | `simulated` | `simulated` \| `alpaca` |
| `BOT_ENABLED` | `true` | Master on/off for all order placement |
| `MAX_BOT_INVESTMENT_USD` | `5000` | Max $ per single order |
| `AI_TRADING_ENABLED` | `true` | Enable autonomous trading scheduler |

### Telegram Alerts

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | BotFather token |
| `TELEGRAM_CHAT_ID` | Your personal chat ID |
| `BOT_USERNAME` | Login username for weekly report script |
| `BOT_PASSWORD` | Login password for weekly report script |

### External APIs

| Variable | Service | Required For |
|----------|---------|-------------|
| `GEMINI_API_KEY` | Google Gemini | GEMINI PULSE news sentiment |
| `FRED_API_KEY` | Federal Reserve | SHIELD macro gate |
| `NEWSAPI_KEY` | NewsAPI.org | News aggregation |
| `ALPHA_VANTAGE_KEY` | Alpha Vantage | Supplemental data |
| `FINNHUB_API_KEY` | Finnhub | Fundamentals |
| `HUGGINGFACE_API_KEY` | HuggingFace | ML model inference |
| `REDDIT_CLIENT_ID` | Reddit API | Alt data (mentions) |
| `REDDIT_SECRET` | Reddit API | Alt data |
| `REDDIT_USER_AGENT` | Reddit API | Identifies your app |

### Risk Circuit Breakers

| Variable | Default | Description |
|----------|---------|-------------|
| `CIRCUIT_HALT_STREAK` | `5` | Consecutive losses before halt |
| `CIRCUIT_REDUCE_STREAK` | `3` | Consecutive losses before size reduction |
| `MAX_DRAWDOWN_PCT` | `15` | % equity drop that triggers halt |
| `DATA_MAX_AGE_MS` | `120000` | 2-min data staleness limit before halt |

### Universe & Market Screener

| Variable | Default | Description |
|----------|---------|-------------|
| `HERMES_MIN_MARKET_CAP` | `5000000000` | Minimum $5B market cap |
| `HERMES_MIN_AVG_VOLUME` | `500000` | Minimum 500K avg daily shares |
| `HERMES_MAX_STOCKS` | `150` | Universe cap before regime adjustment |
| `COMPASS_LOOKBACK_DAYS` | `20` | Sector RS lookback period |
| `COMPASS_CACHE_TTL_MS` | `1800000` | Sector RS cache (30 min) |

### Weekly Report Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_REPORT_PRIMARY_UNIVERSE` | `TOP_200` | Primary prediction universe |
| `TELEGRAM_REPORT_FALLBACK_UNIVERSES` | `MEGA_CAP` | Comma-separated fallback universes |
| `TELEGRAM_REPORT_FETCH_LIMIT` | `25` | Max picks to request |
| `TELEGRAM_REPORT_MIN_TOP_PICKS` | `3` | Min picks before trying next universe |
| `TELEGRAM_REPORT_SNAPSHOT_MAX_AGE_MS` | `43200000` | 12-hour snapshot age limit |

### AI Tuning

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_NEWS_SCORING_ENABLED` | `true` | Enable news sentiment in scoring |
| `AI_NEWS_SCORE_WEIGHT` | `1` | News score weight multiplier |
| `AI_NEWS_MAX_IMPACT` | `8` | Max points news can add/remove |
| `ORACLE_MAX_PER_CYCLE` | `25` | Max Claude API calls per scan |
| `ORACLE_ALLOW_CLAUDE_FALLBACK` | `false` | Fall back to Claude if Ollama fails |
| `PROPHET_WINDOW_MIN_DAYS` | `15` | Earliest days before earnings to run PROPHET |
| `PROPHET_WINDOW_MAX_DAYS` | `45` | Latest days before earnings to run PROPHET |
| `WEEKLY_DEFAULT_BATCH_SIZE` | `3` | Stocks per batch in weekly scan |
| `WEEKLY_DEFAULT_BATCH_DELAY_MS` | `2000` | Delay between batches (rate-limit protection) |

---

## 18. Deployment & Operations

### Starting the System

```bash
# Backend
cd backend
npm install
npm start               # Production
npm run dev             # Development (nodemon)

# Frontend (Next.js)
cd frontend
npm install
npm run dev             # http://localhost:3000
```

### Health Check

```
GET http://localhost:3001/health
```
Returns: DB status, uptime, port, scheduler running state, worker states.

### Manual Controls

| Action | Method |
|--------|--------|
| Pause all trading immediately | Set `AI_TRADING_ENABLED=false` in `.env` and restart |
| Emergency halt (no restart needed) | `redis-cli SET HALT_ALL "manual-halt"` |
| Resume from auto-pause | `redis-cli DEL HALT_ALL` |
| Disable a specific user's bot | POST `/enhanced-ai-trading/toggle` with `{enabled: false}` |
| Raise minimum buy score | POST `/enhanced-ai-trading/config` with `{minBuyScore: 88}` |

### Resource Profile During Market Hours

| Component | Frequency | DB Queries | External API |
|-----------|-----------|-----------|-------------|
| Market regime | Every 60 min | 0 (cached) | 7 Yahoo quotes |
| Stock scan (TOP_200) | Once per cycle | 1 (universe) | ~200 × 5 parallel |
| Batch delay between stocks | Built-in | 0 | 3s between batches of 5 |
| Per-cycle cooldown check | Once per cycle | 1 batch query | 0 |
| System health multiplier | Every 30 min | 2 queries | 0 |
| Holdings management | Once per cycle | 1 fetch + writes on sell | Broker API on sell |
| EOD functions (15:44 ET) | Once per day | 4–6 queries | 0 |
| Weekly health (Fri 15:45 ET) | Once per week | 7 queries + backtest | 0 |

**Total scan time (TOP_200):** 2–4 minutes per cycle.  
**isRunning guard** prevents cycle overlaps — if a cycle takes longer than 5 minutes, the next tick is skipped.

### Log Files

The system uses Winston structured logging with correlation IDs on every request. Log level controlled by `LOG_LEVEL` env var.

Key log prefixes:
- `[Enhanced AI Scheduler]` — cycle start/stop, user processing
- `[RegimeGuard]` — regime-based trade blocks
- `[BleedingGate]` — chronic-loser symbol blocks
- `[AutoPause]` — catastrophic anomaly HALT_ALL events
- `[AnomalyDetection]` — EOD anomaly alerts
- `[DailyDigest]` — EOD digest sends
- `[Weekly Health]` — Friday health check output
- `[ORACLE]` / `[VISION]` / `[PROPHET]` etc. — per-agent activity

---

## 19. News & Sentiment Architecture

### 19.1 News Sources

**Primary file:** `backend/src/services/newsSentimentService.js`

News sentiment is computed per-symbol by pulling from three independent sources and merging the results into a single weighted score:

| Source | Weight | API Key Required | Coverage |
|--------|:------:|:----------------:|---------|
| Yahoo Finance | 1.0× | ❌ Free | General financial news |
| Alpha Vantage | 1.15× | `ALPHA_VANTAGE_KEY` | Financial news with pre-computed sentiment |
| X / Twitter | ~1.0× | `X_BEARER_TOKEN` | Real-time social sentiment |

**Aggregated news feed:** `backend/src/services/newsAggregationService.js`  
Pulls from all three sources into a 15-minute file cache (`newsCache.json`) keyed by scope (`ALL` for macro, or per-symbol). The `/api/news-aggregation/*` endpoints serve this cache.

**Cache TTLs:**

| Cache | Duration | Env Override |
|-------|---------|-------------|
| Per-symbol sentiment | 30 minutes | `NEWS_SENTIMENT_CACHE_MS` |
| Stale fallback | 6 hours | `NEWS_SENTIMENT_STALE_MS` |
| News aggregation file | 15 minutes | — |
| Max articles per symbol | 12 | `NEWS_SENTIMENT_MAX_ARTICLES` |

### 19.2 X/Twitter Integration

**File:** `backend/src/services/xNewsService.js`

| Property | Value |
|----------|-------|
| API version | X API v2 |
| Endpoint | `https://api.x.com/2/tweets/search/recent` |
| Auth | Bearer token (`X_BEARER_TOKEN` or `TWITTER_BEARER_TOKEN`) |
| Rate limit | 1 search per 15 minutes (free tier) |
| Rate limit window | `X_RATE_LIMIT_MS` (default 900,000 ms) |

**Query strategy:**
- Per-symbol search: `$SYMBOL -is:retweet -is:reply lang:en`  
- Macro market queries: S&P 500, Nasdaq, earnings, guidance — for overall sentiment
- Each tweet returns: engagement metrics (likes, retweets, replies, quotes), author info, shareable URL

### 19.3 Sentiment Scoring Flow

```
Per symbol:
  1. Fetch articles from Yahoo Finance + Alpha Vantage + X/Twitter (parallel)
  2. Deduplicate by headline similarity
  3. Score each article:
     - Alpha Vantage: use providedSentiment field directly
     - Yahoo / X: run through internal NLP scorer
  4. Apply source weight multiplier
  5. Average weighted scores → sentimentScore (0–100, 50 = neutral)
  6. Map to: Bullish (>55) / Neutral (45–55) / Bearish (<45)
  7. Count unique sources → newsSourceCount (signals quality)
  8. Count X posts → xPostCount (social momentum signal)
  9. Store in cache

Output used in PANTHEON:
  newsScoreAdjustment = (sentiment / 100) × AI_NEWS_MAX_IMPACT × AI_NEWS_SCORE_WEIGHT
  Range: typically −8 to +8 points
```

---

## 20. Multi-Model AI Ensemble

**File:** `backend/src/services/multiModelAIService.js`

Used by the **Weekly Prediction Engine** (`getMultiModelPrediction`) to score each stock for the weekly report. Differs from the live PANTHEON pipeline — this is batch-oriented and optimised for the weekly scan.

### Ensemble Composition

| Model | Type | Weight | Provider | Purpose |
|-------|------|:------:|---------|---------|
| **FinBERT** | Financial NLP | 35% | Hugging Face (`HUGGINGFACE_API_KEY`) | Sentiment from financial text |
| **DistilBERT** | General NLP | 20% | Hugging Face | General English sentiment |
| **Technical Agent** | Rule-based | 25% | Internal | Chart pattern recognition |
| **Momentum Agent** | Rule-based | 20% | Internal | Momentum-based signal generation |

### Ensemble Execution

```
For each symbol:
  1. Fetch all 4 models in parallel
  2. Individual model timeout: 5 seconds
  3. Hard ensemble cap: 7 seconds total
  4. Weighted consensus vote across fulfilled models
  5. Return: signal (Buy/Hold/Avoid), confidence, individual model verdicts

429 Handling:
  - Track consecutive rate-limit errors per provider
  - After 3 consecutive 429s → enter 10-minute cooldown
  - Env: AI_PROVIDER_429_THRESHOLD=3, AI_PROVIDER_COOLDOWN_MS=600000
```

**Fallback:** If Hugging Face is unavailable, the two rule-based agents (Technical + Momentum) still return a consensus using their combined 45% weight, normalized to 100%.

---

## 21. Historical Backtest Engine

**File:** `backend/src/services/historicalBacktestEngine.js`

### 21.1 Methodology

The engine replays market history chronologically using the **same scoring logic** as the live bot — no lookahead bias.

**Simulation parameters:**

| Parameter | Default Value |
|-----------|:------------:|
| Historical data window | 5 years of daily OHLCV |
| Starting capital | $10,000 |
| Commission per trade | 0.1% |
| Slippage per trade | 0.1% |
| Max concurrent positions | 10 |
| Max single position size | 15% of portfolio |
| Min AI score to buy | 65 |
| Hard stop-loss | −12% |
| Take-profit target | +25% |
| Trailing stop | 8% |
| Warmup period (no trades) | 60 days (indicators built up) |

**Walk-forward process:**
```
Day 0–60:   Warmup — compute indicators, no positions
Day 61+:    Each day:
              - Score all universe symbols using same PANTHEON logic
              - Any score ≥ 65 and signal=BUY → open position (if under limits)
              - Apply stop-loss / take-profit / trailing-stop checks
              - Close positions that hit exit rules
              - Record daily portfolio value
End of run: Compute aggregate metrics vs buy-and-hold SPY
```

### 21.2 Go-Live Criteria

The backtest must pass **all four** criteria before live trading is considered:

| Metric | Required Threshold |
|--------|--------------------|
| Sharpe Ratio | > 1.5 |
| Max Drawdown | < 15% |
| Win Rate (out-of-sample) | > 52% |
| Total Return | > SPY over same period |

The weekly health check automatically runs a backtest on the **top 20 RS symbols** from `asset_universe_daily` every Friday at 15:45 ET and sends results via Telegram.

---

## 22. Trade Intelligence & Expectancy

**File:** `backend/src/services/tradeIntelligenceService.js`  
**Table:** `trade_decision_journal`

Every trade decision passes through three lifecycle phases, each recorded as a row:

```
CANDIDATE  → Symbol passed filters; being considered for execution
EXECUTED   → Order placed; entry price locked in
CLOSED     → Position closed; P&L calculated and recorded
```

### Expectancy Adjustment

Before execution, each opportunity is adjusted by historical expectancy for its `setup_family` + `strategy_family` combination:

```
expectancyStats = {
  winRate,          // historical win rate for this setup type
  avgWin,           // average winning trade %
  avgLoss,          // average losing trade %
  expectancy,       // (winRate × avgWin) − (lossRate × avgLoss)
  sizeMultiplier,   // position size scale: 0.5 (poor) → 1.5 (excellent)
  sampleSize        // number of historical trades used
}
```

`sizeMultiplier` flows into the combined Kelly position size:
```
combinedMultiplier = regimeMultiplier × healthMultiplier × streakMultiplier × expectancySizeMultiplier
```

### Journal Fields

| Field | Type | Description |
|-------|------|-------------|
| `symbol` | VARCHAR | Ticker |
| `bot_type` | VARCHAR | `stock` or `options` |
| `decision_phase` | VARCHAR | `CANDIDATE`, `EXECUTED`, `CLOSED` |
| `score` | DECIMAL | Final PANTHEON score at decision time |
| `setup_family` | VARCHAR | `breakout_leader`, `news_momentum`, `stage2_uptrend`, etc. |
| `regime` | VARCHAR | Market regime at trade time |
| `entry_price` | DECIMAL | Fill price on buy |
| `exit_price` | DECIMAL | Fill price on sell |
| `pnl` | DECIMAL | Realised P&L in dollars |
| `pnl_percent` | DECIMAL | Realised P&L as % |
| `metadata` | JSONB | autoTags, signalPrice, slippage, exitReason, scoringLog |
| `opened_at` | TIMESTAMP | When position was entered |
| `closed_at` | TIMESTAMP | When position was exited |

---

## 23. Trade Auto-Tagging System

Every BUY order is tagged at execution time with a list of `autoTags` stored in `trade_decision_journal.metadata.autoTags`. Tags are purely descriptive — they do not affect scoring, but they power the **weekly health check**, **alpha decay analysis**, and **EOD trade stories**.

| Tag | Condition | Meaning |
|-----|-----------|---------|
| `gap_play` | `opportunity.change > 5%` | Opened on a >5% daily gap |
| `news_driven` | `opportunity.newsSentiment > 30` | Strong positive news sentiment |
| `52w_breakout` | `week52HighProximity > 92%` | Trading within 8% of 52-week high |
| `stage2_uptrend` | `weinSteinStage === 2` | Weinstein Stage 2 confirmed uptrend |
| `oversold` | `RSI < 35` | Entered on oversold bounce |
| `momentum` | `setupFamily === 'breakout_leader'` | RS breakout momentum play |
| `catalyst` | `setupFamily === 'news_momentum'` | News-catalysed entry |
| `bull_regime_entry` | Regime type includes BULL or RISK_ON | Entered in a bullish macro environment |

### Usage in Analytics

```sql
-- Which tags are producing the best returns?
SELECT
    tag,
    COUNT(*) AS trades,
    ROUND(AVG(pnl_percent), 2) AS avg_return,
    ROUND(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1) AS win_rate
FROM trade_decision_journal,
     jsonb_array_elements_text(metadata->'autoTags') AS tag
WHERE decision_phase = 'CLOSED' AND pnl IS NOT NULL
  AND created_at >= NOW() - INTERVAL '90 days'
GROUP BY tag ORDER BY avg_return DESC;
```

---

## 24. Activation Gates — PANTHEON Progression

**File:** `backend/src/services/activationGateService.js`

PANTHEON defines a **five-step progression** that unlocks more sophisticated (and risky) strategies only after demonstrating consistent profitability at each prior level. Gates are advisory by default; set `ACTIVATION_GATES_ENFORCE=true` to hard-block advancement.

```
Step 1: SWING TRADING          ← Active from day one
  │  Gate to Step 2:
  │    • Win rate ≥ 60%
  │    • Live AI trades ≥ 30
  ▼
Step 2: KELLY CONFIDENCE SIZING  ← Dynamic position scaling
  │  Gate to Step 3:
  │    • 8 consecutive profitable weeks
  ▼
Step 3: OPTIONS TRADING          ← Options bot enabled
  │  Gate to Step 4:
  │    • Win rate ≥ 62%
  │    • Live AI trades ≥ 60
  ▼
Step 4: SHORT SELLING            ← NOT YET IMPLEMENTED
  ▼
Step 5: STAT ARB + ALT DATA      ← NOT YET IMPLEMENTED
```

**Checking current gate status:**
```
GET /api/enhanced-ai-trading/status/:userId
→ response includes activationGate: { currentStep, meetsNext, requirements }
```

---

## 25. Sector Trade Profiles

The bot uses **sector-specific trade profiles** that widen or tighten stop/target geometry and enforce a sector minimum score. This prevents the bot from trading defensive sectors (Utilities, Staples) on the same terms as high-growth tech.

| Profile | Applied To | Stop Multiplier | Target Multiplier | Min Score |
|---------|-----------|:---------------:|:-----------------:|:---------:|
| `AGGRESSIVE` | Technology, Biotech, Crypto | 1.5× ATR | 3.0× ATR | 82 |
| `STANDARD` | Financials, Healthcare, Industrials | 1.5× ATR | 2.5× ATR | 82 |
| `DEFENSIVE` | Utilities, Consumer Staples, REITs | 1.2× ATR | 2.0× ATR | **78** |

**Defensive note:** Utilities and Consumer Staples need a minimum score of 78 before they appear in the opportunity list. In practice, momentum-based signals rarely reach this bar in these sectors, so they naturally self-exclude without a hardcoded blacklist.

---

## 26. Worker Coordination

**File:** `backend/src/services/workerCoordinationService.js`  
**Table:** `worker_runtime_status`

For environments with multiple processes or EC2 instances, the worker coordinator provides **leader election** to prevent duplicate work (e.g., two instances both running the AI scan).

| Property | Value |
|----------|-------|
| Heartbeat interval | 30 seconds (`WORKER_HEARTBEAT_INTERVAL_MS`) |
| Stale threshold | 90 seconds (`WORKER_STALE_THRESHOLD_MS`) |
| Election strategy | Last heartbeat wins; stale workers are demoted |
| Metadata | Custom JSON per worker for status detail |

**Worker runtime status table columns:**

| Column | Type | Description |
|--------|------|-------------|
| `name` | VARCHAR | Worker identifier (e.g., `ai-scheduler`, `backtest-runner`) |
| `instance_id` | VARCHAR | Unique process/EC2 ID |
| `role` | VARCHAR | `leader` or `follower` |
| `status` | VARCHAR | `active`, `idle`, `stale` |
| `heartbeat` | TIMESTAMP | Last seen |
| `metadata` | JSONB | Worker-specific status payload |

**Health check integration:** `GET /health` includes current worker statuses.

---

## 27. Complete Database Table Reference

**Total tables:** 28  
**Database:** `kiranrock_trading` (PostgreSQL)

### User & Account Tables

| Table | Purpose |
|-------|---------|
| `users` | User accounts: id, username, email, password_hash, telegram_chat_id, role |
| `trading_accounts` | Cash balance per user: user_id, balance, updated_at |
| `sessions` | JWT session tracking |
| `risk_configs` | Per-user risk parameters: minBuyScore, maxPortfolioRisk, stopLoss, takeProfit, dailyLossLimit, weeklyLossLimit |

### Trading Tables

| Table | Purpose |
|-------|---------|
| `holdings` | Open positions: user_id, symbol, quantity, average_price, peak_price, atr, partial_profit_taken, current_price |
| `trades` | Buy/sell history: user_id, symbol, action, shares, price, total, timestamp |
| `order_audit_log` | ARROW append-only state machine: idempotency_key, state, transitions, timestamps |
| `portfolio_snapshots` | Daily portfolio value snapshots for chart history |

### AI & Intelligence Tables

| Table | Purpose |
|-------|---------|
| `ai_trading_logs` | Per-cycle scheduler output: success, trades_executed, capital_deployed |
| `ai_decisions` | Individual AI decision records |
| `trade_decision_journal` | Full PANTHEON audit trail (see [Section 22](#22-trade-intelligence--expectancy)) |

### Market Data Tables

| Table | Purpose |
|-------|---------|
| `daily_bars` | Cached OHLCV: symbol, date, open, high, low, close, volume |
| `ohlcv_cache` | Short-lived intraday price cache |
| `asset_universe` | Static symbol reference list |
| `asset_universe_daily` | Dynamic universe: universe_date, symbol, rs_score — rebuilt daily |
| `asset_blacklist` | Cooldown + chronic-loser blocks: symbol, reason, added_by, expires_at |
| `asset_halts` | Symbols halted from trading (regulatory / operator) |

### Options Tables

| Table | Purpose |
|-------|---------|
| `options_alerts` | Options bot alerts |

### Alert & News Tables

| Table | Purpose |
|-------|---------|
| `alerts` | User price alerts: symbol, target_price, direction, triggered |
| `news_alerts` | News-triggered alerts |
| `news_monitor_runs` | Log of news monitor execution runs |
| `stock_signal_telegram_events` | Tracks which Telegram signal messages were sent |
| `stock_signal_snapshots` | Point-in-time signal snapshots for deduplication |

### System Tables

| Table | Purpose |
|-------|---------|
| `system_controls` | Global and per-user trading kill switches |
| `worker_runtime_status` | Worker leader election and heartbeats |
| `watchlist` | Per-user watchlist: user_id, symbol, added_at |
| `stock_feed_popup_preferences` | UI preferences for stock feed popups |
| `stock_feed_dismissals` | Tracks dismissed feed items per user |

---

## 28. Frontend Page Map

**Framework:** Next.js (App Router)  
**Dev URL:** `http://localhost:3000`

| Page | Route | Description |
|------|-------|-------------|
| Home | `/` | Landing / redirect to dashboard |
| Login | `/login` | JWT authentication form |
| Dashboard | `/dashboard` | Portfolio summary, live P&L, regime indicator, open positions |
| AI Trading | `/ai-trading` | Autonomous bot toggle, risk config, scan history |
| Portfolio | `/portfolio` | Holdings table, chart, deposit/withdraw |
| Performance | `/performance` | Scorecard, Sharpe, Kelly, drawdown charts, intelligence drilldown |
| Weekly | `/weekly` | Weekly prediction picks, ranked universe, export CSV |
| Backtest | `/backtest` | Historical bot simulation report, AI analysis |
| Options Bot | `/options-bot` | Options bot config, positions, strategy performance |
| News | `/news` | Aggregated news feed, macro + per-symbol |
| Alerts | `/alerts` | Price alert management |
| Recommendations | `/recommendations` | AI-recommended buy list |
| Swing Trading | `/swing-trading` | Swing trade setups and signals |
| Scalping | `/scalping` | Intraday scalping setups |
| Scenarios | `/scenarios` | Options scenario modelling (price change, theta decay, matrix) |
| Profile | `/profile` | User profile, Telegram setup, password change |
| Local Data | `/localdata` | View locally cached ticker data |

---

## 29. Setup & Installation Guide

### Prerequisites

| Requirement | Version |
|-------------|---------|
| Node.js | ≥ 18 |
| PostgreSQL | ≥ 14 |
| Redis | ≥ 6 (optional — for multi-process coordination) |
| Ollama | Latest (optional — local AI fallback) |

### Step 1 — Clone and Install

```bash
git clone <repo-url> KiranRock
cd KiranRock

# Backend
cd backend
npm install

# Frontend
cd ../frontend
npm install
```

### Step 2 — Create PostgreSQL Database

```sql
CREATE DATABASE kiranrock_trading;
CREATE USER kiranrock_user WITH PASSWORD 'your_password';
GRANT ALL PRIVILEGES ON DATABASE kiranrock_trading TO kiranrock_user;
```

### Step 3 — Configure Environment

```bash
cd backend
cp .env.example .env
```

Edit `.env` — at minimum set:
```env
DB_PASSWORD=your_password
JWT_SECRET=<64-char random hex>
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your chat ID>
```

For real-time data (recommended):
```env
DATA_PROVIDER=alpaca
ALPACA_KEY_ID=<key>
ALPACA_SECRET_KEY=<secret>
ALPACA_PAPER=true
BROKER=alpaca
```

### Step 4 — Initialise Database Schema

The schema is created automatically on first start. To run manually:

```bash
cd backend
node src/config/initDatabase.js
```

### Step 5 — Start the System

```bash
# Terminal 1 — Backend
cd backend
npm start

# Terminal 2 — Frontend
cd frontend
npm run dev
```

Verify:
```
GET http://localhost:3001/health   → { status: 'ok', dbConnected: true }
Frontend:  http://localhost:3000
```

### Step 6 — Configure Telegram

1. Message `@BotFather` on Telegram → create a bot → copy the token
2. Set `TELEGRAM_BOT_TOKEN=<token>` in `.env`
3. Get your chat ID: run `node backend/src/getChatId.js`
4. Set `TELEGRAM_CHAT_ID=<id>` in `.env`
5. Restart backend → you should receive a startup message

### Step 7 — Enable Autonomous Trading

1. Log in at `http://localhost:3000/login`
2. Navigate to AI Trading → toggle **Enable AI Trading**
3. Review risk config: minBuyScore (82), maxPortfolioRisk, stopLoss
4. The scheduler will start trading at next market open (9:30 AM ET)

### Step 8 — Optional: Ollama Local AI

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull the model used by ORACLE and PROPHET
ollama pull llama3.2:3b

# Verify
ollama run llama3.2:3b "Hello"
```

Set in `.env`:
```env
ORACLE_ALLOW_CLAUDE_FALLBACK=false   # Use Ollama only
```

---

## 30. Troubleshooting Guide

### Weekly Report: timeout or "No predictions available"

**Symptom:**  
```
[Report] ALL fetch failed: timeout of 900000ms exceeded
[Weekly Report] WARNING: No predictions available
```

**Cause:** Default primary universe was `ALL` (820 stocks × API time > 15 min). Fixed in current version.

**Fix:**  
```env
TELEGRAM_REPORT_PRIMARY_UNIVERSE=TOP_200   # in .env (now the default)
```
The system now falls back automatically: `TOP_200 (240s) → MEGA_CAP (90s)`.

---

### Bot not placing trades despite being enabled

**Checklist:**

| Check | Command / Location |
|-------|--------------------|
| Market is open? | `GET /api/enhanced-ai-trading/market/status` |
| Redis HALT_ALL set? | `redis-cli GET HALT_ALL` |
| Global kill switch? | `GET /api/enhanced-ai-trading/scheduler/status` |
| `AI_TRADING_ENABLED` env? | Check `.env` |
| `BOT_ENABLED` env? | Check `.env` |
| Daily loss limit hit? | Check Telegram — should have sent alert |
| Regime blocking entries? | Telegram regime alert, or `GET /api/performance/scorecard` |

To resume after auto-pause:
```bash
redis-cli DEL HALT_ALL
```

---

### Yahoo Finance 429 rate-limit errors

**Symptom:**  
```
[DataProvider] Yahoo Finance 429 — rate limited
```

**Causes and fixes:**

| Cause | Fix |
|-------|-----|
| Scan batch too fast | Already limited to batch-5 with 3s delay |
| Too many concurrent users | Reduce `HERMES_MAX_STOCKS` in `.env` |
| Upgrade to real-time data | Set `DATA_PROVIDER=alpaca` with API keys |

---

### Database connection errors

**Symptom:** `Error: connect ECONNREFUSED 127.0.0.1:5432`

**Fix:**
```bash
# Check PostgreSQL is running
sudo systemctl status postgresql   # Linux
brew services list | grep postgres # macOS

# Test connection
psql -U postgres -d kiranrock_trading -c "SELECT 1"
```

---

### Telegram alerts not arriving

**Checklist:**
1. `TELEGRAM_BOT_TOKEN` set in `.env`?
2. `TELEGRAM_CHAT_ID` set? (Run `node backend/src/getChatId.js`)
3. Did you start a conversation with the bot first? (Must message the bot before it can message you)
4. Check backend logs for `[TelegramAlert] Failed` entries

---

### Redis unavailable warnings

**Symptom:**  
```
[RedisState] Redis unavailable — HALT_ALL defaulting to null
```

**This is non-fatal.** The system runs in single-process mode without Redis — all trading logic continues normally. Redis is only required for multi-EC2 coordination. To silence warnings:

```bash
# Install and start Redis
sudo apt install redis-server && sudo systemctl start redis

# Or on Windows
choco install redis-64 && redis-server
```

---

### ORACLE / PROPHET not firing

**Possible causes:**

| Cause | Fix |
|-------|-----|
| No Ollama running | Install and run `ollama pull llama3.2:3b` |
| Pre-score below 55 | ORACLE only runs when score ≥ 55 — normal |
| Budget exhausted | `ORACLE_MAX_PER_CYCLE` reached; increases next cycle |
| Earnings not within window | PROPHET fires only 15–45 days before earnings |
| API key missing (Claude) | Set `ANTHROPIC_API_KEY` or use Ollama fallback |

---

### Performance: scan takes longer than 5 minutes

**Cause:** Too many qualified stocks for the 5-minute cycle.

**Fixes (in order of preference):**

1. Raise `HERMES_MIN_MARKET_CAP` to $10B — reduces universe to ~80 symbols  
2. Raise `minBuyScore` to 85 — quick-filter rejects more early  
3. Reduce `ORACLE_MAX_PER_CYCLE` to 10 — fewer Claude API calls  
4. Upgrade `DATA_PROVIDER` to `alpaca` — faster quote fetching  

The `isRunning` guard means overlapping cycles are automatically skipped — no duplicate trades will occur.

---

## 31. Glossary

| Term | Definition |
|------|-----------|
| **ARROW** | Order lifecycle state machine. Append-only audit log that tracks every order from creation to journaled/closed. Named after the direction of capital flow. |
| **COMPASS** | Sector Relative Strength Navigator. Tracks 11 sector ETFs vs SPY to identify sector rotation. Hot sectors get score tailwind; cold sectors get penalty. |
| **EVOLVE** | Decision-table ML signal. Builds feature-bucket win-rate model from 2 years of OHLCV data. No GPU or external library. Rebuilds every 24 hours. |
| **FRED** | Federal Reserve Economic Data. Used by SHIELD to assess macro environment (rates, yield curve, unemployment). |
| **GEMINI PULSE** | News headline sentiment agent using Google Gemini API. Analyses up to 12 recent headlines per symbol. |
| **HALT_ALL** | Redis key that is the global emergency kill switch. When set, all scheduler cycles skip entirely. Set automatically by auto-pause or manually by operator. |
| **HERMES** | The RS-sorted stock universe generator. Named after the messenger god — it brings the highest-momentum symbols to ORACLE first. |
| **isRunning** | Module-level boolean flag in the scheduler. Prevents a new trading cycle from starting if the previous one is still in progress. |
| **Kelly Criterion** | Mathematical formula for optimal position sizing: `W − (1−W)/R`. KiranRock uses half-Kelly for safety. |
| **LOCAL BRAIN** | Historical pattern intelligence. Builds win-rate lookup table keyed by `sector × chart_pattern × regime` from this account's own trade history. |
| **minBuyScore** | Minimum composite PANTHEON score (0–100) required to execute a BUY order. Default 82; raised by regime and health multiplier. |
| **ORACLE** | Master trade strategist agent. Runs a prompt through Claude or Ollama implementing 8 legendary trading methodologies. Budget-capped at 25 calls/cycle. |
| **PANTHEON** | The collective name for all AI scoring agents (ORACLE, VISION, PROPHET, SAGE, SONAR, PULSE, LOCAL BRAIN, EVOLVE, SHIELD, COMPASS). Each contributes bounded score adjustments. |
| **PROPHET** | Earnings direction forecaster. Fires 15–45 days before earnings using Claude / Ollama. Returns BEAT / IN_LINE / MISS with confidence score. |
| **RS Score** | Relative Strength score. Measures a stock's price performance relative to SPY over a lookback window. Used to rank and prioritise the trading universe. |
| **SAGE** | Learning brain. Reads closed trade history, computes Kelly metrics, writes `learned_adjustments.json`. Regenerates after each session. |
| **Setup Family** | Classification of a trade's technical thesis: `breakout_leader`, `news_momentum`, `stage2_uptrend`, `oversold_bounce`, etc. Used for alpha decay analysis. |
| **SHIELD** | FRED macro gate. Raises minBuyScore or halts new buys entirely when macro environment is severely bearish. |
| **SONAR** | Institutional tracker. Scores smart money interest (institutional ownership + insider transactions) on a 0–1 scale. |
| **System Health Multiplier** | A 0.5–1.0 multiplier applied to position size. Reduces exposure automatically when the bot's recent win rate is declining or setup families are showing alpha decay. |
| **VISION** | Rule-based directional classifier. Estimates probability of upward move in the next 5 trading days using MA alignment, RSI, volume, and breakout proximity. |
| **Weinstein Stage** | Stan Weinstein's 4-stage stock cycle model. Stage 1=base, 2=uptrend, 3=topping, 4=downtrend. The bot only buys Stage 1–2; hard-blocks Stage 3–4. |
| **What-If Simulator** | Weekly health check feature that retrospectively re-filters trade history at score thresholds [82, 84, 85, 86, 88, 90] to show what win rate and P&L would have been at each bar. |

---

*End of KiranRock Trading System Technical Reference*  
*Version 2.0 — May 2026*  
*For changes: update this document in the same commit as any code modification.*
