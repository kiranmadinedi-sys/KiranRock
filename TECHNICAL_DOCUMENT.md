# KiranRock — Technical Document

> **Last updated:** 2026-11-22 (full rewrite; the previous version dated from May–June 2026 and is in git history).
> **Sources:** written from the code and database as they stand on this date. Where a number comes from a past study rather than the code, the date of that study is given.
> **Related:** `PANTHEON_INTERNALS.md` (scoring factor tables, Sept 2026), `docs/BEAR_SIDE_30_DAY_ASSESSMENT.md` (bear-side test plan).

---

## Contents

1. [What KiranRock is today](#1-what-kiranrock-is-today)
2. [Accounts and the money rules](#2-accounts-and-the-money-rules)
3. [Architecture](#3-architecture)
4. [A trading day, start to finish](#4-a-trading-day-start-to-finish)
5. [Swing trading — the main strategy](#5-swing-trading--the-main-strategy)
6. [Risk controls and safety nets](#6-risk-controls-and-safety-nets)
7. [Other strategies](#7-other-strategies)
8. [AI models and market data](#8-ai-models-and-market-data)
9. [Research and the learning loop](#9-research-and-the-learning-loop)
10. [Reports, Telegram and the web portal](#10-reports-telegram-and-the-web-portal)
11. [Operations](#11-operations)
12. [Configuration (environment variables)](#12-configuration-environment-variables)
13. [What we have learned so far](#13-what-we-have-learned-so-far)
14. [Known limitations and open items](#14-known-limitations-and-open-items)
15. [Change history since June 2026](#15-change-history-since-june-2026)

---

## 1. What KiranRock is today

KiranRock is a self-hosted platform that trades US stocks automatically through Alpaca. It runs on one Windows PC. It started as a single AI swing-trading bot; it is now a set of separate strategies ("sleeves") with a research system that tests ideas before they are allowed near real money.

| Strategy | What it does | Where it runs | Status |
|---|---|---|---|
| **Swing** | Buys stocks the nightly scan scores highly, holds days to weeks, protected by stops | Live (kmadined, anilboddu1) + paper (`user`) | Main strategy. Must beat SPY on the same capital by 2026-12-19 or its money moves to core |
| **Core holdings** | Long-term positions (index ETFs + a few quality names) so idle cash earns the market return | Live (kmadined) + paper | Running |
| **Satellite (momentum)** | 10 strongest 12-1 month momentum stocks, monthly, 10% of the account | Paper only | Test |
| **Options income** | Sells cash-secured puts on quality $15–100 stocks | Paper only (kmadined has Level 3 approval, not trading options yet) | Test |
| **Bear side** | When the bot's regime is BEAR: SH/PSQ hedge, short sales, SPY/QQQ bear put spreads | Paper only | Frozen, 30-day assessment from 2026-11-24 |
| **Crypto** | 15 coin pairs, 24/7, own process | Paper only | Running, losing (see §7.6) |
| **Blitz (intraday)** | Fixed liquid list, momentum entries, flat by close | Paper only (opt-in) | Opt-in |
| **Extended hours** | Pre/after-market entries | Off for every account since 2026-10-17 | Disabled |
| **Reversal-put log** | Records what puts on mega-caps would have done after an up-open-then-sell-off on weak market days | No orders at all | Shadow log |

**Two rules shape everything:**

1. **Paper first, live by approval.** The platform may change paper accounts by itself. Anything that changes how a live account trades waits for the owner's explicit approval (§2.2).
2. **Broker numbers are the truth.** Twice the bot's own records drifted from the broker (swing 11-16, crypto 11-22). Decisions use broker fills; the weekly broker scoreboard (§10.1) reconciles each account to its real equity.

---

## 2. Accounts and the money rules

### 2.1 Accounts with automatic trading on

| Account | Type | Min buy score | Max positions | Sizing | Exit profile | Notes |
|---|---|---|---|---|---|---|
| **kmadined** | LIVE | 85 | 10 (6 equal slots) | equal, 6 slots | standard | `news_momentum` setups blocked. Scan rotation on. Daily loss limit −$300 |
| **anilboddu1** | LIVE | 65 | 1 | conviction | standard | Owner decides everything here — the platform states facts only, no recommendations. Daily loss limit −$1,000 |
| **user** | PAPER | 75 | 6 | equal | wide | Test bed for every new strategy. Excluded from live accounts' learning data |

Values come from `risk_configs` and `strategy_settings` (2026-11-22). Parvataneni and the other registered users have automatic trading off.

### 2.2 Approvals for live changes

`approvalService` stores a request (one per user + kind + key while pending), announces it on Telegram, shows a popup on the website until decided, and repeats it every trading morning. Approving runs the change; rejecting closes it. Requests expire after 14 days. Approval kinds include `sizing_method`, `blocked_setups`, `scan_rotation`.

- Always confirm the `approval_requests` row, not a chat message: a popup only appears when logged in as that account.
- `promotionService` (Saturdays 11:30 ET) judges logged test methods against control on the same days. A pass is promoted to paper automatically. Live promotion still needs approval.

---

## 3. Architecture

### 3.1 Processes

All processes run on one Windows 11 PC (31 GB RAM). PM2 manages three of them; `start.ps1` starts everything.

| Process | Entry | Role |
|---|---|---|
| `kiranrock-backend` | `backend/src/app.js` (port 3001, 512 MB heap) | Express REST API for the portal |
| `kiranrock-worker` | `backend/src/worker.js` (512 MB heap) | Every scheduler and trading bot. Takes a **leadership lock** at start; a second copy exits on its own |
| `kiranrock-crypto` | `backend/src/cryptoWorker.js` (256 MB heap) | 24/7 crypto bot, isolated from the equity schedulers |
| Frontend | `frontend/` Next.js (port 3000) | Web portal, published at getmytbot.com via a Cloudflare tunnel |

**Supporting software on the same PC:**
- **PostgreSQL:** database `kiranrock_trading`, 125 tables, about 2.2 GB.
- **Ollama:** the local AI models, listening on 127.0.0.1 only since 2026-11-02.
- **cloudflared:** the tunnel that publishes the portal.
- **Kronos:** a research model that runs in WSL.

### 3.2 Diagram

```
                ┌──────────────────────────────┐        ┌──────────────────────┐
  Browser ─────▶│ Frontend (Next.js, :3000)    │──JWT──▶│ Backend API (:3001)  │
  getmytbot.com │ via Cloudflare tunnel         │        │ Express, 44 routers  │
                └──────────────────────────────┘        └─────────┬────────────┘
                                                                  │
  Telegram ◀── alerts / reports ──┐                               ▼
                                  │                  ┌──────────────────────────┐
┌─────────────────────────────────┴──────────────┐   │ PostgreSQL               │
│ Worker (leader-elected, all schedulers)        │◀─▶│ kiranrock_trading        │
│  • Swing bot (5-min cycle)  • Nightly scan     │   │ 125 tables, ~2.2 GB      │
│  • Core / Satellite / Options income / Bear    │   │ nightly pg_dump →        │
│  • Reconciliation, stop checks, health         │   │ PC + OneDrive            │
│  • Research: lab, studies, shadow logs         │   └──────────────────────────┘
│  • Reports (Telegram + /reports archive)       │
└───────┬───────────────────┬────────────────────┘   ┌──────────────────────────┐
        │                   │                        │ Crypto worker (24/7)     │
        ▼                   ▼                        └───────────┬──────────────┘
 ┌─────────────┐   ┌──────────────────────┐                      │
 │ Ollama      │   │ Alpaca (broker+data) │◀─────────────────────┘
 │ qwen 27B/7B │   │ Polygon · Finnhub    │
 │ 127.0.0.1   │   │ Gemini · FRED · Yahoo│
 └─────────────┘   └──────────────────────┘
```

### 3.3 Worker start-up

In order:

1. Acquire leadership.
2. Start the enhanced AI scheduler (the 5-minute tick that drives most jobs).
3. Start the IST pipeline, the options scanner, and the options bot.
4. Start the news monitor and news rescan.
5. Start the stock-signal snapshots and the asset-universe refresh.
6. Start EOD ingestion and the Telegram link listener.
7. Start the market monitor and the intraday (Blitz) scheduler.
8. Start the system health monitor and the resource monitor.
9. Start the missed-opportunity, shadow-trade, and forward-tracking schedulers.
10. Load the Telegram report schedules.

### 3.4 Shared infrastructure

- **One Alpaca rate limiter** across all schedulers (`dataProvider`), plus a 60-second quote cache.
- **Circuit breakers** on Yahoo and Gemini, so one failing caller can't starve the others.
- **Shared market calendar** (`utils/marketCalendar.js`): holidays and 1:00 PM early-close days (`NYSE_EARLY_CLOSES`, added 2026-11-22; update both lists each January). This is the only "is the market open" implementation for trading. On early-close days the near-close windows shift with the close: swing, bear and options-income entries stop at 12:30 PM, Blitz entries stop at 12:45 PM, and Blitz flattens from 12:50 PM. A few scan and monitoring helpers still use their own 9:30–4:00 check; they place no orders.
- **Report archive** (`report_archive`). Every Telegram message is stored, so the portal's /reports page shows everything Telegram shows.

---

## 4. A trading day, start to finish

Times are US Eastern. The PC itself runs on Central time.

| Time (ET) | Job |
|---|---|
| 16:15 (prev. day) | **Nightly scan** starts. Scores the whole universe (about 2,750 stocks) into `daily_universe_analysis` using the large local model. Finishes around 02:00–03:00 |
| 18:30 (prev. day) | EOD bar ingestion (Polygon grouped daily bars, split detection) |
| 07:00 | Nightly database backup. Waits up to 2 hours if a scan is still running |
| 07:00 | Daily AI briefing on Telegram (Mon–Fri). The weekly buy list goes out Sunday 08:00 |
| 08:00 | STRONG BUY pre-market alert, and the daily score-edge check |
| 08:30 | Pre-market gap check on last night's setups |
| 09:00 | Morning reconciliation: database positions vs Alpaca |
| 09:25 | Portfolio digest on Telegram |
| 09:30–16:00 | **Main cycle every 5 minutes**, per account: manage open positions, then look for entries (§5) |
| 09:31 | Stop verification: every position must have an active stop |
| 15:44 | Cancel leftover partial-fill orders |
| 16:15 | Daily bot summary (Telegram) and the next nightly scan |
| 16:25 | Market review capture and forward-return backfill |
| 17:00 | Insider sweep (last 10 days). Missed-opportunity monitor |
| 18:30 | Daily mistake review. 19:00 news labelling. 19:30 lab tips |

**Weekly jobs:**

| Day | Time (ET) | Job |
|---|---|---|
| Friday | 15:45 | Parameter health check plus a 30-day backtest snapshot |
| Friday | 16:10 | $/day scoreboard |
| Friday | 16:20 | Accountability: app costs vs live gains |
| Saturday | 08:00 | Weekend prep report |
| Saturday | 10:00 | Score-component validation |
| Saturday | 11:00 | Market study plus one strategy-review item (rotating) |
| Saturday | 11:30 | Promotion check |
| Saturday | 12:00 | Research agent and insider sweep |
| Saturday | 13:00 | Research Lab |
| Saturday | 13:30 | Portfolio Lab |
| Saturday | 14:00 | Broker scoreboard |
| Sunday | 08:00 | AI weekly buy list |
| Sunday | 09:00 | Weekly performance recap |
| Sunday | 20:00 | Global market scout |

The crypto bot runs every 5 minutes, 24/7.

---

## 5. Swing trading — the main strategy

Code: `enhancedAITradingBot.js` (`scanMarketForOpportunities`, `executeAutonomousTrading`, `manageExistingPositions`), `precomputedUniverseService.js`, `brokerService.js`.

### 5.1 Universe and nightly scoring

- **Universe:** HERMES (`marketScreenerService`) plus the nightly Alpaca asset sync. Quality floors are set in `.env`: market cap ≥ $2B and average volume ≥ 250k for the screener pool. The nightly scan covers about 2,750 symbols.
- **Nightly score:** `analyzeStockWithAI` runs about 25 factors (trend template, momentum, volume, RSI/StochRSI/Williams, MACD/Bollinger, relative strength, 52-week high, earnings window, VIX, PULSE news sentiment and risk flags, chart patterns, Wyckoff, CANSLIM, sector rotation, smart money, short squeeze, learned adjustments, regime/weekly alignment, ATLAS). ORACLE gives the final verdict. Factor weights are listed in `PANTHEON_INTERNALS.md` §4.
- **Changes since September:**
  - PROPHET is off in the scan (no skill found, 2026-11-10).
  - Volume is paced against a normal day at the same hour (2026-11-09).
  - ADX(14) is used for trend strength.
  - Every skip now records a reason in `exclusion_reason`.
- **Result:** one row per symbol per night: score, recommendation, pattern, prescreen pass/fail.

### 5.2 Choosing candidates in the live cycle

1. Load last night's scored list (fast path).
2. Keep at most **40 candidates** for the live re-check. Ties at the same score are broken by `md5(symbol‖date)`: fair, stable within a day, rotating across days.
3. **Jump guard:** drop stocks that rose more than 5% on scan day (`MAX_SCAN_DAY_JUMP_PCT`). Buying after a jump lagged in 4 of 4 months tested.
4. **Scan rotation** (per account, `strategy_settings.scan_rotation`): rotate through the list so every candidate gets checked during the day. The top N always stay in the list (`scan_rotation_keep_top`).
5. **Live re-score** with the fast local model. Limits: at most `ORACLE_MAX_PER_CYCLE` (8) ORACLE calls per cycle, a 90-second ORACLE cutoff, and a 120-second whole-scan cutoff. Each cutoff runs from the start of the cycle.
6. Drop anything below the account's minimum buy score.

### 5.3 Gates

A candidate must pass every gate. Each rejection is written to `trade_rejection_log` with a reason code. Rejected candidates scoring 85 or more are tracked forward as shadow trades (§9).

**Cycle-level gates.** These stop or limit all new entries for the cycle:

| Gate | Rule |
|---|---|
| Calendar | FOMC, CPI/NFP, OPEX and post-holiday windows; no new entries 9:30–10:00 and late in the day |
| SPY gate | No new longs when SPY is below its 20-day average |
| Edge gate | At least one STRONG BUY must exist; plain BUY signals alone don't open positions |
| Regime cap | New positions per cycle: BEAR 1, NEUTRAL/CHOPPY 2, BULL by breadth |
| Volume gate | In CHOPPY/NEUTRAL/BEAR, an entry needs ≥ 1.5× normal volume for the hour |
| Heat budget | Total dollars at risk to all stops is capped. A trade is shrunk to fit, and blocked once the budget is used |
| Loss limits / drawdown | See §6 |

**Per-candidate gates:**

| Reason code | Rule |
|---|---|
| `bleeding_symbol` | The symbol has lost repeatedly for this account recently |
| `earnings_guard`, `earnings_setup_low_score` | Earnings too close (Finnhub calendar) |
| `existing_broker_position`, `open_order_pending`, `duplicate_inflight`, `dup_symbol_session` | Never double-buy |
| `stop_cooldown` | Recently stopped out. Re-entry is allowed after 2 or more days, once price has traded 5% above the stop price |
| `risk_reward` | Reward/risk below 2.5 |
| `gap_gate`, `gap_elevated_low_score`, `gap_moderate_low_score`, `gap_abnormal` | Don't chase overnight gaps |
| `extension_guard` | Price more than 10% above its 20-day average |
| `sector_count_cap`, `sector_dollar_cap`, `industry_cap`, `unknown_sector` | Concentration limits. Sector count is effectively 1 per sector; the industry cap (2) has never bound in practice |
| `correlation` | Too correlated (60-day returns) with current holdings |
| `regime_setup_mismatch`, `setup_blocked` | Setup not allowed in this regime, or blocked for this account (kmadined: `news_momentum`) |
| `rs_filter_below_mas`, `volume_gate`, `min_notional`, `rate_limit` | Misc. Some accounts have a $100 minimum order |

### 5.4 Sizing

- **Equal** (kmadined, `user`): sleeve ÷ slots, adjusted by regime, losing streak, slippage, VIX and the macro dampener. Risk caps use the whole account.
- **Conviction** (anilboddu1): Kelly fraction from the account's own win and loss history × confidence × multipliers, floored and capped by `risk_configs`.
- **Always:** the heat budget, `max_position_size`, a cross-cycle position-slot reservation (two cycles can't both fill the last slot), and a cash guard against over-deployment (added after the 2026-06-16 over-deployment).

### 5.5 Orders

- Limit orders only. Standard entries are **bracket orders** (stop and target attached).
  - A bracket's stop leg shows status `held` and does **not** appear in `/v2/orders?status=open`. Check with `status=all&nested=true`.
- Fractional sizes get two separate GTC orders.
- **Partial fills** record the real filled quantity, not the requested one (fixed 2026-09-17/18).
- **Duplicate prevention:** `UNIQUE(user_id, broker_order_id)` on trades, plus idempotency keys in `order_audit_log`.

### 5.6 Managing open positions (every cycle)

- **StopRepair:** every holding must have a live protective stop. A missing one is restored, and an alert is sent.
- **Trailing stop, standard profile.** It tightens as the gain grows:

| Gain | Trail |
|---|---|
| under 2% | 5.5% |
| 2% or more | 5.0%, and the stop floor moves to the entry price |
| 5% or more | 4.0% |
| 10% or more | 3.0% |
| 15% or more | 2.5% |
| 20% or more | 2.0% |

  The trail is never tighter than 1.5 × ATR.
- **Trailing stop, wide profile (paper):** a flat 7% trail with no break-even floor, also never tighter than 1.5 × ATR. In the 3-year replay this held the most per day.
- **Other exits:**
  - partial profit-taking;
  - time exits (slow mover, maximum hold, pre-earnings);
  - tightening on a regime downgrade;
  - distress mode, which cuts losers early on a bad day.
- **Regime shift:** a downgrade cancels only pending **entry** buys, never protective stop orders. This matters for the bear side's buy-stops.

---

## 6. Risk controls and safety nets

| Control | What it does |
|---|---|
| **Daily / weekly loss limits** | Count stop fills too. If the data is missing they fail closed, i.e. new buys stop. Exits keep running during a halt. Per-account `daily_loss_limit` plus `.env` limits |
| **Max drawdown halt** | Blocks live buys past the drawdown limit. A bad equity read can no longer become the "peak" (fixed 2026-10-29) |
| **Loss-streak breaker** | 3 losses in a row halve the position size; 5 stop new buys |
| **SENTINEL** | Scans 30 days for duplicate orders, order storms, stop failures, reconciliation errors and stuck orders, and blocks live trading if any trip. Check the audit trail before trusting a "blocked" |
| **Kill switches** | Global (`global_trading_control`), per account (`emergency_stop_enabled`), and the bear side's latching halt (§7.4) |
| **Reconciliation** | Database vs broker on every restart, at 9:00, and on a schedule. Finds phantom (DB only), drift (quantity mismatch) and shadow (broker only) positions; shadows also backfill the missing trade row. Fill-history reconciliation only detects and alerts |
| **Stop verification** | 9:31 every trading day, plus every cycle via StopRepair |
| **Preflight** | `start.ps1` runs `scripts/preflight.js`. If it fails, the running app is **not** stopped |
| **Market calendar** | Holidays and half days from a single shared module |
| **Privacy** | User-facing Telegram summaries contain only that user's trades (fixed after a leak). Passwords are no longer logged (2026-11-04) |

---

## 7. Other strategies

### 7.1 Core holdings (`coreHoldingsService`)

- **Purpose:** long-term positions that put otherwise idle cash to work, held for months and separate from the swing bot. The swing bot can't see or sell them.
- **Holdings:**
  - kmadined: 8 core symbols.
  - Paper: SPY, V, SGOV, AMD, META, NVDA.
- **Schedule:** a daily rebalance tick.
- **Alerts and reports:**
  - single-stock drawdown alerts;
  - breakdown alerts;
  - a weekly "Core vs SPY" comparison;
  - a core watchlist and guidance (Gemini-assisted).

### 7.2 Satellite — momentum (`satelliteService`, paper)

- **Rule:** each month, take the 300 most-traded non-fund stocks ($20 or more, with a full year of history). Hold the 10 with the best 12-month return, skipping the latest month. Equal weight, `SATELLITE_PCT` = 10% of the account.
- **Why it's only a test:** the backtest's edge came from a few "rocket" stocks. Without each month's single best stock, it roughly matched SPY.

### 7.3 Options income (`optionsIncomeService`, paper)

- **Strategy:** sell cash-secured puts on quality $15–100 stocks, using Alpaca's free indicative quotes and delta.
- **Sizing:** total collateral is capped by `OPTIONS_INCOME_MAX_COLLATERAL` ($30k). Assigned shares sit in the `options` sleeve (the wheel). It runs every scheduler tick.
- **History:** position management never ran until a date-parse bug was fixed on 2026-10-26 (909826b).
- **Roadmap:** CSP fixes, then 20 trades, then bull put spreads (defined risk).
- **Current risk:** in the November selloff, 5 open short puts are down about $600. This is why the next step is defined-risk spreads.
- **Data limits:** Alpaca's historical option bars start in February 2024, with no historical bid/ask or Greeks. The OPRA feed isn't signed, so historical bars return 403.

### 7.4 Bear side (`bearSideService`, paper, frozen)

Paper only, with margin allowed (`BEAR_ALLOW_MARGIN`). It activates only for `BEAR_SIDE_USER_IDS`.

- **Regime gate:**
  - New entries need the bot's own regime to be BEAR, confirmed over 2 sessions.
  - Entries are allowed 10:30–15:30 ET, once per day per leg.
  - PANIC means hold only.
  - Any BULL reading (`/^BULL/`) closes the book. 24 hours without BEAR also exits.
  - A stale regime reading (missing SPY price, missing timestamp, or older than 30 minutes) means hold, with no entries.
- **Legs:**
  - **Hedge:** SH + PSQ, 10% of the account.
  - **Shorts:** up to 5, 2% each, easy-to-borrow only. Entry checks:
    - RSI 30 or more;
    - at least 10 points weaker than SPY;
    - over $50M traded per day;
    - not up 8% or more today, and not up 4% or more on entry day;
    - no short-sale restriction;
    - at most 2 per sector;
    - no special dividend or one over 1% due during the hold.
  - **Short exits:** a GTC buy-stop at +8%, take-profit at −15%, maximum 21 days. If the stop can't be placed, the position is covered immediately.
  - **Bear put spreads:** SPY/QQQ, at-the-money / −5%, 30–50 days to expiry, debit no more than 45% of width. They close short leg first.
- **Budgets:**
  - stop-based risk: 1% per position and 5% in total;
  - gap stress (shorts +30%, market +5%): no more than 6% (`BEAR_MAX_GAP_RISK_PCT`);
  - gross cap: 25%.
- **Kill switch:** a latching halt of *new entries* on any position mismatch, unknown broker short, missing stop, or risk over cap. It never liquidates.
  - **Resume:** `POST /api/paper-tests/bear/resume`. It re-reconciles first, refuses (409) on any problem, and logs every attempt in `bear_resume_log`.
  - **Current state:** a TEST HALT was set on 2026-11-21 to prove it survives a restart. It is to be cleared by the Monday 11-23 validation.
- **Monitoring:** hourly borrow re-checks, a daily dividend re-check, squeeze alerts (the stop is never widened), and a confirm-flat check after liquidation.
- **Reporting:** P&L is reported as gross, adjusted, and economic (borrow assumed at 0.5% and 3%; borrow fees shown as "UNAVAILABLE", not zero). Dividends owed on shorts are deducted.
- **Freeze:** no rule changes from c6e9926 until the assessment ends. Day 1 is 2026-11-24, Day 10 is 12-08, Day 25 is 12-30, Day 30 is 2027-01-07. The plan and formulas are in `docs/BEAR_SIDE_30_DAY_ASSESSMENT.md`, and the doc wins over the report.

### 7.5 Reversal-put shadow log (`reversalPutShadowService`, no orders)

- **Signal**, on 25 mega-caps:
  - SPY at −0.5% or worse on the day;
  - the stock opened +0.5% or higher, or traded +1.5% or higher, vs the prior close;
  - it is now at least 3% below its high and below the prior close.
- **What it records:**
  - 4 puts per signal: near-term (5 or more days to expiry) and monthly (21–45 days), each at-the-money and about 5% out of the money;
  - grades at the close, day 1 and day 3, priced ask→bid (realistic) and mid→mid.
- **How it's judged:** by day, not by signal, since one market day can fire 15 of the 25 names. Days with 5 or more signals count as "broad", fewer as "isolated".
- **Where results appear:** the weekly review item `reversal_puts`.
- **Code safety:** the code contains no order calls, and a test enforces that.

### 7.6 Crypto (`cryptoTradingBot`, own process, paper)

- **Rules:**
  - 15 pairs; 5-minute cycle, 24/7.
  - A broker-side stop sits on every position. A software backstop is confirmed against a fresh live trade before exiting (bad-tick protection).
  - Take-profit; a stop-loss cooldown.
  - Daily trade and loss limits; a per-account allocation.
- **Records fix (2026-11-22, 222cdf5):** when the broker's stop had already sold, the "position already closed" path could borrow an older trade's sell price, and fees (0.25% each way) were ignored. Both are fixed, and all past rows were recomputed from broker orders, with the old values kept in `metadata.original`.
- **Results (broker truth):** −$392 since 2026-08-30, of which $177 is fees. November: 0 winning trades out of 23. Not ready for live.

### 7.7 Blitz and extended hours

- **Blitz** (`intradayTradingBot`): a small fixed list of liquid symbols, a momentum/volume score, a resting broker stop, and a software take-profit. It flattens before the close. Opt-in.
- **Extended hours** (`extendedHoursTradingService`): an opt-in parallel path with a regime guard. Turned off for paper on 2026-10-17 after 146 trades with 30% winners (−$905).

---

## 8. AI models and market data

### 8.1 AI

| Use | Model | Notes |
|---|---|---|
| ORACLE, nightly scan | Local `qwen3.8:27b` (Ollama) | CPU-only. Context capped at 16K. The model is RAM-heavy (it can hold about 20 of 31 GB) |
| ORACLE, live cycles | Local `qwen2.5:7b-instruct` (`OLLAMA_MODEL_LIVE`) | About 4× faster. Live calls jump ahead of the batch scan in a priority queue |
| ORACLE shadow | Gemini Flash-Lite | Answers the same live checks and is logged side by side (`oracle_shadow`). Trading still uses the local verdict; switching needs an approval |
| PULSE (news sentiment + fraud/legal flags) | Gemini, local fallback | Law-firm ad headlines filtered (2026-11-04) |
| Research agent, news labelling, mistake review, core guidance | Gemini (`GEMINI_MODEL` = gemini-3.5-flash-lite) | Budget-capped (news labelling ≤ $1/day) |
| Daily/weekly briefings | Local model | |

- **Anthropic:** the Claude path in `oracleService` is only a fallback if Ollama is disabled. Ollama is primary whenever it is running.
- **PROPHET** (earnings direction) showed no skill and is off in the scan.

### 8.2 Market and reference data

| Source | Used for |
|---|---|
| **Alpaca** | Broker; quotes, bars (IEX feed); option chains (indicative); corporate actions (dividends); account activities |
| **Polygon** | EOD grouped bars, ETF typing, SONAR fallback |
| **Finnhub** | Fundamentals and market cap (CANSLIM, short interest), earnings calendar, insider transactions, news |
| **Yahoo** | Fallback only. Heavily rate-limited (HTTP 429) and behind a circuit breaker |
| **FRED** | Macro data. VIX fallback (lags by a day) |
| **ATLAS proxies** | Global and regime inputs from Alpaca ETFs (Yahoo removed, 2026-11-05) |
| **NewsAPI, Alpha Vantage, Reddit, X** | News and alternative data (optional) |

**Data warehouse tables:**
- `history_bars`: 3 years of daily bars, ~4,400 symbols, 3.3M rows. Used by every backtest.
- `daily_bars`: EOD warehouse.
- `daily_universe_analysis`: nightly scores since 2026-05-28.
- Research archive: all-ticker news (about 1M rows) and insider filings.

---

## 9. Research and the learning loop

The aim is to keep what works and cut what doesn't, with every test judged by fixed rules set before the result is seen. Nothing here trades. Results reach paper through promotion, and live only through approval.

| System | What it answers | When |
|---|---|---|
| **Prediction check** (`predictionCheckService`) | Does the nightly score still predict 5-day returns? Measures rank correlation (ic), score-80+ group vs that night's average (spread80), and top 20 vs average. Alerts if 10 nights in a row turn negative | Weekdays 08:00 |
| **Score validation** | Which scoring components predicted returns recently | Sat 10:00 |
| **Market study** (`weeklyMarketStudyService`) | Exits and picking methods tested on *every* candidate scoring 80+, not just the ones bought | Sat 11:00 |
| **Strategy review** (`weeklyStrategyReviewService`) | One rotating question per week: core, selection, size, options, satellite, bear, reversal_puts, exit, crypto, swing_vs_spy… | Sat 11:00 (in the market study message) |
| **Research agent** | Gemini proposes new ideas from the week plus the lab's full memory. It only proposes | Sat 12:00 |
| **Research Lab** (`researchLabService`) | Tests queued ideas on `history_bars` with costs, a split into two halves, and a false-discovery correction. Every result is kept for good | Sat 13:00 |
| **Portfolio Lab** | Tests *how* to trade the nightly picks: slots, minimum score, sector cap, stop/trail/target, hold time, reserve | Sat 13:30 |
| **Promotion** | Test methods vs control on the same days, then automatic promotion to paper | Sat 11:30 |
| **Selection experiment** | Logs each test method's picks next to control every day | Daily |
| **Shadow trades** | Rejected candidates scoring 85+ tracked forward: best and worst move, 5/10/20-day returns, regime at rejection | Daily, Friday summary |
| **Missed opportunities** | STRONG BUY for days, moved 8%+, never bought anywhere | Daily 17:00 ET |
| **Mistake review** | Labels each day's losses and missed winners; repeated patterns feed the agent | Weekdays 18:30 |
| **Learning layers** | SAGE (score adjustments with a 30-day probation), LocalBrain (win rate by sector × pattern × regime), EVOLVE (price-bucket model). Per account; paper excluded from live | Nightly |

---

## 10. Reports, Telegram and the web portal

### 10.1 Key reports

All of these go to Telegram and are also kept on **/reports**:
- **Broker scoreboard** (Sat 14:00 ET, `brokerScoreboardService`):
  - realized P&L per strategy (swing, core, satellite, options, bear, crypto) over 7 days, 30 days, and all time, plus open P&L;
  - built from broker fills, fees and dividends only;
  - checked against real equity (paper within $4, kmadined to the dollar, on 2026-11-22).
- **Saturday market study and strategy review**, **Research Lab**, **Portfolio Lab**, **Promotion check**.
- **Accountability** (Fri): what the app cost to run (Gemini, data) vs what the live accounts gained.
- **Weekly performance recap** (Sun), **weekend prep** (Sat), **daily summary** (16:15 weekdays), **pre-market alerts**.
- **Macro briefing**: a cloud routine posts it to a protected backend endpoint (`MACRO_BRIEFING_INGEST_SECRET`). It feeds a position-size dampener.

### 10.2 Portal pages (`frontend/app`)

| Area | Pages |
|---|---|
| Trading | dashboard, portfolio, performance, ai-trading, swing-trading, intraday, scalping, crypto-trading, core-holdings, options-bot, options-chain |
| Research and markets | signals, recommendations, weekly, universe, most-active, news, backtest, scenarios, analytics |
| Oversight | **reports**, **lab** (admin), **paper-tests** (bear side, experiments), **live-readiness**, alerts |
| Account | profile, login, admin, enquiry |

### 10.3 API

44 routers under `/api/*` (`backend/src/app.js`). The main groups are auth/profile, trading/ai-trading, portfolio/performance, signals/recommendations/weekly, options/options-bot, crypto-trading, core-holdings, approvals, paper-tests, reports, lab, and system.

Health: `GET /health`, `/api/system/health-dashboard`, `/api/system/live-readiness`.

---

## 11. Operations

### 11.1 Start and restart

- **Always** run `start.ps1` as Administrator. It elevates itself, runs preflight, stops old processes in three passes, starts PM2 processes plus the frontend, and runs a startup signal pass.
- **Never run `pm2` from a non-admin shell.** That spawns a stray PM2 daemon (EPERM issues).
- **A restart during the nightly scan loses the rest of the scan.** Restart after it finishes (around 02:00–03:00 ET).
- After a restart:
  - confirm only one worker holds leadership;
  - confirm `/health` is OK;
  - confirm the Telegram "System Restarted" message arrived.

### 11.2 Machine

| Item | Detail |
|---|---|
| Power | Sleep set to Never on AC power (an outage happened when the PC slept on 2026-09-14). Use Ethernet; WiFi dropped before |
| Windows Update | Active hours 9 AM–3 AM. Planned restarts at 5 AM |
| Boot | A scheduled task auto-starts the app. cloudflared is delayed-auto with a restart policy. **Ollama and Kronos need a user sign-in** after a reboot. Check the 16K context setting |
| Resources | `systemResourceService`: RAM, CPU, disk, event-loop lag and DB round-trip every minute; history in `system_resource_samples`; admin alerts on persistent breaches. DB timeouts have tracked RAM pressure from the LLM |
| Backups | `pg_dump` every day at 07:00 ET, verified with `pg_restore --list`. 7 daily + 4 weekly copies on the PC; 4 + 4 in OneDrive (KiranRock-Backups). Telegram on failure |

### 11.3 Tests

- `cd backend; npx jest`: 747 tests in 114 suites on 2026-11-22. Run from `backend/`; running from the repo root picks up unrelated suites.
- Jest doesn't load the worker entry point, so after edits also run `node --check src/worker.js`.

---

## 12. Configuration (environment variables)

These are names only; the values live in `backend/.env` and are never committed.

| Group | Variables |
|---|---|
| Server | `PORT`, `HOST`, `NODE_ENV`, `CORS_ORIGINS`, `FRONTEND_BASE_URL`, `JWT_SECRET` |
| Database | `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` |
| Broker and data | `BROKER` (alpaca), `DATA_PROVIDER` (alpaca), `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY`, `ALPACA_PAPER`, `ALPACA_BASE_URL` (shared fallback; accounts normally use their own stored keys), `POLYGON_API_KEY`, `FINNHUB_KEY`/`FINNHUB_API_KEY`, `ALPHA_VANTAGE_KEY`, `NEWSAPI_KEY`, `FRED_API_KEY`, `X_*`, `REDDIT_*`, `HUGGINGFACE_API_KEY` |
| AI | `OLLAMA_BASE_URL`, `OLLAMA_MODEL` (batch), `OLLAMA_MODEL_LIVE`, `OLLAMA_TIMEOUT_MS`, `ORACLE_MAX_PER_CYCLE`, `LIVE_ORACLE_CUTOFF_MS`, `LIVE_SCAN_CUTOFF_MS`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `ANTHROPIC_API_KEY`/`CLAUDE_MODEL` (fallback only) |
| Universe | `HERMES_MIN_MARKET_CAP`, `HERMES_MIN_AVG_VOLUME`, `HERMES_MAX_STOCKS`, `COMPASS_LOOKBACK_DAYS`, `COMPASS_CACHE_TTL_MS` |
| Risk | `BOT_ENABLED`, `MAX_BOT_INVESTMENT_USD`, `DAILY_LOSS_LIMIT_USD`, `WEEKLY_LOSS_LIMIT_USD`, `MIN_SHARPE_FOR_LIVE`, `ACTIVATION_GATES_ENFORCE` (false) |
| Strategy opt-ins (account lists) | `SELECTION_EXPERIMENT_USER_IDS`, `OPTIONS_INCOME_USER_IDS`, `OPTIONS_INCOME_MAX_COLLATERAL`, `SATELLITE_USER_IDS`, `SATELLITE_PCT`, `SCAN_ROTATION_USER_IDS`, `BEAR_SIDE_USER_IDS`, `BEAR_ALLOW_MARGIN`, optional `BEAR_MAX_GAP_RISK_PCT`, `REVERSAL_SHADOW_USER_ID`, `BROKER_SCOREBOARD_USER_IDS`, `CRYPTO_FEE_RATE` |
| Notifications | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (admin), `EMAIL_*`, `TWILIO_*`, `NOTIFY_WHATSAPP` |
| Internal | `BOT_USERNAME`/`BOT_PASSWORD` (report jobs call the API), `MACRO_BRIEFING_INGEST_SECRET` |

---

## 13. What we have learned so far

These findings come from our own data and drive current decisions. Each has a date and can be re-run.

| Finding | Evidence |
|---|---|
| **The edge is the 80+ score group, not the ranking** | Rank within 80+ predicted nothing (10-17, 59 days). A learned ranker lost in 5 of 5 setups. Group vs night average: Sep +0.51%, Oct +0.49%, Nov +1.59% (5-day); the top 20 adds nothing (11-22) |
| **Dollars lag per-trade returns** | kmadined: +1.01% per trade equal-weighted, but only +0.27% dollar-weighted; bigger positions did worse (10-31). Hence equal sizing |
| **Idle cash was the biggest drag** | 26% capital use (08-15). Hence core holdings |
| **No timing edge in dip buying or valuation filters** | Quality-dip study (10-26); P/S, P/B and margin filters (11-12) |
| **Trailing stops beat fixed targets** | Market study and the 3-year replay (10-17 onward) |
| **news_momentum entries lose** | Negative in every review since October; blocked on kmadined |
| **Clustering hasn't cost us** | Correlation study (11-21): average pairwise correlation 0.13; worst days were market-wide |
| **Crypto has no edge right now** | −$392 broker P&L; 0 winning trades out of 23 in November (11-22) |
| **Component edges flip month to month** | Don't switch components on one week's validation result |

---

## 14. Known limitations and open items

- **VIX data:** CBOE returns 403 and Yahoo returns 429, so the FRED fallback is a day behind.
- **Swing vs SPY:** decision on 2026-12-19. If swing hasn't beaten SPY on the same capital, its money moves to core.
- **Bear-side assessment:** Day 1 is 2026-11-24. The TEST HALT is cleared only after Monday's validation.
- **Naked short puts on paper** lose in selloffs. Bull put spreads are the next step.
- **Weekly AI buy list:** the timeout was raised from 5 to 15 minutes on 2026-11-22 after two failures.
- **Records vs broker:** use the broker scoreboard. The bot's own tables have drifted before.
- **Single machine:** everything (trading, local AI, database) shares one PC's RAM. Restarts during the scan, reboots, and network drops are the main operational risks.
- **Old documents:** `PLATFORM_GUIDE.md`, `KiranRock_Trading_System_Documentation.md`, `FUNCTIONAL_OVERVIEW.md` and the other root-level guides are from June and out of date. This document and `PANTHEON_INTERNALS.md` are current.

---

## 15. Change history since June 2026

| When | Change |
|---|---|
| Jun–Jul | Live pilot; over-deployment guard (06-16); stop-protection incident fixed (07-21); seven profit-drain bugs fixed (07-04) |
| Aug | Profitability push (min score 88→75 on kmadined, later 85); Blitz duplicate-sell race fixed; crypto process added (08-28) |
| Sep | Market calendar unified; shadow trades; candidate tie-break; per-account learning; fill and partial-fill fixes; duplicate-trade unique index |
| Oct | Approvals and promotion; core holdings; satellite; options income; 3-year history; market study; jump guard; equal sizing; scan rotation; database backup; drawdown false-halt fix; cycle-relative live scan budget |
| Nov 1–12 | ORACLE shadow; research lab and agent; portfolio lab; prediction check; resource monitor; loss-limit safeguards; VolumeGate pacing; PROPHET off in scan; Ollama locked to localhost; CANSLIM via Finnhub; ATLAS via Alpaca ETFs |
| Nov 14–21 | Lab grading with costs; swing P&L records gap; **bear side** (paper) with kill switch, gap stress and 30-day plan; correlation study; reversal-put shadow log |
| Nov 22 | Crypto records match the broker (222cdf5); broker scoreboard and buy-list timeout (416ae96); this document rewritten; 1:00 PM early-close days added to the market calendar |
