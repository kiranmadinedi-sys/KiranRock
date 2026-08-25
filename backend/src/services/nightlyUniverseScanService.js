/**
 * Nightly Universe Scan Service
 *
 * Runs after market close (~5:00 PM ET) to score the full stock universe with AI.
 * Results are stored in `daily_universe_analysis` and read the next morning by
 * precomputedUniverseService for fast, full-coverage market-hours scanning.
 *
 * Why this matters:
 *   - Covers ALL tickers (including AMD, emerging names, IPOs via velocity)
 *   - Market-hours scan uses pre-scored list (~100 candidates) vs 300-500 live
 *   - 3-5× faster live scans with zero reduction in universe coverage
 *   - Full audit trail: every stock's score + exclusion reason is persisted
 */

const { query }              = require('../config/database');
const marketScreenerService  = require('./marketScreenerService');
const marketRegimeService    = require('./marketRegimeService');
const alertService           = require('./telegramAlertService');
const precomputedSvc         = require('./precomputedUniverseService');
const { analyzeStockWithAI, getVixLevel } = require('./enhancedAITradingBot');

// One symbol at a time with a 10-second pause — ~6 stocks/min.
// 10s (not 6s) gives Yahoo Finance headroom after a day of heavy usage
// and prevents 429 rate-limit cascades that produce 12-hour null loops.
const BATCH_SIZE     = 1;
const BATCH_DELAY_MS = 10_000;

let _scanRunning = false;

/**
 * Calls analyzeStockWithAI with retry on null result, 429 rate-limits, or any transient error.
 *
 * Retry schedule (maxRetries = 1 → up to 2 total attempts):
 *   null result  → wait 15s  (soft failure — data not ready yet)
 *   429 error    → wait 45s  (rate limit — needs longer cool-down)
 *   other error  → wait 15s  (transient — network blip, timeout, etc.)
 *
 * Kept at 1 retry (not 2) so rate-limited tickers fail fast (~15-45s) rather
 * than burning 90s per ticker and causing 12-hour null loops.
 * Returns null only after all retries are exhausted.
 */
async function _analyzeWithRetry(symbol, vixLevel, regime, maxRetries = 1) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await analyzeStockWithAI(symbol, vixLevel, null, regime);

            if (result != null) return result; // success

            // analyzeStockWithAI returned null — retry with a pause
            if (attempt < maxRetries) {
                const waitMs = 15_000;
                console.warn(`[NightlyScan] null result for ${symbol} — retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
                await new Promise(r => setTimeout(r, waitMs));
                continue;
            }
            return null; // all retries exhausted

        } catch (err) {
            if (attempt >= maxRetries) {
                console.warn(`[NightlyScan] ${symbol} failed after ${maxRetries + 1} attempts: ${err.message}`);
                return null; // convert to null so the loop continues rather than crashing the whole scan
            }

            const is429 = /429|too many requests/i.test(err.message || '');
            const waitMs = is429 ? 45_000 : 15_000;
            const label  = is429 ? '429 rate-limit' : `error (${err.message.slice(0, 60)})`;
            console.warn(`[NightlyScan] ${label} on ${symbol} — retrying in ${waitMs / 1000}s (attempt ${attempt + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, waitMs));
        }
    }
    return null;
}

function _todayET() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function _isMarketHours() {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const t  = et.getHours() * 60 + et.getMinutes();
    const d  = et.getDay();
    return d >= 1 && d <= 5 && t >= 9 * 60 + 30 && t < 16 * 60;
}

/**
 * Derive recommendation label from a numeric score.
 * Must match the thresholds in analyzeStockWithAI (≥75=STRONG BUY, ≥65=BUY, ≤25=STRONG SELL, ≤35=SELL).
 */
function _deriveRecommendation(score) {
    if (score == null) return 'HOLD';
    if (score >= 75) return 'STRONG BUY';
    if (score >= 65) return 'BUY';
    if (score <= 25) return 'STRONG SELL';
    if (score <= 35) return 'SELL';
    return 'HOLD';
}

/**
 * Compute 3-day EMA of a raw daily score using the two most recent prior days.
 * Weights: today 50%, yesterday 30%, day-before-yesterday 20%.
 * Returns rawScore unchanged when there is no prior history (new stock).
 * Logs a warning when the smoothed score moves >15 points from yesterday.
 */
async function _computeSmoothedScore(symbol, rawScore, today) {
    if (rawScore == null) return rawScore;
    try {
        const res = await query(
            `SELECT ai_score
             FROM daily_universe_analysis
             WHERE symbol = $1
               AND analysis_date >= $2::date - INTERVAL '3 days'
               AND analysis_date <  $2::date
               AND ai_score IS NOT NULL
             ORDER BY analysis_date DESC
             LIMIT 2`,
            [symbol, today]
        );
        if (res.rows.length === 0) return rawScore; // no history — use raw as-is

        // ai_score in the DB is already the smoothed value from prior days
        const prev1 = parseFloat(res.rows[0].ai_score);
        const prev2 = res.rows.length > 1 ? parseFloat(res.rows[1].ai_score) : prev1;

        const smoothed = Math.round(rawScore * 0.5 + prev1 * 0.3 + prev2 * 0.2);

        const delta = smoothed - prev1;
        if (Math.abs(delta) > 15) {
            console.warn(
                `[NightlyScan] Score spike: ${symbol} raw=${rawScore} smoothed=${smoothed} prev=${prev1} (Δ${delta > 0 ? '+' : ''}${delta}) — manual review advised`
            );
        }
        return smoothed;
    } catch (_) {
        return rawScore; // fail-safe: never crash the scan over smoothing
    }
}

/**
 * Upserts one analysis row into daily_universe_analysis.
 */
async function _upsert(symbol, date, analysis, passedPrescreen, exclusionReason) {
    await query(
        `INSERT INTO daily_universe_analysis
             (symbol, analysis_date, ai_score, recommendation, setup_family,
              sector, market_cap, passed_prescreen, exclusion_reason, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (symbol, analysis_date) DO UPDATE SET
             ai_score         = COALESCE(EXCLUDED.ai_score, daily_universe_analysis.ai_score),
             recommendation   = COALESCE(EXCLUDED.recommendation, daily_universe_analysis.recommendation),
             setup_family     = COALESCE(EXCLUDED.setup_family, daily_universe_analysis.setup_family),
             sector           = COALESCE(EXCLUDED.sector, daily_universe_analysis.sector),
             market_cap       = COALESCE(EXCLUDED.market_cap, daily_universe_analysis.market_cap),
             passed_prescreen = CASE WHEN EXCLUDED.ai_score IS NOT NULL THEN EXCLUDED.passed_prescreen ELSE daily_universe_analysis.passed_prescreen END,
             exclusion_reason = CASE WHEN EXCLUDED.ai_score IS NOT NULL THEN EXCLUDED.exclusion_reason ELSE daily_universe_analysis.exclusion_reason END,
             metadata         = CASE WHEN EXCLUDED.ai_score IS NOT NULL THEN EXCLUDED.metadata ELSE daily_universe_analysis.metadata END,
             updated_at       = NOW()`,
        [
            symbol,
            date,
            analysis?.aiScore    ?? null,
            analysis?.recommendation ?? null,
            analysis?.setupFamily ?? null,
            analysis?.sector      ?? null,
            analysis?.marketCap   ?? null,
            passedPrescreen,
            exclusionReason,
            analysis ? JSON.stringify(analysis) : '{}'
        ]
    );
}

/**
 * Returns true while a scan is running — used by the scheduler to avoid double-launches.
 */
function isScanRunning() { return _scanRunning; }

/**
 * Main entry point — call from scheduler or standalone script.
 * Safe to call concurrently: skips if a scan is already in progress.
 *
 * @param {{ missingOnly?: boolean }} opts
 *   missingOnly=true  → skip symbols already stored for today (resume after crash)
 *   missingOnly=false → full scan of entire universe (default)
 * @returns {{ analyzed, passed, filtered, failed, date, elapsedMin }}
 */
async function runNightlyUniverseScan(opts = {}) {
    if (_scanRunning) {
        console.log('[NightlyScan] Scan already in progress — skipping duplicate trigger');
        return null;
    }

    // Refuse to run during market hours — would compete with live trading for API quota
    if (_isMarketHours()) {
        console.log('[NightlyScan] Market is open — nightly scan deferred until after close');
        return null;
    }

    _scanRunning = true;
    const startTime = Date.now();
    const today     = _todayET();

    console.log(`[NightlyScan] ── ${opts.missingOnly ? 'Resuming' : 'Starting'} nightly universe scan for ${today} ──`);

    let analyzed = 0, passed = 0, filtered = 0, failed = 0;

    try {
        // Full market universe via getStockUniverse() — HERMES-filtered by real market cap
        // (≥$2B) and volume (≥300K avg) across the whole ~13,000-symbol Alpaca-tradable
        // pool, capped to the best HERMES_MAX_STOCKS by tier+relative-strength. Switched
        // from the hand-curated static list (getStockOnlySymbolList) on 2026-08-25 — that
        // list required someone to notice and manually add every individual company (RIG,
        // CBRS, and the other 2026-08-24/25 gap-hunting sessions found dozens missing this
        // way), when the actual reason it existed — getStockUniverse() flooding Yahoo's
        // rate limit before AI analysis even started — no longer applies after this
        // session's fixes (Polygon-first quotes, the cache-stampede fix, and excluding the
        // bulk DB-driven tier from the per-symbol earnings check). A cold getStockUniverse()
        // build now takes ~20-30 min (validated live), and it's shared/cached 24h across
        // every other caller (istPipelineScheduler ticks it every 60s all day), so in
        // practice this scan usually rides an already-warm cache instead of paying that
        // cost itself. The AI-analysis loop below is completely unchanged — same pacing
        // (BATCH_SIZE=1, 10s delay), same per-symbol cost — only the candidate SOURCE
        // changed, and the result stays bounded by HERMES_MAX_STOCKS either way, so this
        // does not turn into an unbounded flood of the ~13,000 raw pool.
        const _timeout = (p, ms, fallback) =>
            Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);

        const [fullUniverse, vixLevel, regime] = await Promise.all([
            marketScreenerService.getStockUniverse(),
            _timeout(getVixLevel(), 15000, 15),                          // fallback VIX=15 if Yahoo hangs
            _timeout(marketRegimeService.getMarketRegime(), 15000, null) // fallback regime=null → NEUTRAL
        ]);
        // ETFs excluded — analyzeStockWithAI returns null for them (no earnings/fundamentals)
        const symbolList = fullUniverse.filter(s => !s.isETF).map(s => s.symbol);

        let symbols = symbolList;

        // missingOnly mode: skip symbols already stored for today so retries are cheap
        if (opts.missingOnly) {
            try {
                const doneRes = await query(
                    `SELECT symbol FROM daily_universe_analysis WHERE analysis_date = $1::date AND ai_score IS NOT NULL`,
                    [today]
                );
                const doneSet = new Set(doneRes.rows.map(r => r.symbol));
                const before  = symbols.length;
                symbols = symbols.filter(s => !doneSet.has(s));
                console.log(`[NightlyScan] Resume mode: ${doneSet.size} already done, ${symbols.length} remaining of ${before}`);
                if (symbols.length === 0) {
                    console.log('[NightlyScan] All symbols already analyzed — nothing to do');
                    return { analyzed: 0, passed: 0, filtered: 0, failed: 0, date: today, elapsedMin: '0.0' };
                }
            } catch (e) {
                console.warn('[NightlyScan] Could not load done-set, scanning full universe:', e.message);
            }
        }

        // Wrap as minimal objects so the rest of the loop only needs symbol strings
        const universe = symbols.map(sym => ({ symbol: sym }));

        console.log(`[NightlyScan] Universe: ${universe.length} symbols | VIX: ${typeof vixLevel === 'number' ? vixLevel.toFixed(1) : 'n/a'} | Regime: ${regime?.regime || 'NEUTRAL'}`);

        // Pre-load known symbols (last 14 days) for new-ticker detection
        let knownSymbols = new Set();
        try {
            const knownRes = await query(
                `SELECT DISTINCT symbol FROM daily_universe_analysis
                 WHERE analysis_date >= CURRENT_DATE - INTERVAL '14 days'
                   AND analysis_date < $1::date`,
                [today]
            );
            knownSymbols = new Set(knownRes.rows.map(r => r.symbol));
        } catch (_) {}

        const newTickers = [];

        for (let i = 0; i < universe.length; i += BATCH_SIZE) {
            const batch = universe.slice(i, i + BATCH_SIZE);

            await Promise.allSettled(
                batch.map(async stock => {
                    const isNewTicker = !knownSymbols.has(stock.symbol);
                    if (isNewTicker) newTickers.push(stock.symbol);

                    try {
                        const analysis = await _analyzeWithRetry(stock.symbol, vixLevel, regime);

                        if (!analysis) {
                            await _upsert(stock.symbol, today, null, false, 'analyzeStockWithAI returned null');
                            failed++;
                            return;
                        }

                        // Attach new-ticker flag so the market-hours loader can highlight it
                        if (isNewTicker) {
                            analysis.isNewTicker = true;
                        }

                        // Apply 3-day EMA smoothing to kill single-day whipsaws.
                        // Raw score is preserved in analysis.rawScore (written to metadata).
                        // Smoothed score replaces ai_score and is used for ranking + prescreen.
                        const rawScore = analysis.aiScore;
                        const smoothedScore = await _computeSmoothedScore(stock.symbol, rawScore, today);
                        if (smoothedScore !== rawScore) {
                            analysis.rawScore      = rawScore;
                            analysis.aiScore       = smoothedScore;
                            analysis.recommendation = _deriveRecommendation(smoothedScore);
                        }

                        // Pre-screen: accept STRONG BUY or BUY above an absolute floor.
                        // The live scan applies the user's minBuyScore; overnight we use a
                        // lower floor (70) so borderline candidates aren't lost prematurely.
                        const passedPrescreen =
                            (analysis.recommendation === 'STRONG BUY' || analysis.recommendation === 'BUY') &&
                            analysis.aiScore >= 70;

                        const exclusionReason = passedPrescreen
                            ? null
                            : `${analysis.recommendation} / score ${analysis.aiScore}${rawScore !== smoothedScore ? ` (raw ${rawScore})` : ''}`;

                        await _upsert(stock.symbol, today, analysis, passedPrescreen, exclusionReason);

                        if (passedPrescreen) { passed++; } else { filtered++; }
                        analyzed++;
                    } catch (err) {
                        const reason = (err.message || 'unknown error').slice(0, 200);
                        await _upsert(stock.symbol, today, null, false, reason).catch(() => {});
                        failed++;
                    }
                })
            );

            // Throttle between batches
            if (i + BATCH_SIZE < universe.length) {
                await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
            }

            // Progress every 50 symbols
            const done = Math.min(i + BATCH_SIZE, universe.length);
            if (done % 50 === 0 || done === universe.length) {
                console.log(`[NightlyScan] ${done}/${universe.length} | passed: ${passed} | filtered: ${filtered} | failed: ${failed}`);
            }
        }

        const elapsedMin = ((Date.now() - startTime) / 60_000).toFixed(1);

        // ── New ticker report ────────────────────────────────────────────────────
        if (newTickers.length > 0) {
            console.log(`[NightlyScan] 🆕 New tickers (${newTickers.length}): ${newTickers.slice(0, 20).join(', ')}${newTickers.length > 20 ? '...' : ''}`);
        }

        // ── Exclusion reason summary ─────────────────────────────────────────────
        const exclusionSummary = await precomputedSvc.getExclusionSummary(today);
        if (exclusionSummary.length > 0) {
            console.log('[NightlyScan] Exclusion breakdown:',
                exclusionSummary.map(r => `${r.category}: ${r.count}`).join(' | ')
            );
            // Flag if high error rate — likely a data provider issue
            const errorRow = exclusionSummary.find(r => r.category === 'api_rate_limit' || r.category === 'error');
            if (errorRow && errorRow.count > universe.length * 0.10) {
                console.warn(`[NightlyScan] ⚠️ High error rate: ${errorRow.count} ${errorRow.category} failures`);
            }
        }

        // ── Coverage failure alert — Telegram if <85% coverage or >15% errors ───
        const coverageRate = universe.length > 0 ? analyzed / universe.length : 1;
        const failureRate  = universe.length > 0 ? failed  / universe.length : 0;
        if (coverageRate < 0.85 || failureRate > 0.15) {
            try {
                await alertService.alertNightlyScanFailure({
                    analyzed, universe: universe.length, failed,
                    reason: failureRate > 0.15 ? 'High error rate — check data provider' : 'Low coverage'
                });
            } catch (_) {}
        }

        // ── Weekly drift check (Mondays only — avoids noisy daily runs) ──────────
        const etDay = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).getDay();
        if (etDay === 1) { // Monday
            const drift = await precomputedSvc.checkPrescreenDrift(7);
            if (drift) {
                console.log(`[NightlyScan] 📊 7-day drift: ${drift.prescreenCount} prescreened → ${drift.tradedCount} traded (${drift.conversionRate}%) | win rate: ${drift.winRate}% | avg P&L: $${drift.avgPnl}`);
                if (drift.conversionRate < 5 && drift.prescreenCount > 20) {
                    console.warn('[NightlyScan] ⚠️ Low conversion rate — prescreen threshold may be too strict or regime blocking entries');
                }
                if (drift.winRate < 40 && drift.tradedCount >= 5) {
                    console.warn('[NightlyScan] ⚠️ Low win rate on prescreened stocks — consider raising ai_score threshold');
                }
            }
        }

        console.log(`[NightlyScan] ── Complete in ${elapsedMin} min | analyzed: ${analyzed} | passed: ${passed} | filtered: ${filtered} | failed: ${failed} | new: ${newTickers.length} ──`);

        // ── Score decay monitor ──────────────────────────────────────────────────
        // For every user with open holdings, look up today's nightly score.
        // If a position's score fell below 60, send a Telegram alert to review/exit.
        setImmediate(async () => {
            try {
                const usersRes = await query(
                    `SELECT id FROM users WHERE ai_trading_enabled = true AND telegram_chat_id IS NOT NULL`
                );
                for (const u of usersRes.rows) {
                    const holdingsRes = await query(
                        `SELECT h.symbol, h.average_price, h.gain_loss_percent
                         FROM holdings h
                         WHERE h.user_id = $1 AND h.quantity > 0`,
                        [u.id]
                    );
                    if (holdingsRes.rows.length === 0) continue;

                    const symbols = holdingsRes.rows.map(h => h.symbol);
                    const scoresRes = await query(
                        `SELECT symbol, ai_score, recommendation
                         FROM daily_universe_analysis
                         WHERE analysis_date = $1 AND symbol = ANY($2)`,
                        [today, symbols]
                    );
                    const scoreMap = {};
                    for (const r of scoresRes.rows) scoreMap[r.symbol] = r;

                    const decayed = [];
                    for (const h of holdingsRes.rows) {
                        const scan = scoreMap[h.symbol];
                        if (scan && scan.ai_score !== null && scan.ai_score < 60) {
                            decayed.push({
                                symbol: h.symbol,
                                score: scan.ai_score,
                                rec: scan.recommendation,
                                glPct: parseFloat(h.gain_loss_percent || 0).toFixed(1)
                            });
                        }
                    }

                    if (decayed.length > 0) {
                        const lines = decayed.map(d =>
                            `  • ${d.symbol}: score ${d.score} (${d.rec}) | P&L ${d.glPct >= 0 ? '+' : ''}${d.glPct}%`
                        );
                        const msg = [
                            '⚠️ *SCORE DECAY ALERT*',
                            '',
                            'The following open positions scored below 60 in tonight\'s scan.',
                            'Review these for tightened stop or early exit:',
                            '',
                            ...lines,
                            '',
                            '_Sent by PANTHEON nightly scan_'
                        ].join('\n');
                        await alertService.sendMessage(u.id, msg);
                        console.log(`[NightlyScan] Score decay alert sent for user ${u.id}: ${decayed.map(d => d.symbol).join(', ')}`);
                    }
                }
            } catch (err) {
                console.warn('[NightlyScan] Score decay monitor failed (non-fatal):', err.message);
            }
        });

        // ── Background bar backfill ───────────────────────────────────────────────
        // Store OHLCV bars for every analyzed symbol so future scans and backtests
        // are served entirely from local daily_bars (zero Yahoo calls for history).
        // Runs after scan returns — never blocks the scan completion signal.
        setImmediate(async () => {
            try {
                const dailyBarsService = require('./dailyBarsService');
                // Only backfill symbols missing recent data (cutoff: 3 calendar days)
                const cutoff = new Date(Date.now() - 3 * 86400000);
                const freshRes = await query(
                    `SELECT DISTINCT symbol FROM daily_bars WHERE timestamp > $1`,
                    [cutoff]
                );
                const alreadyFresh = new Set(freshRes.rows.map(r => r.symbol));
                const toBackfill   = universe
                    .map(s => s.symbol)
                    .filter(s => !alreadyFresh.has(s));

                if (toBackfill.length > 0) {
                    console.log(`[NightlyScan] Queueing bar backfill for ${toBackfill.length} symbols`);
                    // 365 days of history — feeds the full 200-day SMA window
                    await dailyBarsService.backfillSymbols(toBackfill, 365, 400);
                    console.log(`[NightlyScan] Bar backfill complete`);
                } else {
                    console.log(`[NightlyScan] Bar cache up-to-date — no backfill needed`);
                }
            } catch (err) {
                console.warn('[NightlyScan] Bar backfill failed (non-fatal):', err.message);
            }
        });

        return { analyzed, passed, filtered, failed, newTickers, date: today, elapsedMin };

    } catch (err) {
        console.error('[NightlyScan] Fatal error:', err.message);
        // Fatal error alert
        try {
            await alertService.alertNightlyScanFailure({
                analyzed, universe: 0, failed, reason: `Fatal: ${err.message.slice(0, 100)}`
            });
        } catch (_) {}
        return { analyzed, passed, filtered, failed, date: today, error: err.message };
    } finally {
        _scanRunning = false;
    }
}

/**
 * Rescan a single symbol during market hours (news-triggered).
 * Unlike runNightlyUniverseScan, this is allowed during market hours.
 *
 * @param {string} symbol
 * @param {string} reason  — short description of why rescan was triggered
 * @returns {{ symbol, changed, prevRec, newRec, newScore, error }}
 */
async function rescanSymbol(symbol, reason = 'news') {
    const today = _todayET();
    try {
        const vixLevel = await getVixLevel().catch(() => 15);
        const analysis = await _analyzeWithRetry(symbol, vixLevel, null);
        if (!analysis) return { symbol, changed: false, reason: 'no_analysis' };

        // Read previous recommendation before overwriting
        const prev = await query(
            `SELECT recommendation, ai_score FROM daily_universe_analysis
             WHERE symbol = $1 AND analysis_date = $2`,
            [symbol, today]
        );
        const prevRec   = prev.rows[0]?.recommendation ?? null;
        const prevScore = parseFloat(prev.rows[0]?.ai_score) ?? null;

        // Merge rescan metadata so existing nightly fields are preserved
        const rescanMeta = {
            rescanAt:          new Date().toISOString(),
            rescanReason:      reason.slice(0, 120),
            prevRecommendation: prevRec,
            prevScore
        };
        await query(
            `INSERT INTO daily_universe_analysis
                 (symbol, analysis_date, ai_score, recommendation, setup_family,
                  sector, market_cap, passed_prescreen, metadata)
             VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8::jsonb)
             ON CONFLICT (symbol, analysis_date) DO UPDATE SET
                 ai_score       = EXCLUDED.ai_score,
                 recommendation = EXCLUDED.recommendation,
                 setup_family   = EXCLUDED.setup_family,
                 sector         = EXCLUDED.sector,
                 market_cap     = EXCLUDED.market_cap,
                 passed_prescreen = true,
                 metadata       = COALESCE(daily_universe_analysis.metadata, '{}') || EXCLUDED.metadata,
                 updated_at     = NOW()`,
            [
                symbol, today,
                analysis.aiScore       ?? null,
                analysis.recommendation ?? null,
                analysis.setupFamily   ?? null,
                analysis.sector        ?? null,
                analysis.marketCap     ?? null,
                JSON.stringify(rescanMeta)
            ]
        );

        const changed = !!(prevRec && prevRec !== analysis.recommendation);
        return { symbol, changed, prevRec, newRec: analysis.recommendation, newScore: analysis.aiScore };
    } catch (err) {
        return { symbol, changed: false, error: err.message };
    }
}

/**
 * Re-attempts analysis for a specific list of symbols against a specific
 * historical analysis_date (not always "today" like rescanSymbol/missingOnly),
 * using the same retry + prescreen logic as the main scan loop. For backfilling
 * a night's symbols that came back null — usually a transient data-provider
 * blip rather than genuinely missing data — without re-running the full universe.
 * Reuses the main scan's one-at-a-time, 10s-apart pacing to avoid re-triggering
 * the exact rate-limit cascade that caused the original failures.
 */
async function rescanFailedSymbols(date, symbols) {
    const vixLevel = await getVixLevel().catch(() => 15);
    const regime   = await marketRegimeService.getMarketRegime().catch(() => null);
    let analyzed = 0, passed = 0, filtered = 0, stillFailed = 0;
    const results = [];

    for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        try {
            const analysis = await _analyzeWithRetry(symbol, vixLevel, regime);
            if (!analysis) {
                await _upsert(symbol, date, null, false, 'analyzeStockWithAI returned null (rescan)');
                stillFailed++;
                results.push({ symbol, ok: false });
            } else {
                const passedPrescreen =
                    (analysis.recommendation === 'STRONG BUY' || analysis.recommendation === 'BUY') &&
                    analysis.aiScore >= 70;
                const exclusionReason = passedPrescreen ? null : `${analysis.recommendation} / score ${analysis.aiScore}`;
                await _upsert(symbol, date, analysis, passedPrescreen, exclusionReason);
                if (passedPrescreen) { passed++; } else { filtered++; }
                analyzed++;
                results.push({ symbol, ok: true, score: analysis.aiScore, recommendation: analysis.recommendation });
            }
        } catch (err) {
            await _upsert(symbol, date, null, false, (err.message || 'unknown error').slice(0, 200)).catch(() => {});
            stillFailed++;
            results.push({ symbol, ok: false, error: err.message });
        }

        console.log(`[NightlyScan] Rescan ${i + 1}/${symbols.length} | analyzed: ${analyzed} | passed: ${passed} | filtered: ${filtered} | stillFailed: ${stillFailed}`);
        if (i < symbols.length - 1) {
            await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
    }

    return { date, attempted: symbols.length, analyzed, passed, filtered, stillFailed, results };
}

module.exports = { runNightlyUniverseScan, rescanSymbol, rescanFailedSymbols, isScanRunning };
