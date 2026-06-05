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

// One symbol at a time with a 6-second pause — ~10 stocks/min.
// After-hours accuracy matters more than speed; this keeps Yahoo Finance
// well under its rate limit and virtually eliminates 429 null returns.
const BATCH_SIZE     = 1;
const BATCH_DELAY_MS = 6_000;

let _scanRunning = false;

/**
 * Calls analyzeStockWithAI with retry on null result, 429 rate-limits, or any transient error.
 *
 * Retry schedule (maxRetries = 2 → up to 3 total attempts):
 *   null result  → wait 12s then 24s  (soft failure — data not ready yet)
 *   429 error    → wait 30s then 60s  (rate limit — needs longer cool-down)
 *   other error  → wait 12s then 24s  (transient — network blip, timeout, etc.)
 *
 * Returns null only after all retries are exhausted.
 */
async function _analyzeWithRetry(symbol, vixLevel, regime, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await analyzeStockWithAI(symbol, vixLevel, null, regime);

            if (result != null) return result; // success

            // analyzeStockWithAI returned null — retry with a pause
            if (attempt < maxRetries) {
                const waitMs = 12_000 * (attempt + 1);
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
            const waitMs = is429 ? 30_000 * (attempt + 1) : 12_000 * (attempt + 1);
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
 * Upserts one analysis row into daily_universe_analysis.
 */
async function _upsert(symbol, date, analysis, passedPrescreen, exclusionReason) {
    await query(
        `INSERT INTO daily_universe_analysis
             (symbol, analysis_date, ai_score, recommendation, setup_family,
              sector, market_cap, passed_prescreen, exclusion_reason, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (symbol, analysis_date) DO UPDATE SET
             ai_score         = EXCLUDED.ai_score,
             recommendation   = EXCLUDED.recommendation,
             setup_family     = EXCLUDED.setup_family,
             sector           = EXCLUDED.sector,
             market_cap       = EXCLUDED.market_cap,
             passed_prescreen = EXCLUDED.passed_prescreen,
             exclusion_reason = EXCLUDED.exclusion_reason,
             metadata         = EXCLUDED.metadata,
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
 * Main entry point — call from scheduler or standalone script.
 * Safe to call concurrently: skips if a scan is already in progress.
 *
 * @returns {{ analyzed, passed, filtered, failed, date, elapsedMin }}
 */
async function runNightlyUniverseScan() {
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

    console.log(`[NightlyScan] ── Starting nightly universe scan for ${today} ──`);

    let analyzed = 0, passed = 0, filtered = 0, failed = 0;

    try {
        // Use the static symbol list — no Yahoo Finance calls for universe discovery.
        // getStockUniverse() hits Yahoo for every symbol to get price/volume data,
        // which floods the rate limit before AI analysis even starts.
        // analyzeStockWithAI() fetches its own data per-ticker at a safe throttled rate.
        const [symbolList, vixLevel, regime] = await Promise.all([
            marketScreenerService.getStockOnlySymbolList(), // ETFs excluded — analyzeStockWithAI returns null for them
            getVixLevel(),
            marketRegimeService.getMarketRegime()
        ]);
        // Wrap as minimal objects so the rest of the loop only needs symbol strings
        const universe = symbolList.map(sym => ({ symbol: sym }));

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

                        // Pre-screen: accept STRONG BUY or BUY above an absolute floor.
                        // The live scan applies the user's minBuyScore; overnight we use a
                        // lower floor (70) so borderline candidates aren't lost prematurely.
                        const passedPrescreen =
                            (analysis.recommendation === 'STRONG BUY' || analysis.recommendation === 'BUY') &&
                            analysis.aiScore >= 70;

                        const exclusionReason = passedPrescreen
                            ? null
                            : `${analysis.recommendation} / score ${analysis.aiScore}`;

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
                const usersRes = await query(
                    `SELECT id FROM users WHERE ai_trading_enabled = true AND telegram_chat_id IS NOT NULL`
                );
                for (const u of usersRes.rows) {
                    await alertService.alertNightlyScanFailure(u.id, {
                        analyzed, universe: universe.length, failed,
                        reason: failureRate > 0.15 ? 'High error rate — check data provider' : 'Low coverage'
                    });
                }
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

        return { analyzed, passed, filtered, failed, newTickers, date: today, elapsedMin };

    } catch (err) {
        console.error('[NightlyScan] Fatal error:', err.message);
        // Fatal error alert
        try {
            const usersRes = await query(`SELECT id FROM users WHERE ai_trading_enabled = true AND telegram_chat_id IS NOT NULL`);
            for (const u of usersRes.rows) {
                await alertService.alertNightlyScanFailure(u.id, {
                    analyzed, universe: 0, failed, reason: `Fatal: ${err.message.slice(0, 100)}`
                });
            }
        } catch (_) {}
        return { analyzed, passed, filtered, failed, date: today, error: err.message };
    } finally {
        _scanRunning = false;
    }
}

module.exports = { runNightlyUniverseScan };
