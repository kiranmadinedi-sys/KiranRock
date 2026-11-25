# Universe build: Polygon first, Yahoo as backup

Status: REVISED after cold-read review — 2026-11-25. Nothing implemented yet. Live-affecting → owner approval required before `on`.

## 1. Problem

Two daily builds call Yahoo once per stock, ~27,000 calls a day through a shared, rate-limited Yahoo client:

| Build | Code | When | Yahoo calls | Time |
|---|---|---|---|---|
| HERMES stock universe (feeds nightly scan + live bot) | `marketScreenerService._buildStockUniverse` | first `getStockUniverse()` after cache expiry | ~13,475 `quote()` | several hours |
| Blitz pre-market universe | `dynamicUniverseService.buildPreMarketCache` | 8:45 AM ET + on restart before 3:30 PM ET | 13,473 `quote()` (dbHits = 0) | 2.8 h on 11-24 |

Effects: Yahoo 429s all day (these also hit VIX, fundamentals, weekly predictions); a mid-day restart leaves Blitz with no list for the rest of the day (11-24); hung builds in the past (08-27, 09-01).

Blitz's "warm start" never hits: `addDynamicSymbol`'s ON CONFLICT does not update `market_cap`/`avg_volume` (assetUniverseService.js:214-217), so `asset_universe_daily.market_cap` is 0 on every row.

## 2. Evidence (measured 2026-11-25 on our own keys)

- Alpaca snapshots: our plan is IEX-only (SIP → 403). AAPL IEX volume 1.9M vs ~41M real. **Never use Alpaca volume for a filter.**
- Polygon grouped daily: one call = whole market (12,630 tickers for 11-24), consolidated volume. 20 days fetched in 5 s, 0 failures. An existing helper does this call: `eodIngestionService.fetchGroupedDailyBars` (returns `[]`, does not throw, when Polygon has no results). The 6:30 PM ET EOD job already calls it every weekday, then discards everything outside the ~2,830-symbol universe (eodIngestionService.js:379).
- Prefilter test against the 11-24 HERMES build (13,475 pool, 2,771 passed), skip when Polygon 20-day avg volume < cut:

| Cut | Yahoo calls left | Passed stocks that would be dropped |
|---|---|---|
| 300k (= floor) | 5,322 | 30 |
| 200k | 5,949 | 7 |
| **150k (half the floor)** | **6,361 (−53%)** | **4: ARAY, TGL, ADGM, TOPP** — all passed only via the $10B placeholder cap (micro-caps) |
| 100k | 6,982 | 1 |

- 673 pool symbols are absent from Polygon (34 passed): these keep going to Yahoo.
- `daily_bars` covers only ~2,830 symbols, so 52-week range / SMA / sector / RS for the whole pool stay Yahoo-sourced.

## 3. Design

### 3.1 Store whole-market daily volume (no new network calls in the build)
1. New table `market_daily_volume(symbol, trade_date, close, volume, PRIMARY KEY(symbol, trade_date))`. The EOD job writes ALL tickers from the grouped bars it already fetches (one bulk insert, ~12.6k rows/day). Keep 30 trading days (delete older in the same job) → ~380k rows.
2. One-time backfill of the last 20 trading days (20 calls via `fetchGroupedDailyBars`, retry 3× on 429/5xx; an empty result counts as a failed day).
3. Window = the last 20 **completed** trading days: ends at `marketCalendar.previousTradingDay(today)` unless today's EOD row set exists (EOD job finished). Never includes a partial trading day.

### 3.2 HERMES nightly build — volume prefilter
1. Before the per-symbol loop, one SQL query: `AVG(volume)` and day count per symbol over the window (same pattern as `loadRealAvgVolumes`).
2. Health gate (whole-provider fallback): prefilter enabled only if ≥ 15 of the 20 window days each have ≥ 8,000 tickers. Otherwise log `[HERMES] Prefilter OFF — <reason>; full Yahoo build` and run today's exact path. If the EOD job's Polygon call fails on a night, that day is simply missing and the gate counts it.
3. Skip the Yahoo call for a symbol only if ALL hold:
   - tier 6 (bulk DB pool) — never tiers 1/2/4/5 or velocity;
   - present on ≥ 10 window days;
   - window avg volume < `HERMES_PREFILTER_MIN_VOLUME` (default 150,000);
   - its own `daily_bars` average (`realAvgVolumes`) is also below the HERMES floor (HERMES passes on max(quote, daily_bars), line 453).
4. Skipped → `hermes_symbol_log` row `passed=false, fail_reason='volume_prefilter', avg_volume=<window avg>, market_cap=NULL`. Safe: every reader filters `passed=true` (getCompletedHermesSymbols, getScanTargetSize, precomputedUniverseService:49-53, scripts/backfillSectors.js); `velocity_quote_error` rows already store NULL caps.
5. Logs: exclusion breakdown gains `prefiltered=<n>`, `prefilter=on|off|shadow`; the volume gain-curve buckets report prefiltered symbols as a separate count.
6. Side benefit: the window close gives a $5 price check, and the table widens real-volume coverage beyond `daily_bars`.

### 3.3 Blitz pre-market build — reuse completed HERMES results
1. Extend `hermes_symbol_log` (ADD COLUMN IF NOT EXISTS) with `price, rs_score, week52_high, week52_low, sma50, sma200, sector, industry`; `_logHermesSymbol` writes them for passed rows (values already in scope at line 481). Without these, hits would get rsScore 0.5 and null 52-week high, making the 400-stock cut arbitrary and skipping `passesQuickFilter`'s proximity/price checks.
2. Source: the latest **completed** weekday build — a date present in `hermes_build_status` (never a build still running or cut short), within 4 days.
3. Hit classes:
   - `passed=true`, `fail_reason IS NULL` → hit with the stored fields (price refreshed from Alpaca latest trade — price only);
   - `passed=false`, `fail_reason IN ('volume','cap','both','volume_prefilter')` → rejected, no Yahoo call;
   - `quote_error_fallback` / `velocity_quote_error` / absent / passed row missing the new fields (pre-migration) → Yahoo, as today.
4. **Hits set `volume: 0`**, never the IEX snapshot volume. Today's (never-executed) hit path sets `volume = live.volume` (dynamicUniverseService.js:331), and `passesQuickFilter`'s volume-ratio check (< 0.3 → reject) would reject nearly every hit against real avg volume. Test required.
5. Velocity symbols and ETFs still go to Yahoo (~100 calls).
6. Fallback: no completed build in 4 days, or the load fails → today's full Yahoo path.
7. Expected, not an error: HERMES passes on max(quote, daily_bars) volume while Blitz's Yahoo path is quote-only, so some HERMES passes are stocks Blitz-via-Yahoo would reject (HERMES is the more accurate one).

### 3.4 Rollout — `UNIVERSE_PREFILTER=off|shadow|on` (default `shadow`)
`shadow` (3–5 trading days): compute every decision but still call Yahoo for every symbol, then log:
- HERMES: would-skip count; would-skip ∩ passed with a real cap (= real loss), listed; joined to `daily_universe_analysis` to show any with AI score ≥ 80.
- Blitz: build the capped 400 both ways (cached vs Yahoo) and report overlap (Jaccard) and top-100 overlap; agreement measured only on symbols Yahoo passed; list disagreements.

Pass criteria for `on` (owner approves): real loss ≤ 0.5% of real-cap HERMES passes and no ≥ 80 names lost; Blitz final-400 Jaccard ≥ 0.90 and top-100 overlap ≥ 90%, disagreements explained.
`off` = exactly today's behaviour (instant rollback via `.env` + restart).

## 4. Expected effect (when `on`)
- HERMES build: ~13,475 → ~6,400 Yahoo calls (about half the time), zero extra network calls.
- Blitz build: ~13,473 → ~100–700 Yahoo calls; ready in minutes; a mid-day restart no longer costs Blitz the day.
- Fewer Yahoo 429s for VIX / fundamentals / weekly predictions.

## 5. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Polygon volume differs from Yahoo's | Cut at half the floor; daily_bars check; curated tiers never prefiltered; shadow measures real loss |
| Polygon outage / empty day | Missing day in the table → health gate → full Yahoo build; per-symbol absence → Yahoo |
| Partial trading day in the window | Window ends at the last completed trading day |
| Blitz reads a half-finished HERMES build | Only dates in `hermes_build_status` |
| Blitz uses a weekend-old build on Monday | Weekday-only builds within 4 days; velocity names live-quoted |
| DB size | ~380k rows rolling; well within limits |

## 6. Out of scope
VIX source; nightly AI scoring (already uses local `daily_bars`); weekly-prediction fundamentals; Alpaca data-plan upgrade (not needed).

## 7. Tests
- Table: EOD writes all tickers; retention; backfill retries; empty day = failure; window excludes today until EOD done.
- Prefilter: tier/velocity exemptions, cut, daily_bars override, missing symbol → Yahoo, health gate → full Yahoo, shadow → Yahoo still called.
- Blitz: each fail_reason class, quote_error_fallback → Yahoo, incomplete build ignored, no recent build → Yahoo, hits use `volume: 0`, stored rs/52w/price used for sort and quick filter.

## 8. Review log
- 2026-11-25 cold read (fresh reviewer): 10 findings, all adopted — stored fields for Blitz hits (severe), IEX volume on hit path (severe), half-finished build (high), partial-day window (high), shadow metrics on final 400 (medium), reuse existing Polygon helper / store EOD data instead of new calls (medium/simpler), daily_bars override, gain-curve count, NULL-cap safety confirmed.
