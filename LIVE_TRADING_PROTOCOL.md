# KiranRock — First 100 Live Trades Protocol

**Version:** 1.0  
**Status:** Draft — review before first live deposit  
**Purpose:** Prevent the most common failure mode of technically correct systems: reacting to early variance instead of observing real signal.

---

## Pre-Launch Gate (must pass before depositing any live capital)

Run `GET /api/system/live-readiness` and confirm:

```
liveReady: true
blockers: { all zeros }
advisoryWindow: stable (no upward trend)
```

Also confirm manually:
- [ ] 2+ full weeks of paper trading completed without halt
- [ ] SENTINEL blockers = 0 for the entire paper window
- [ ] No reconciliation errors in last 30 days
- [ ] EOD digest has been received and reviewed daily during paper run
- [ ] Alpaca live account created, funded with **$500–$2,000 max**
- [ ] `ALPACA_PAPER=false` change tested on a single manual ping — not a full run
- [ ] Backup: know how to manually set `HALT_ALL` in < 60 seconds

Do not deposit more than $2,000 until Phase 3 criteria are met.

---

## Capital and Sizing Rules (all phases)

| Rule | Value |
|------|-------|
| Opening deposit | $500–$2,000 |
| Max risk per trade | Use existing bot sizing — hard cap at $150 per position |
| Max simultaneous positions | 4 (same as paper) |
| Total portfolio at risk at any one time | ≤ 40% of account value |
| Stop-loss on all trades | Required — bracket order only (already enforced by ARROW) |
| No manual overrides to sizing | Ever, during all 100 trades |

If the bot tries to open a position that would exceed these caps, the correct action is to let the bot skip it — not to manually fund more.

---

## Phase 1: Observation (Trades 1–25)

**Goal:** Confirm real execution behaves like paper.  
**Time estimate:** ~2 weeks depending on signal frequency.

### What you do
- Watch. That's it.
- Read the EOD digest every day.
- Note differences from paper (fill prices, slippage, partial fills).
- Log anything surprising in a simple running note — not in code.

### What you do NOT do
- No code changes of any kind.
- No sizing changes.
- No parameter tuning.
- No "I'll just increase the score threshold slightly."

### Phase 1 pass criteria (all required before Phase 2)
- [ ] 25 trades executed without manual intervention
- [ ] Zero SENTINEL blockers fired
- [ ] No reconciliation errors
- [ ] Slippage ≤ 0.3% average per trade (see metrics section)
- [ ] Fill rate ≥ 90% (not more than 1 in 10 orders stuck/rejected)

If any criterion fails: stop, diagnose, fix, restart Phase 1 count.

---

## Phase 2: Stability Validation (Trades 26–50)

**Goal:** Confirm Phase 1 was not lucky variance.  
**Time estimate:** ~2 weeks.

### What you do
- Continue observation.
- Begin tracking evaluation metrics formally (see section below).
- Compare live fill quality vs paper fill quality.

### Allowed changes in Phase 2
- Bug fixes only — something that causes an observable malfunction.
- Logging improvements — adding more visibility to an existing flow.
- Nothing else.

### Phase 2 pass criteria
- [ ] 50 trades without a stop-loss failure (OPEN_WITH_STOP with no terminal state)
- [ ] Partial fill frequency ≤ 15% of orders
- [ ] Entry/exit price deviation ≤ 0.5% from model expectation (average)
- [ ] No duplicate executions
- [ ] Net P&L direction: ignore. Not a pass/fail criterion here.

> **Important:** A loss-making Phase 2 is fine. A Phase 2 with clean execution metrics is what matters.  
> A profitable Phase 2 with dirty execution metrics is a warning sign.

---

## Phase 3: Scaling Eligibility (Trades 51–100)

**Goal:** Decide whether to scale capital, continue as-is, or stop.  
**Time estimate:** ~3–4 weeks.

### What you do
- Continue full observation.
- At trade 75, do your first formal evaluation (see scaling decision below).
- At trade 100, make the scaling decision.

### Scaling decision at trade 100

Run `GET /api/system/trade-attribution?days=90` and check all four buckets.

**Green light to scale (all required):**
- [ ] Win rate in score 80+ bucket ≥ 45%
- [ ] Average P&L% across all trades > 0 (strategy has positive expectancy)
- [ ] Execution metrics still clean (slippage, fills, no halts)
- [ ] No individual sector or score bucket is single-handedly dragging results

**If green:** add $1,000–$2,000 more. Do not double. No more than one addition per 100 trades.

**If yellow (some criteria pass, some don't):** continue another 50 trades at same capital. Do not scale.

**If red (net negative, or execution dirty):** go back to paper. Full paper reset, not partial.

---

## Evaluation Metrics to Track

These are execution quality metrics, not P&L. Track them starting from trade 1.

| Metric | How to measure | Target |
|--------|----------------|--------|
| **Slippage** | (actual fill price − signal price) / signal price | ≤ 0.3% avg |
| **Fill rate** | orders filled / orders submitted | ≥ 90% |
| **Partial fill frequency** | partially filled orders / total | ≤ 15% |
| **Entry deviation** | abs(actual entry − model expected entry) / expected | ≤ 0.5% avg |
| **Rejection rate** | rejected + canceled without fill / total | ≤ 5% |
| **Stop-loss trigger rate** | how often bracket stop fires vs take-profit | track, no target |
| **Hold period distribution** | use `/api/system/trade-attribution` by hold bucket | track, no target |

Use `GET /api/system/health-dashboard` each morning to confirm GREEN before market open.

---

## Auto-Pause Conditions

These trigger automatically via existing circuit breakers. Do not override them.

| Condition | What happens |
|-----------|-------------|
| Daily loss ≥ configured daily % limit | Bot halts for the day |
| Weekly drawdown ≥ configured weekly % limit | Bot halts for the week |
| 3 consecutive stop-loss hits | Bot reduces position sizing |
| 5 consecutive stop-loss hits | Bot halts |
| Drawdown ≥ 5% from peak | Sizing reduced automatically |
| Drawdown ≥ 15% from peak | Bot halts |
| SENTINEL blocker fires | Session blocked before it starts |
| HALT_ALL set | All execution stopped system-wide |

None of these require your intervention to activate. They are already in the code.

---

## Manual Intervention Rules

**Intervene immediately if:**
- A position is open in Alpaca but NOT in the DB (SHADOW position — broker filled but DB missed)
- A HALT_ALL is set but you don't know why
- Two positions open for the same symbol
- Any Telegram alert about DB write failure after fill

**How to intervene:**
1. Set HALT_ALL via API or directly in `system_controls` DB row
2. Check Alpaca dashboard vs DB holdings
3. Reconcile manually if morning recon didn't catch it
4. Diagnose root cause before clearing HALT_ALL

**Do NOT intervene for:**
- A single losing trade
- A partial fill that completed correctly
- A day where no opportunities were found
- Early volatility that triggers a daily loss halt

---

## The "Do Not Touch" List

During the entire 100-trade window, these are frozen:

- SENTINEL thresholds and blocker definitions
- Order sizing logic
- Score thresholds for buy signals
- Stop-loss percentages
- Position limit logic
- Any file modified during this session's hardening sprint

The only exception: a bug that causes an observable malfunction (not a loss — a malfunction).

---

## Stop Conditions (exit live trading, return to paper)

Exit live trading and return to full paper mode if any of these occur:

| Condition | Threshold |
|-----------|-----------|
| Single trade loss | > 8% of account value |
| Cumulative drawdown from starting balance | > 20% |
| Two SENTINEL blockers in the same 7-day window | any combination |
| Reconciliation error that does not auto-fix | even once |
| Duplicate execution reaches broker | even once |
| Any trade executes without a corresponding DB record | even once |

"Return to paper" means: close live positions at market, switch `ALPACA_PAPER=true`, and run at least 2 more clean paper weeks before re-attempting.

---

## The Mindset Rule

After trade 1, your P&L will feel meaningful even though statistically it is noise until ~50 trades.

The rule: **Do not make any decision based on fewer than 25 trades.**

If the system is up 20% after 10 trades: do not scale.  
If the system is down 15% after 10 trades: do not panic-halt (unless a stop condition above triggers).  
Both are within normal variance at that sample size.

The evaluation metrics (slippage, fill quality, halt behavior) are the signal during Phase 1.  
P&L becomes signal only after Phase 3.

---

## Revision History

| Date | Change |
|------|--------|
| 2026-06-05 | v1.0 created before first live deposit |
