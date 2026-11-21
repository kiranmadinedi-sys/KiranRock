# Bear Side — 30-Trading-Day Assessment Plan

Written 2026-11-21, **before any bear-side trade exists**. Revised the same day after a cold-read review
(two passes by a reviewer with no project context who read only this file: 21 gaps, then 7 more; all are addressed here).
The rules are fixed in advance so the result is judged against them, not against how the numbers look.

**Change rule:** from Day 1 (2026-11-24) this document does not change, with two exceptions:
- entries in the logs of section 10;
- corrections of obvious typos, each listed in section 10 with its date.

Where the weekly report and the formulas in this document disagree, **this document wins**.

## 1. What is being assessed

The "bear side" is a paper-only part of the trading bot. It tries to make money, or lose less, when the
market falls. It has three parts ("legs"):

| Leg | What it does | Most it can lose per position |
|---|---|---|
| Hedge | Buys SH and PSQ, funds that rise when the S&P 500 / Nasdaq-100 fall | 6% to its stop, more if the price gaps past it |
| Short | Sells short weak stocks (profits if they fall), each with a buy-stop 8% above entry | 8% to its stop, more if the price gaps past it |
| Spread | Bear put spreads on SPY and QQQ (options that gain if the index falls) | The price paid (the "debit") |

- **Account:** the Alpaca paper account `user`. No real money. This account also runs the bot's other
  paper strategies (swing trading, options income, a momentum sleeve). That matters for C4.
- **Equity base:** the account equity at the close of Day 1 (2026-11-24), recorded in section 10. Every
  "% of equity" in this document uses this fixed number.
- **Code under test:** commit `c6e9926` on branch `feature/bear-side-paper`, frozen.
- **What counts as a bug:** the code does something other than this document or the commit describes it
  doing. A bug fix must not change any threshold, filter or rule. Each fix is described to the owner
  before it is made, then logged in section 10 with the trades it affected.
- **Live trading:** not considered at 30 days under any result (section 7).

## 2. Timeline (NYSE trading days; closed 11-26, 12-25 and 1-1)

| Date | Event |
|---|---|
| Sat–Sun 2026-11-21/22 | App restarted to load the bear-side code. A labelled TEST HALT is in place. |
| Mon 2026-11-23 | Operational checks only, no entries. The bot was already reading BEAR on 11-20, but its BEAR clock starts at the first check after the restart. Monday is BEAR session 1. |
| Tue 2026-11-24 | **Day 1:** first possible entries (BEAR session 2), if the checks passed and the halt was resumed. |
| Tue 2026-12-08 | Day 10: 2-week operational checkpoint (Gate A only). |
| Wed 2026-12-30 | Day 25: last day whose 5-day forward results finish by Day 30. |
| Thu 2027-01-07 | **Day 30:** full assessment. |
| Day 60 / Day 90 | Later reviews, counted the same way (trading days from Day 1). |

The count runs on trading days, whatever the regime. If the market leaves BEAR, the bear side sits idle.
Gate B then decides there isn't enough evidence yet. That is not a failure.

## 3. The questions

1. **Execution:** did the system place, protect, close and reconcile positions correctly? (Gate A)
2. **Enough evidence:** were there enough trades and days to judge? (Gate B)
3. **Regime:** when entries were allowed, did the market keep falling? (C1)
4. **Selection:** did the stocks picked for shorting do worse than SPY? (C2)
5. **Value:** after costs, did the short and spread legs beat T-bills on the same money? Did the hedge
   protect on down days at an acceptable cost? (C3)
6. **Portfolio:** did the bear side make the whole paper account better (a smaller worst drop for a
   similar return), not just profitable on falling days? (C4)

## 4. Gate A — Operational reliability

Gate A is judged over the **clean period**: from the day after the last bug fix to Day 30. If there were
no fixes, the clean period is the whole 30 days.
- Trades affected by a bug are listed in section 10, excluded from Gate C, and reported separately.
- If the clean period is shorter than 10 trading days, the strategy verdict is postponed to Day 60.
- **Periods used by Gate C:**
  - C3 uses closed trades opened in the clean period, minus any trades affected by a bug.
  - C1 and C2 use entry-allowed days and candidate-days in the clean period, on or before Day 25.
  - C4 always uses Day 1 to Day 30.
  - A Gate-A failure that was not caused by a code bug (for example, a broker-side problem) does not
    start a new clean period. It is logged in the incident log, and its trades are reported separately.

| # | Check | Pass when |
|---|---|---|
| A1 | Protective stops | No short was without a broker buy-stop for longer than one 5-minute check interval. |
| A2 | Stops not disturbed | No bear stop was cancelled by another part of the bot. Every "stop gone" event has a written cause in the section-10 incident log. |
| A3 | Records match the broker | No mismatch between bear records and broker positions lasted beyond the next trading day. Each one has a written cause in the incident log. |
| A4 | No unknown positions | The broker never held a short stock or option leg that no bear record explained. |
| A5 | No duplicate orders | Alpaca order history shows no order placed twice for the same purpose. |
| A6 | Exits confirmed | Every close was confirmed by the broker. Every liquidation was flat within 30 minutes, or alerted and resolved the same day. |
| A7 | Partial fills | Every partial fill was recorded at the filled quantity, with a stop for exactly that quantity. |
| A8 | Risk limits | Recorded stop-based risk (definition in section 9) never exceeded 5% of equity. Gap stress never exceeded 6% when a position was opened. |
| A9 | Stale data | No position was opened on a stale or fallback regime reading. |
| A10 | P&L matches the broker | Each closed bear trade's realized P&L agrees with Alpaca fill history to within $1. |

## 5. Gate B — Enough evidence

Counts use **closed trades from the clean period only**. Trades still open at Day 30 are left out of
Gates B and C3, with one exception: the hedge C3 test, which uses test days and the hedge total P&L
defined in section 9. Open trades are reported separately at their Day-30 market value and included in C4.

| Item | Minimum to judge at Day 30 |
|---|---|
| Short leg | 15 closed trades |
| Spread leg | 6 closed trades |
| Hedge leg | 5 "hedge test days": trading days on which the hedge was held at both the previous close and that day's close, and SPY closed down 1% or more |
| Regime (C1) | 5 entry-allowed days on or before Day 25 |
| Short selection (C2) | 200 candidate-days on or before Day 25 with a 5-day result |

Below the minimum, the verdict is **"insufficient evidence — continue unchanged to Day 60."**

## 6. Gate C — Strategy evidence

The formulas are in section 9. Every C item results in **Positive**, **Negative** or **Unclear**.

**C1. Regime.**
- An *entry-allowed day* is a trading day with at least one row in `bear_short_candidates`. The bot
  writes these rows only when new entries were permitted: BEAR confirmed over two sessions, SPY not
  bouncing, no halt, broker readable. Only days on or before Day 25 count.
- For each one, take SPY's return from that day's close to the close 5 trading days later.
- **Positive:** the average of those returns is below 0 **and** more than half of them are below 0.
- **Negative:** the average is above 0 **and** fewer than half are below 0.
- **Unclear:** otherwise.
- Reported, not judged: overlapping windows (consecutive days share most of their 5 days), and false
  alarms (BEAR followed by BULL within 10 trading days).

**C2. Short selection** (all logged candidates, traded or not, on or before Day 25).
- A *candidate-day* is one stock logged as a top short candidate on one day. The same stock on 3 days
  counts 3 times, equally weighted.
- Excess return = the stock's 5-day return minus SPY's 5-day return, both close to close from the log date.
- Candidate-days with a missing price are excluded, and their number is reported.
- **Positive:** average excess return below 0 **and** more than half of candidate-days below 0.
- **Negative:** average above 0 **and** fewer than half below 0.
- **Unclear:** otherwise.
- The same calculation is also reported per unique stock (first appearance only). If that version's
  Positive/Negative/Unclear label differs from the main one, C2 is Unclear.
- **RSI shadow test** (RSI = 14-day; the bot only shorts stocks with RSI ≥ 30): the 25–30 band is
  compared with the ≥ 30 band using the same calculation. Informational at Day 30. A rule change may only
  be *proposed* at Day 60, and only if each band has at least 30 candidate-days.

**C3. Value per leg** (legs that passed Gate B only):

| | Short | Spread | Hedge |
|---|---|---|---|
| **Positive** | Economic P&L > 0 **and** profit factor ≥ 1.2 **and** economic P&L > T-bill result | Adjusted P&L > 0 **and** profit factor ≥ 1.2 **and** adjusted P&L > T-bill result | Gained on ≥ 70% of hedge test days **and** hedge total P&L ≥ −1% of equity |
| **Negative** | Economic P&L < 0 **or** profit factor < 0.8 | Adjusted P&L < 0 **or** profit factor < 0.8 | Gained on < 50% of hedge test days **or** hedge total P&L < −2% of equity |
| **Unclear** | Otherwise | Otherwise | Otherwise |

**C4. Portfolio effect.**
- Series 1: the account's daily closing equity (Alpaca portfolio history) from the Day-1 close to the
  Day-30 close.
- Series 2: the same series minus the bear side's cumulative daily P&L, closed plus open marked at that
  day's closing prices.
- For each series, compute the maximum drawdown (largest drop from a previous daily-close high) and the
  total return.
- **Positive:** the drawdown is smaller with the bear side, and the total return is no more than 1
  percentage point lower.
- **Negative:** the drawdown is larger with the bear side, **or** the total return is more than 3
  percentage points lower.
- **Unclear / not judged:** otherwise. If the bear side held nothing for over 80% of the days, C4 is
  "not judged".
- If cash was deposited or withdrawn, those days' flows are removed from both series before calculating.
- Known blind spot: C4 can't see whether capital used by the bear side squeezed out the other strategies.

## 7. Decisions at Day 30

| Result | Decision |
|---|---|
| Clean period < 10 days | Postpone the verdict to Day 60. Keep observing. |
| A Gate-A check failed in the clean period | No Gate-C verdicts. Fix the cause (a code bug starts a new clean period), continue to Day 60. |
| C1 or C2 below its Gate-B minimum | That item is "insufficient". The other items are still judged. |
| Leg below Gate B | Continue that leg unchanged to Day 60. |
| C3 Positive | Continue unchanged. This is not approval for live trading. |
| C3 Unclear | Continue unchanged. |
| C3 Negative | Continue, and flag the leg for removal at Day 60. Pause it early only under the triggers below. |
| C1 Negative (BEAR didn't precede further falls) | Flag the regime signal itself for Day-60 review. All three legs depend on it. |
| C2 Negative | Flag short selection for Day-60 review, even if the short leg's P&L is positive (luck). |
| C4 Negative | Flag the whole bear side for Day-60 review, even if its legs made money. |
| No market regime other than BEAR during the 30 days | Record it. Live trading needs results across more than one market condition. |
| **Any result** | **No live trading.** That needs at least the Day-90 review (positive economic expectancy, acceptable drawdown, Gate A passing throughout, more than one market condition) and then a separate approval request. |

**Early-review triggers.** Checked at least weekly. Any one pauses new bear entries via the kill switch,
followed by a review with the owner:
- Bear side cumulative economic P&L since Day 1 (closed trades plus open positions at the latest close) below −3% of the equity base.
- The same Gate-A check failing on 2 separate days.
- Any broker position that no record explains (A4).

## 8. Who assesses

- **Claude** computes every figure from the raw tables and Alpaca data using section 9, and shows the
  inputs.
- The owner may have the figures cross-checked independently (for example by ChatGPT, from the same raw
  exports).
- If two calculations disagree, the figure is recomputed from raw data using section 9.
- **The owner makes the final decision.**

## 9. Definitions and formulas

**Market and safety terms**
- **Regime / BEAR:** the bot's own market reading (SPY more than 5% below its 200-day average and down
  more than 8% over 20 days, with other inputs). Other readings: PANIC, CHOPPY, NEUTRAL, BULL_MILD,
  BULL_STRONG.
- **Two-session confirmation:** BEAR must have been read continuously for 18+ hours, across two different
  trading days.
- **SPY bouncing:** SPY up 3% or more over 5 trading days, or above its 20-day average. New entries are blocked while this is true.
- **Stale / fallback reading:** a regime reading older than 30 minutes, or the default reading produced
  when market data failed.
- **Kill switch / halt:** a stop on new bear entries, triggered by a safety problem. Open positions are
  still managed. It is cleared only by a resume that re-checks the broker; every attempt is logged in
  `bear_resume_log`. A TEST HALT is a deliberate test halt, labelled as such.
- **Liquidation:** closing the whole bear side because the regime left BEAR.

**Risk measures**
- **Stop-based risk:**
  - Short: shares × entry price × 8%, plus dividends due in the hold.
  - Hedge: shares × entry price × 6%.
  - Spread: the debit paid.
- **Gap stress:** every short gapping up 30% through its stop, plus a 5% market gap on hedges and
  spreads. This is a defined scenario, not the worst case.

**Prices and P&L**
- **Decision price:** the latest trade price when the bot decided to enter. **Entry slippage** = fill
  price vs decision price (vs the mid price for spreads).
- **Adjusted P&L** (per trade):
  - Short: (entry − exit) × shares − dividends owed.
  - Hedge: (exit − entry) × shares.
  - Spread: (exit value − debit) × 100 × contracts.
  - Commissions are $0, and slippage is already in the fill prices.
- **Economic P&L:**
  - Short: adjusted P&L − 3%/yr × capital × days held / 365.
  - Spread and hedge: same as adjusted. Untracked costs (options regulatory fees, SEC/TAF sell fees) are
    disclosed, not estimated.
- **Gross P&L:** adjusted P&L + dividends owed + entry slippage in dollars. Shown for transparency, not
  used in any decision.
- **Capital (per trade):**
  - Short and hedge: shares × entry price.
  - Spread: the debit × 100 × contracts.
- **Days held:** calendar days from open to close, minimum 1.
- **T-bill result** (per leg): sum over trades of capital × days held / 365 × 4%. 4% is the bot's
  configured risk-free rate.
- **Profit factor:** the sum of positive P&Ls ÷ |the sum of negative P&Ls|, using the same P&L as the
  leg's C3 test (economic for shorts, adjusted otherwise). With no losing trade it is treated as ≥ 1.2.
- **Hedge "gained" on a test day:** the hedge's market value at that day's close minus at the previous
  close is above 0.
- **Hedge total P&L:** realized plus open at the Day-30 close.

## 10. Logs

**Equity base (Day-1 close):** *(to be recorded on 2026-11-24)*

**Bug fixes** (date · commit · what the code did vs this document · trades affected):
- *(none yet)*

**Incident log** (date · Gate-A check · cause · resolution):
- *(none yet)*

**Typo corrections:**
- *(none yet)*

## 11. Known limitations

- **Paper fills are kinder than real ones.** No queue position or market impact, so real slippage would
  be worse, especially for options spreads.
- **Borrow fees are unknown.** Alpaca gives no rate, and paper charges none. The 3% in economic P&L is
  an assumption.
- **Dividends owed by shorts** come from announced corporate actions. Paper doesn't charge them; they
  are deducted in our records.
- **One market episode.** 30 days is probably a single bear phase. Being right once can be luck.
- **Small numbers.** At 15 trades, a profit factor of 1.2 can still be luck. Day 30 decides whether to
  continue, not whether the edge is proven.

## 12. Where the evidence lives

| Source | Contents |
|---|---|
| `bear_positions` | Every trade: entry and exit, P&L, slippage, dividends, regime at entry and exit, squeeze warnings |
| `bear_short_candidates` | Top candidates every BEAR day, traded or not, with RSI and the reason for any rejection |
| `bear_state`, `bear_resume_log` | Regime state, halts, every resume attempt |
| `daily_bars` | Daily closes, for C1, C2 and C4 |
| Alpaca order / fill / portfolio history | The authority for A5, A10 and C4 |
| Weekly strategy review (Saturdays) | Running view. Section 9 wins if it differs |
| Telegram | All bear alerts |
