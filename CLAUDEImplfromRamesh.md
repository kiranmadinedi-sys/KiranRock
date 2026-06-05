# PANTHEON — Assembly of Legends

## AI Trading System · CLAUDE.md · System Context for Claude Code

> Read this file completely before writing any code.
> Every file you create must fit this architecture exactly.
> This is the single source of truth for all development sessions.

-----

## Vision

PANTHEON is a production-grade algorithmic trading system. The goal is to prove a systematic edge in equity markets using AI signal generation, disciplined risk management, and continuous self-improvement. Performance targets are engineering objectives, not financial guarantees. The system succeeds when it produces measurable, repeatable results that can be validated and improved.

**First engineering target:** 6-8%/month from swing trading (Step 1).
**Long-term hypothesis:** 20-30%/month with all 5 return streams active.

-----

## Governing Principle

**Build everything together. Activate power gradually based on performance.**

Every agent is coded from day one. What changes over time is which modules are ACTIVE — driven by validated performance, never by a calendar. SAGE, VISION, and EVOLVE learn ONLY from validated signal data. Activate out of sequence and all ML agents train on garbage permanently.

-----

## Proven Activation Sequence (NON-NEGOTIABLE)

```
Step 1: Swing trading (ORACLE + SHIELD + SCALE)
        Gate: 60%+ win rate over 30+ live trades

Step 2: Kelly confidence sizing (SCALE upgrade)
        Gate: 8 consecutive profitable weeks

Step 3: Options
        Gate: 62%+ win rate over 60 live trades

Step 4: Short selling
        Gate: Options profitable for 4+ weeks

Step 5: Stat arb + alt data
        Gate: Shorts profitable for 4+ weeks
```

-----

## The 16 Agents

|Name   |Role                        |Model                   |Schedule                    |
|-------|----------------------------|------------------------|----------------------------|
|ATLAS  |Data Collector              |Python + APIs           |6:30 AM IST                 |
|HERMES |Universe Filter (Gatekeeper)|Python rules            |7:00 AM IST                 |
|PULSE  |News Analyst                |Gemini 3.1              |7:15 AM IST                 |
|ORACLE |Trade Strategist            |Claude Sonnet 4.6       |7:45 AM IST                 |
|SHIELD |Risk Guardian               |Claude + Rules          |8:15 AM IST                 |
|SCALE  |Bet Calculator              |Python Kelly            |8:30 AM IST                 |
|ARROW  |Order Placer                |Kite + Alpaca           |9:15 AM IST                 |
|RADAR  |Watchman                    |Streamlit + Telegram    |All day                     |
|SAGE   |The Learning Brain          |Claude Sonnet 4.6       |Every trade + 4PM + monthly |
|COMPASS|Sector Navigator            |Python RS               |6:45 AM IST                 |
|VISION |Pattern Prophet             |LSTM Python             |Pre-market + monthly retrain|
|SONAR  |Institutional Tracker       |Polygon + Python        |Real-time                   |
|PROPHET|Earnings Forecaster         |Claude + Alt Data       |Pre-earnings                |
|EVOLVE |The Self-Optimiser          |PPO + Python            |Continuous                  |
|FORGE  |DevOps Agent                |GitHub Actions + AWS CDK|Every git push              |
|TITAN  |Crypto Agent                |CCXT + Alpaca + Binance |24/7 every 4 hours          |

-----

## Agent Contracts (Input / Output / On Failure)

|Agent  |Input                                  |Output                                                                                                                      |On Failure                                                           |
|-------|---------------------------------------|----------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------|
|ATLAS  |Trigger + config                       |PostgreSQL ohlcv table. Redis DATA_STALE updated.                                                                           |Retry 3x. Breeze fallback. Block pipeline if stale > 30 min.         |
|HERMES |ATLAS ohlcv + filters                  |DataFrame: symbol, exchange, sector, market_cap (max 200 rows). Redis HERMES_UNIVERSE.                                      |Skip bad symbols. Never halt. Log exclusions.                        |
|PULSE  |HERMES symbols + Finnhub               |Dict: symbol to score 0-100, label, articles. Redis PULSE_SCORES.                                                           |Default 50/Neutral. Never block ORACLE.                              |
|ORACLE |HERMES + PULSE + ATLAS + COMPASS       |JSON per symbol: verdict, score, stage, pattern, entry, stop, target, risk_reward, thesis, key_risk. Redis ORACLE_WATCHLIST.|Skip symbol on Claude failure. Never partial JSON.                   |
|SHIELD |ORACLE watchlist + macro data          |Dict per signal: symbol, approved bool, reason. Redis SHIELD_APPROVED.                                                      |Default BLOCKED not APPROVED on any error.                           |
|SCALE  |SHIELD approved + ORACLE scores        |Dict: symbol, quantity int, dollar_risk float, position_pct float.                                                          |Minimum size on error. Hard cap at RISK_POLICY always.               |
|ARROW  |SCALE sizing + ORACLE entry/stop/target|PostgreSQL orders table. Redis POSITIONS_OPEN updated.                                                                      |Reject + alert on broker error. Idempotency check before every retry.|
|RADAR  |Redis POSITIONS_OPEN + broker feed     |Telegram messages. Streamlit state. CloudWatch metrics.                                                                     |Degrade gracefully. Never halt due to Telegram failure.              |
|SAGE   |PostgreSQL orders + trades             |Journal entries. prompts/trade_score_current.txt monthly. Redis SAGE_ACCURACY.                                              |Write raw data first, WHY second. Partial journal better than none.  |
|COMPASS|ATLAS ETF + sector index prices        |Dict: sector to rs_rank. Redis COMPASS_SECTOR_RANK.                                                                         |Equal-weight fallback. Never block ORACLE.                           |

-----

## Build Priority — Step 1 MVR Sequence

```
Build 1:  ATLAS     — Alpaca USA only. Fetch OHLCV S&P500. Store to PostgreSQL.
Build 2:  HERMES    — Filter 500 to 150. build_universe.py migrated.
Build 3:  ORACLE    — Claude scoring. Valid JSON. Scores range 30-90 (NOT all 52.1).
Build 4:  SHIELD    — VIX + SPY 200MA + earnings blackout. APPROVED/BLOCKED output.
Build 5:  SCALE     — Fixed 2% only. Correct quantity returned.
Build 6:  ARROW     — Alpaca paper endpoint. Bracket orders. Stop at entry.
Build 7:  SAGE      — Basic journal. why_engine.py migrated.
Build 8:  RADAR     — Telegram alerts only. Morning signal + stop-hit.

STOP — Validate 2-3 weeks on paper endpoint.
60% win rate over 30 trades = proceed to Build 9+.
Below 60% = fix before adding anything new.
```

**Day 1 first task:** Fix flat 52.1 scoring bug in multi_factor_scoring.py
Root cause: _score_from_percentile() returns 50.0 for NaN values.
Fix calibration so scores genuinely differentiate between stocks.

-----

## Repository Structure

```
pantheon/
├── main.py                      # Orchestrator
├── config.py                    # RISK_POLICY + all settings
├── CLAUDE.md                    # This file
├── .env                         # API keys — NEVER commit
├── requirements.txt
│
├── data/
│   ├── kite_connector.py        # ATLAS India
│   ├── alpaca_connector.py      # ATLAS USA
│   ├── finnhub_connector.py     # ATLAS news
│   └── data_fetcher.py          # ATLAS unified interface
│
├── scanners/
│   ├── market_state.py          # Bull/Bear/Sideways detector
│   ├── universe_filter.py       # HERMES
│   ├── scanner_a.py             # Bull breakouts
│   ├── scanner_b.py             # Bear reversals
│   ├── scanner_c.py             # Sideways range
│   ├── scanner_d.py             # Earnings plays
│   └── sector_rotation.py       # COMPASS
│
├── indicators/
│   └── indicators.py            # RSI, MACD, EMA, BB, ATR, VWAP, VCP
│
├── ai/
│   ├── claude_engine.py         # ORACLE — Claude API
│   ├── gemini_engine.py         # PULSE — Gemini
│   ├── scoring_model.py         # 100-point scoring
│   ├── journal_writer.py        # SAGE journal
│   └── prompts/
│       ├── trade_score_v1.txt
│       ├── trade_score_current.txt
│       ├── learned_adjustments.txt
│       ├── experimental_signals.txt
│       └── changelog.txt
│
├── execution/
│   ├── trader.py                # ARROW — limit orders only
│   ├── position_sizer.py        # SCALE — Kelly
│   └── stop_manager.py          # ATR stops + trailing
│
├── risk/
│   ├── global_risk.py           # SHIELD
│   ├── macro_regime.py          # Turbulence index + FRED
│   └── correlation_engine.py    # Portfolio correlation
│
├── ml/
│   ├── lstm_predictor.py        # VISION
│   ├── rl_agent.py              # EVOLVE — PPO
│   └── model_trainer.py         # Monthly retraining
│
├── dashboard/
│   ├── dashboard.py             # RADAR — Streamlit
│   ├── charts.py                # Plotly
│   └── telegram_bot.py          # Alerts
│
├── backtest/
│   ├── backtest_engine.py
│   └── monte_carlo.py           # 10,000 simulations
│
├── db/
│   ├── db_models.py             # PostgreSQL schema
│   └── migrations/
│
├── scripts/
│   ├── health_check.py          # FORGE post-deploy
│   └── notify_telegram.py       # FORGE alerts
│
└── tests/
    ├── conftest.py              # Mock fixtures — no real API calls in CI
    ├── test_risk_rules.py       # RISK_POLICY rules
    ├── test_scoring.py          # ORACLE JSON schema
    └── test_agents.py           # Integration tests
```

-----

## Files to Migrate from Existing System (DO NOT REBUILD)

|Existing File         |Maps To       |Action                                  |
|----------------------|--------------|----------------------------------------|
|india_scanner.py      |HERMES India  |Migrate as-is                           |
|build_universe.py     |HERMES USA    |Migrate as-is                           |
|market_regime.py      |SHIELD        |Merge with black_swan + vix + fed_policy|
|black_swan.py         |SHIELD        |Merge                                   |
|vix_volatility.py     |SHIELD        |Merge                                   |
|fed_policy.py         |SHIELD        |Merge                                   |
|momentum_indicators.py|ORACLE input  |Migrate as-is                           |
|growth_analysis.py    |ORACLE input  |Migrate as-is                           |
|valuation.py          |ORACLE input  |Migrate as-is                           |
|risk_metrics.py       |SHIELD + SCALE|Split and migrate                       |
|volume_analysis.py    |SONAR         |Migrate as-is                           |
|why_engine.py         |SAGE journal  |Migrate as-is                           |
|sector_performance.py |COMPASS       |Migrate as-is                           |
|scoring.py            |ORACLE utility|Migrate as-is                           |

Files needing upgrade before use:

- multi_factor_scoring.py — fix flat 52.1 scoring bug first
- price_data.py — replace yfinance with Kite + Alpaca WebSocket
- adaptive_learning.py — upgrade from logging to real SAGE learning

-----

## ORACLE Master Prompt (trade_score_v1.txt)

```
SYSTEM: You are the PANTHEON Signal Agent. You think simultaneously like:
Minervini (SEPA) + O'Neil (CANSLIM) + Livermore (patience) + Weinstein (stage)
+ Wyckoff (volume) + Jones (risk-first) + Darvas (boxes) + Druckenmiller (concentration)

BULL vs BEAR DEBATE: Before scoring, run two sub-analyses simultaneously.
Bull analyst: strongest case to BUY. Bear analyst: strongest case to SKIP.
ORACLE synthesises both into the final score.

INPUT: symbol, price, market (US|IN), ohlcv_20days, fundamentals,
       market_regime, gemini_sentiment (0-100), sector_rank, earnings_days_away,
       smart_money_score (FII/DII + 13F + insider)

STEP 1 — WEINSTEIN GATE: Stage 3 or 4 = SKIP immediately.
STEP 2 — TREND TEMPLATE (0-25): 5 MA conditions x 5 pts each.
STEP 3 — PATTERN (0-20): VCP perfect=10, Cup/Flag/Darvas clean=8.
STEP 4 — CANSLIM (0-20): EPS 25%+=8, Rev 20%+=6, Margins+3, Catalyst+3.
STEP 5 — WYCKOFF VOLUME (0-15): VDU+5, Up>Down vol+5, Breakout vol+5.
STEP 6 — JONES R/R (0-15): >=3:1=15, >=2:1=10, <2:1=0 SKIP.
STEP 7 — GEMINI BONUS: Bullish+5, Neutral=0, Negative-10.
STEP 8 — SMART MONEY BONUS: FII+13F confirmed+8, Insider buy+5.
VERDICT: >=70 TRADE, 50-69 WATCHLIST, <50 SKIP.

OUTPUT strict JSON only:
{"symbol":"","verdict":"TRADE|WATCHLIST|SKIP","score":0,"stage":"1|2|3|4",
 "pattern":"VCP|Cup|Flag|Darvas|None","entry":0,"stop":0,"target":0,
 "risk_reward":"X:1","position_size_pct":0,"confidence":"HIGH|MEDIUM|LOW",
 "thesis":"2 sentences bull case","bear_case":"1 sentence key risk",
 "key_risk":"biggest risk","master_alignment":["Minervini","O'Neil","Weinstein"]}
```

-----

## RISK_POLICY (config.py)

```python
RISK_POLICY = {
    "max_risk_per_trade_pct":    0.02,
    "max_position_size_pct":     0.15,
    "min_risk_reward":           2.0,
    "atr_stop_multiplier":       1.5,
    "max_open_positions":        5,
    "max_positions_per_sector":  2,
    "max_portfolio_beta":        1.5,
    "max_gross_exposure_pct":    0.75,
    "max_correlated_cluster":    0.30,
    "daily_loss_limit_pct":      0.05,
    "weekly_loss_limit_pct":     0.10,
    "drawdown_reduce_pct":       0.05,
    "drawdown_paper_pct":        0.10,
    "crypto_max_risk_pct":       0.005,
    "crypto_max_allocation_pct": 0.15,
    "crypto_atr_multiplier":     3.0,
}
```

Never hardcode any of these values. Always read from RISK_POLICY.

-----

## Order States (ARROW)

```
CREATED > VALIDATED > SUBMITTED > PENDING_FILL
> PARTIALLY_FILLED > FILLED > OPEN_WITH_STOP
> STOPPED / CLOSED / CLOSED_MANUAL > JOURNALED
> REJECTED (terminal) / CANCELED (terminal)
```

Every transition written to PostgreSQL audit_log (append-only, no UPDATE/DELETE).

-----

## Stop Order Types Per Broker

|Broker              |Type                     |Note                                            |
|--------------------|-------------------------|------------------------------------------------|
|Zerodha Kite        |GTT (Good Till Triggered)|kite.place_gtt() — submit immediately after fill|
|Alpaca USA          |Bracket Order            |Atomic: entry + stop + target in one submission |
|Binance Crypto      |Stop-Limit               |Limit 0.2% below stop price                     |
|CoinDCX India Crypto|Stop-Market              |Wider stop distance for slippage                |

-----

## Global Switch

```bash
# Validation (default)
ALPACA_URL=https://paper-api.alpaca.markets

# Live — ONLY after Section 26 checklist complete
ALPACA_URL=https://api.alpaca.markets
```

Kiran manual action only. Never automated.

-----

## APIs

|API         |Purpose                      |Env Var                        |
|------------|-----------------------------|-------------------------------|
|Zerodha Kite|India data + execution       |KITE_API_KEY, KITE_API_SECRET  |
|Alpaca      |USA data + execution + crypto|ALPACA_KEY, ALPACA_SECRET      |
|Finnhub     |News + earnings              |FINNHUB_API_KEY                |
|Anthropic   |ORACLE + SAGE                |ANTHROPIC_API_KEY              |
|Gemini      |PULSE sentiment              |GEMINI_API_KEY                 |
|FRED        |Macro model                  |FRED_API_KEY                   |
|Reddit      |Alt data                     |REDDIT_CLIENT_ID, REDDIT_SECRET|
|CoinDCX     |India crypto                 |COINDCX_API_KEY, COINDCX_SECRET|
|Binance     |Global crypto                |BINANCE_API_KEY, BINANCE_SECRET|

SEBI mandate (April 2026): India EC2 Elastic IP must be registered at
developers.kite.trade before any order can be placed.

-----

## AWS Infrastructure

|Resource                        |Region              |Purpose                         |
|--------------------------------|--------------------|--------------------------------|
|EC2 t3.medium (India bot)       |ap-south-1 Mumbai   |2ms to NSE                      |
|EC2 t3.medium (USA bot)         |us-east-1 N.Virginia|5ms to NYSE                     |
|RDS PostgreSQL t3.micro         |us-east-1           |Shared DB                       |
|ElastiCache Redis cache.t3.micro|us-east-1           |Shared state                    |
|Secrets Manager                 |us-east-1           |All API keys                    |
|S3 Bucket                       |us-east-1           |SAGE reports + model checkpoints|

-----

## Redis State Keys

|Key                      |Value                     |Owner                 |
|-------------------------|--------------------------|----------------------|
|REGIME:india / REGIME:usa|BULL/BEAR/SIDEWAYS/UNKNOWN|SHIELD                |
|HALT_ALL                 |bool                      |SHIELD circuit breaker|
|DEPLOYING                |bool                      |FORGE                 |
|DATA_STALE:atlas         |timestamp                 |ATLAS                 |
|ORACLE_WATCHLIST         |JSON signal list          |ORACLE                |
|POSITIONS_OPEN           |JSON position dict        |ARROW                 |
|COMPASS_SECTOR_RANK      |JSON sector ranks         |COMPASS               |
|SMART_MONEY_SCORE        |JSON scores               |SONAR                 |
|SAGE_ACCURACY            |JSON per-agent accuracy   |SAGE                  |
|AGENT_HEALTH             |JSON heartbeat timestamps |All agents            |

-----

## Coding Standards

- Python 3.11+ type hints on ALL parameters and return values
- Docstring on every function: Args + Returns + Raises
- All config values from config.py RISK_POLICY — never hardcode
- All API keys from AWS Secrets Manager or .env — never in code
- All API calls in try/except with specific exception types
- Log: logger.info(“ORACLE: scored NVDA score=87 verdict=TRADE”)
- Limit orders ONLY — never market orders
- Idempotency key format: “{symbol}:{date}:{signal_id}:{direction}”
- Check redis.exists(“ORDER_SUBMITTED:{key}”) before every order submission
- Minimum 80% test coverage per new file before merge to main

-----

## SAGE Governance

|Change                                  |Approval Required                             |
|----------------------------------------|----------------------------------------------|
|ORACLE scoring adjustment (max +/-5 pts)|Auto if SAGE gates pass                       |
|New experimental signal                 |Auto to experimental_signals.txt (30-day test)|
|Promote experimental to main prompt     |Kiran GitHub issue                            |
|Any RISK_POLICY value change            |Kiran GitHub issue                            |
|Stop order logic change                 |Kiran GitHub issue                            |
|EVOLVE RL policy update                 |Kiran + 2-week paper validation               |
|Global switch paper to live             |Kiran manual only — never automated           |

-----

## Failure Recovery Reference

|Failure                  |Recovery                                            |
|-------------------------|----------------------------------------------------|
|ATLAS stale > 30 min     |Retry 3x, Breeze fallback, halt pipeline            |
|ORACLE Claude timeout    |Retry once after 10s, skip stock if fails again     |
|ORACLE invalid JSON      |Retry with explicit JSON instruction, skip if fails |
|ARROW order rejected     |Log + alert Kiran. Never auto-retry.                |
|ARROW partial fill at EOD|Cancel remainder before close. Journal as complete. |
|ARROW stop not confirmed |Resubmit once. If fails: HALT position, alert Kiran.|
|SAGE DB write fails      |Retry 3x, local JSON fallback, sync on reconnect    |
|Redis connection lost    |All agents fall back to PostgreSQL directly         |

-----

## Current Build Status

- Repository: pantheon (private GitHub)
- Stage: Step 1 MVR build
- Day 1 task: Fix flat 52.1 scoring bug in multi_factor_scoring.py
- Endpoint: https://paper-api.alpaca.markets (validation mode)
- Gate to proceed: 60%+ win rate over 30 completed trades