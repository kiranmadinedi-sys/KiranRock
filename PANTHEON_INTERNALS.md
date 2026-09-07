# PANTHEON Internals

**System reference — how KiranRock actually works, end to end.**
Written for self-review; last updated September 2026.

An end-to-end map of the logic: how a symbol becomes a scored candidate, how a candidate becomes an order, how an order gets protected and eventually closed — and everything watching over that loop.

---

## 1. Overview

KiranRock is an autonomous AI swing-trading platform. It trades US equities on a multi-day holding horizon across three real Alpaca accounts and one paper account, plus a separate 24/7 crypto sleeve, with no manual order entry in the normal case. The internal codename for the decision-making system is **PANTHEON** — a cascade of roughly two dozen scoring inputs (technical, fundamental, sentiment, pattern, and three separate machine-learning/LLM signals) that produces a single 0–100 conviction score per stock, followed by a chain of risk gates that decide whether a scored candidate is actually allowed to become an order.

The system runs in two time domains that constantly feed each other: an overnight batch pass that scores the entire tradable universe once a day, and a live loop during market hours that re-checks prices, re-runs the same scoring cascade on the day's best candidates, and manages every open position. A third, slower loop runs nightly to learn from the last 90 days of closed trades and adjust future scoring — separately for each account's own trade history.

---

## 2. Processes & cadence

Four PM2-managed processes; almost all of the scheduling logic lives in one of them.

### kiranrock-worker — the trading brain

Every scheduler below runs inside this single long-lived process:

- **Main swing cycle** — per-account loop, roughly every 5 minutes during 9:30am–4:00pm ET. Scans, scores, gates, sizes, executes, and manages existing positions for one account per pass.
- **Nightly universe scan** — overnight, scores the full tradable universe (1,300+ symbols) into `daily_universe_analysis` so the live loop can start each morning from a pre-scored candidate list instead of scoring cold.
- **Asset universe builder (HERMES)** — 8:45am ET pre-market build plus an evening and periodic intraday refresh; separately maintains a "velocity" list of today's movers.
- **Blitz** — opt-in 1-minute intraday cycle, currently enabled only on the paper account.
- **Options bot / options scanner** — opt-in, scans four times a day at fixed intervals plus a 5-minute position monitor.
- **News monitor / news rescan** — watches for high-impact breaking news on any symbol with an active BUY/STRONG BUY signal and re-scores it mid-session if hit.
- **EOD ingestion** — 6:30pm ET, pulls the day's consolidated OHLCV for the whole warehouse in one batched call, with split-detection.
- **System health monitor** — every 5 minutes: heartbeat, halt-flag, SENTINEL, missing stops, reconciliation — auto-fixes what it safely can, Telegram-alerts the rest.
- **Missed-opportunity monitor** — daily at 5:00pm ET, added this session: flags any symbol that scored STRONG BUY and actually moved 8%+ with zero buys anywhere.
- **IST pipeline** — a separate four-stage daily pipeline: `ATLAS` (market data warehouse refresh), `SHIELD` (pre-trade risk checks), `SCALE` (Kelly pre-computation), `ARROW` (stale-order cleanup at market close).

### The other three

- **kiranrock-backend** — the Express API and dashboard backend.
- **kiranrock-crypto** — deliberately isolated 24/7 process; never shares a scheduler tick with the equity side.
- **kiranrock-frontend** — the React dashboard.

---

## 3. The trading pipeline, end to end

1. **Universe building** — HERMES (`marketScreenerService`) maintains a static quality pool plus a daily "velocity" list of movers; `dynamicUniverseService` builds Blitz's separate pre-market universe. Symbols get tagged a quality tier (1 = mega-cap, 3 = velocity/speculative) — until this session, that field was never actually populated for the main pipeline and silently defaulted to 3 for everything.
2. **Nightly scoring** — the full universe runs through the same scoring cascade used live, overnight, writing one row per symbol per day to `daily_universe_analysis` (score, recommendation, pattern, whether it passed prescreen).
3. **Live candidate selection** — `scanMarketForOpportunities()` pulls that pre-scored list first (fast path), falls back to a live HERMES fetch if unavailable, caps the list by market regime (150–400 symbols), then trims further to a per-account `CANDIDATE_CAP` — as low as 8 for a single-position account, so a 4-minute cycle budget doesn't get burned scanning candidates it could never act on.
4. **Full scoring** — `analyzeStockWithAI()` runs the ~25-factor cascade (§4) — shared and 15-minute cached across every account, so the same symbol isn't re-scored per-account in the same window.
5. **Filter & rank** — drop anything below the account's `minBuyScore`, then sort — score first (a 5+ point gap always wins outright), tier only breaks a close tie. This was inverted from tier-first earlier this session.
6. **Per-account gates** — eleven checks in sequence, detailed in §5: regime cap, earnings blackout, existing-position guard, reasoned stop-cooldown, risk/reward ≥2.5, gap filter, extension guard, sector caps, correlation, portfolio heat budget, minimum notional.
7. **Position sizing** — Kelly fraction (from each account's own win-rate/win-loss history, falling back to a live-accounts blend) × confidence × regime/streak multipliers × a concentration-scale boost for accounts with fewer position slots, floored and capped by the account's risk config.
8. **Execution** — `brokerService` — limit orders only, never market. Standard entries are bracket orders (stop + target attached atomically); fractional sizes get two independent GTC orders since Alpaca's bracket class doesn't support notional quantities; an opt-in extended-hours path enters pre-market with no attached stop, protected by the next stop-verification pass instead.
9. **Position management** — every cycle: verify every holding has a live protective stop and restore it if missing (StopRepair), tighten trailing stops as a position gains, react to a regime downgrade by tightening further, take partial profits, and apply time-based exits (slow mover, max hold, pre-earnings).
10. **Exit & cooldown** — a hard stop-loss sets a re-entry cooldown — no longer a blanket 5 days; re-entry is allowed early once 2+ days have passed *and* price has traded 5%+ above the stop-out price, real evidence the move continued without the position.
11. **Nightly learning** — SAGE regenerates its learned score adjustments from the last 90 days of closed trades (with a genuine 30-day probation before a new adjustment goes live); LocalBrain rebuilds its win-rate-by-pattern lookup; EVOLVE retrains its price-bucket model. All three now exclude the paper account from the pool that feeds live-account learning.

---

## 4. The scoring cascade

Every candidate starts at a base score and accumulates points (or penalties) through roughly two dozen independent checks, grouped here by what each cluster is actually judging.

**Trend & technical structure**

| Factor | Weight |
|---|---|
| Trend Template (5 moving-average conditions, Minervini-style) | 0 to +15 |
| Momentum / ROC (10-day rate of change) | ±10 |
| Volume vs. average | ±10 |
| RSI, Stochastic RSI, Williams %R | ±10 / ±8 / ±7 |
| MACD & Bollinger Bands | variable |
| Mean-reversion vs. SMA20 (+ 50-day extension penalty, 8%-in-5-days overbought guard) | ±10 |
| Relative strength vs. SPY (multi-timeframe) | ±8 +3 |
| 52-week high proximity | ±7 |

**Event risk & macro**

| Factor | Weight |
|---|---|
| Earnings window (hard block 0–4 days out; neutral 5–15 days) | block / neutral |
| VIX level | ±10 |
| Geopolitical risk keywords in headlines | −10 |

**News & sentiment**

| Factor | Weight |
|---|---|
| PULSE (Gemini, Ollama fallback) — news sentiment score/label | ±5 |
| PULSE risk flags — *new* — fraud/regulatory/accounting/delisting hard-skip; exec departure/litigation heavy penalty | skip / −30 |
| Reddit alt-data (retail crowd signal) | ±6 |

**Chart pattern** *(best single match wins)*

| Pattern | Score |
|---|---|
| VCP (volatility contraction pattern) | 10 |
| Power Earnings Gap — *new* — post-earnings gap held 3+ days on 2x volume, ADX-confirmed | 9 |
| Cup & Handle / Darvas Box | 8 |
| Frog-in-the-Pan — *new* — smooth, low-volatility grind, few big-jump days | 7 |

**Structural confirmation**

| Factor | Weight |
|---|---|
| Volume dry-up (Minervini base confirmation) | variable |
| Wyckoff volume analysis | 0 to +15 |
| Market cap quality | ±5 |
| Sector rotation (COMPASS — ETF-based RS ranking) | ±8 |
| SONAR smart money (institutional ownership + insider transactions) | ±8 |
| Short-squeeze potential | ±8 |
| CANSLIM (EPS + revenue growth) | ±14 |

**Learning & cross-signal**

| Factor | Weight |
|---|---|
| PROPHET earnings forecast (direction, 15–45 days out) | ±8 |
| VISION (rule-based directional classifier) | ±8 |
| SAGE learned adjustment (per-account, now on a genuine 30-day probation) | ±5 |
| LocalBrain (win-rate by sector × pattern × regime) | ±6 |
| EVOLVE (2-year OHLCV bucket model) | ±8 |
| Regime & weekly-timeframe alignment | ±8 each |
| ATLAS global market intelligence | ±10 |

**Final judge**

| Factor | Weight |
|---|---|
| ORACLE verdict — local LLM synthesises everything above (qwen3.8:27b nightly batch, qwen2.5:7b live, priority-queued so live never waits behind the batch scan) | ±15 |

---

## 5. Risk gates & circuit breakers

A high score gets a candidate into consideration. It still has to clear all eleven of these, in order, before an order is placed:

```
regime cap → earnings blackout → existing-position guard → stop cooldown →
R/R ≥ 2.5 → gap filter → extension guard → sector count cap →
sector $ cap → correlation → portfolio heat
```

**Standing circuit breakers**

- **SENTINEL live-readiness gate** — scans a 30-day window for duplicate orders, order storms, stop-loss failures, reconciliation errors, and orders pending 24h+; blocks live trading on any account that trips it.
- **Loss-streak breaker** — 3 consecutive losses halves position size for that account; 5 halts new buys entirely.
- **No-new-entries windows** — 9:30–10:00am ET (opening price discovery) and after 2:30pm ET (late-day volatility). Exit management continues in both; only new entries pause.
- **Holiday-aware market hours** *(fixed this session)* — `isMarketOpen()` existed as five separate reimplementations across the codebase, none checking the NYSE holiday calendar. Now one shared source of truth.
- **Portfolio heat budget** — caps the dollar sum of every open position's stop-loss distance at a configurable percentage of account equity, checked before every new entry.

---

## 6. Agent glossary

| Agent | Role |
|---|---|
| **HERMES** | Universe screener — builds the tradable symbol pool and daily movers list. |
| **ORACLE** | Final AI verdict — a local LLM synthesising every other signal into TRADE / WATCHLIST / SKIP. |
| **PULSE** | News sentiment analyst (Gemini, local-model fallback) — now also flags fraud/regulatory risk distinctly from ordinary sentiment. |
| **PROPHET** | Earnings-direction forecaster, fires 15–45 days before a report. |
| **SAGE** | Learning brain — Kelly win-rate stats and score adjustments from each account's own closed-trade history. |
| **LocalBrain** | Statistical pattern memory — win rate by sector × chart pattern × market regime. |
| **EVOLVE** | Lightweight ML signal trained on two years of raw price bars, independent of live trade history. |
| **COMPASS** | Sector navigator — ETF-based relative-strength ranking across all eleven sectors. |
| **ATLAS** | Global market intelligence — overnight futures, international markets, macro tone. |
| **SONAR** | Institutional ownership and insider-transaction tracking (Finnhub → Polygon → SEC EDGAR fallback chain). |
| **VISION** | Rule-based directional classifier, independent cross-check against the LLM-driven signals. |
| **SENTINEL** | Live-readiness safety gate — the standing circuit breaker across every account. |

---

## 7. Accounts

| Account | Type | Min score | Max positions | Notes |
|---|---|---|---|---|
| kmadined | live | 75 | 4 | Flagship live account, own Alpaca credentials. |
| Parvataneni | live | 65 | 5 | Own credentials, lower-frequency activity. |
| anilboddu1 | live | 65 | 1 | Small account — tightened candidate cap so one scan cycle finishes before the late-day cutoff. |
| user | paper | 75 | 4 | Runs on shared fallback credentials, not its own — high-volume test bed, excluded from live accounts' learning pool. |
| crypto sleeve | opt-in | 70 | 5 | 24/7, isolated process, curated 15-pair universe, own risk config. |

---

## 8. Supporting systems

**Data** — Alpaca is the primary broker and market-data source; Yahoo Finance and Polygon.io serve as fallbacks behind shared rate limiters and circuit breakers so one caller's failures don't starve every other caller sharing the same budget.

**Position reconciliation** — Compares the database's view of holdings against Alpaca's actual positions on every restart and on a schedule, detecting three discrepancy classes — a **phantom** (DB shows shares, broker doesn't), a **drift** (quantities disagree), and a **shadow** (broker holds shares the DB never recorded). Shadows now also backfill the missing trade record, not just the holding — a gap found and fixed this session.

**Order audit log** — Every order's full lifecycle (created → submitted → filled/canceled) is written under an idempotency key, with child keys for related sub-events like end-of-day cleanup — the same mechanism that once produced a false "blocked" reading in SENTINEL, and later a duplicate-journaling bug that re-logged the same stale order as canceled every day for months before being caught.

**Alerting** — Telegram delivers real-time alerts (stop-loss fired, large loss, daily-loss-limit reached, reconciliation issues) plus scheduled digests (market open/close, weekly performance recap, weekend prep, Friday's permanent weekly report).

---

## 9. Recent changes

What changed this session, roughly in the order it was found:

1. **EOD cleanup duplicate-journaling fix** — a daily cleanup job had re-logged the same stuck order as "canceled" every day since June — 6,787 duplicate audit rows found and cleaned up.
2. **SAGE / LocalBrain per-account learning** — the paper account's high-volume, lower-win-rate activity was blended into the same learning pool that sizes live-account trades. Now scoped per account with a live-only fallback.
3. **Ollama priority queue** — live trading calls now jump the nightly batch scan's queue instead of waiting in FIFO order behind it.
4. **Gemini model fix** — PULSE's primary provider had been silently 404ing on every call after Google retired the model version in use.
5. **Opportunity sort-order + tier population** — candidates were ranked by quality tier before score; separately, the tier field itself had never been populated and defaulted to the same value for everything.
6. **Missed-opportunity monitor** — new daily check: did any symbol score STRONG BUY repeatedly, actually move, and never get bought anywhere?
7. **Shadow-trade backfill** — a real, protected position could exist with zero record in the trade ledger. Reconciliation now backfills both.
8. **Reasoned stop-loss re-entry** — replaced a blanket 5-day re-entry block with a check for real evidence — price traded meaningfully above the stop-out level, not just time elapsed.
9. **PULSE risk flags** — fraud, regulatory action, and accounting concerns now hard-skip a candidate — previously indistinguishable from ordinary bad news in the sentiment score.
10. **Holiday-aware market hours** — five separate implementations of "is the market open," none checking the holiday calendar — unified into one.
11. **ADX + two new chart patterns** — trend-strength confirmation, plus Frog-in-the-Pan and Power Earnings Gap detection — three ideas adopted from published strategy research.

---

## 10. Known open items

Deliberately unresolved, and why:

- **A confirmed missed trade with no confirmed root cause.** A stock scored STRONG BUY for five straight days during a real breakout and was never bought by any account. The ranking and tier bugs found while investigating are real fixes, but neither was proven to be *the* reason that specific trade never happened — no rejection or error log for it turned up anywhere. Still open.
- **Capital utilization hasn't moved yet.** Several sizing fixes landed this session; the two main live accounts are still deploying roughly the same share of capital as before. Likely too early to tell — needs more trading days before concluding the fixes did or didn't work.
- **Power Earnings Gap has no custom stop/target.** The pattern is detected and scored, but still uses the standard ATR-based stop/target rather than the source strategy's gap-specific levels — deliberately scoped down on a night with no market open to validate against.
- **Editable rules ("playbook") — not started.** Every scoring threshold and gate still lives in code, requiring a deploy to change. A markdown-based, LLM-readable rules layer was scoped but deliberately deferred as its own project rather than rushed in behind other changes.
- **Options-flow signal — not started.** Unusual options activity isn't used as an equity signal anywhere, despite a separate options bot already existing. Flagged as a real gap, not yet scoped.

---

*Generated for self-review, not for distribution.*
