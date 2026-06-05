/**
 * Ollama Backtest Intelligence Service
 * ======================================
 * Uses local llama3.2:3b to generate professional-grade trading insights
 * from the bot's actual trade history stored in PostgreSQL.
 *
 * Architecture:
 *   1. Pull structured stats from trade_decision_journal + trades + ai_performance_metrics
 *   2. Compute quantitative metrics (win rate by setup/regime/score band/sector/hold days)
 *   3. Feed pre-computed stats to Ollama — not raw data (keeps prompt small, reasoning sharp)
 *   4. Return actionable recommendations to improve bot performance
 *
 * Runs entirely locally — zero API cost.
 */

const { query }         = require('../config/database');
const dailyBarsService  = require('./dailyBarsService');
const { logger }        = require('../utils/logger');

const BASE_URL   = process.env.OLLAMA_BASE_URL || '';
const MODEL      = process.env.OLLAMA_MODEL    || 'llama3.2:3b';
// Streaming mode is used, so TIMEOUT_MS only governs idle silence between tokens
const TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '30000', 10); // 30s idle timeout per chunk

// ── Stat Builders ──────────────────────────────────────────────────────────────

/**
 * Build comprehensive statistics from trade_decision_journal + trades tables.
 * Returns structured object ready for Ollama prompt.
 */
async function buildTradeStats(userId) {
    // ── 1. Closed trade pairs (BUY matched with SELL) ──────────────────────
    const tradesResult = await query(`
        SELECT symbol, action, quantity::float, price::float, ai_score,
               sector, trade_date
        FROM trades
        WHERE user_id = $1
        ORDER BY trade_date ASC
    `, [userId]);

    const allTrades = tradesResult.rows;
    const pairs = matchTradePairs(allTrades);

    // ── 2. Trade decision journal (richer metadata per executed trade) ──────
    // NOTE: decision_phase = 'EXECUTED' (not 'EXECUTION').
    // pnl is NOT stored in the journal — matched from trade pairs below.
    const journalResult = await query(`
        SELECT symbol, setup_family, strategy_family, regime, score::float,
               score_adjustment::float, confidence::float, metadata, created_at
        FROM trade_decision_journal
        WHERE user_id = $1 AND decision_phase = 'EXECUTED'
        ORDER BY created_at ASC
    `, [userId]);
    // Build a lookup: symbol → latest journal entry (setup_family, regime)
    const journalBySymbol = {};
    journalResult.rows.forEach(j => { journalBySymbol[j.symbol] = j; });

    // Enrich trade pairs with journal metadata where available
    pairs.forEach(p => {
        const j = journalBySymbol[p.symbol];
        if (j) {
            p.setupFamily = j.setup_family || p.setupFamily;
            p.regime      = j.regime       || 'NEUTRAL';
            p.metaData    = j.metadata;
            p.scoringLog  = j.metadata?.scoringLog || [];
        }
    });

    // Also get candidates (scored but not bought — to see what bot skipped)
    const candidateResult = await query(`
        SELECT setup_family, regime, score::float, metadata
        FROM trade_decision_journal
        WHERE user_id = $1 AND decision_phase = 'CANDIDATE'
        ORDER BY created_at DESC LIMIT 200
    `, [userId]);
    const candidates = candidateResult.rows;

    // ── 3. Daily performance metrics ───────────────────────────────────────
    const dailyResult = await query(`
        SELECT date, win_rate::float, total_profit_loss::float,
               sharpe_ratio::float, market_regime, total_trades
        FROM ai_performance_metrics
        WHERE user_id = $1
        ORDER BY date ASC
    `, [userId]);
    const dailyMetrics = dailyResult.rows;

    // ── 4. Aggregate stats ────────────────────────────────────────────────
    // pairs now have setupFamily + regime enriched from journal where available

    // By setup family
    const bySetup = groupBy(pairs.map(p => ({
        setup_family: p.setupFamily || 'untracked',
        pnl_percent: p.returnPercent,
        pnl: p.profitLoss,
        score: p.aiScore
    })), 'setup_family');

    // By regime
    const byRegime = groupBy(pairs.map(p => ({
        regime: p.regime || 'NEUTRAL',
        pnl_percent: p.returnPercent,
        pnl: p.profitLoss
    })), 'regime');

    // By sector
    const bySector = groupBy(pairs.map(p => ({
        sector: p.sector && p.sector !== 'Unknown' ? p.sector : 'Untracked',
        pnl_percent: p.returnPercent,
        pnl: p.profitLoss
    })), 'sector');

    // By AI score band (uses ai_score from trades table — always available)
    const byScoreBand = buildScoreBandStats(
        pairs.map(p => ({ score: p.aiScore || 70, pnl: p.profitLoss, pnlPct: p.returnPercent }))
    );

    // Hold duration buckets
    const byHoldDays = buildHoldBuckets(pairs);

    // Scoring log pattern analysis — build journal-like objects from enriched pairs
    const journalLike = pairs.map(p => ({
        pnl: p.profitLoss,
        pnl_percent: p.returnPercent,
        metadata: p.metaData || { scoringLog: p.scoringLog || [] },
    }));
    const scoringPatterns = analyseScoreLogs(journalLike);

    // News sentiment correlation
    const newsCorrelation = analyseNewsSentiment(journalLike);

    // ATR-based stop analysis (were exits triggered optimally?)
    const stopAnalysis = await analyseStopsWithATR(pairs);

    // SPY benchmark
    const spyBench = await getSPYBenchmark(allTrades);

    // Overall
    const overall = buildOverallStats(pairs);

    return {
        overall,
        bySetup: formatGroupStats(bySetup),
        byRegime: formatGroupStats(byRegime),
        bySector: formatGroupStats(bySector),
        byScoreBand,
        byHoldDays,
        scoringPatterns,
        newsCorrelation,
        stopAnalysis,
        spyBench,
        totalCandidates: candidates.length,
        candidateAvgScore: avg(candidates.map(c => c.score)),
        openPositions: allTrades.filter(t => t.action === 'BUY').length -
                       allTrades.filter(t => t.action === 'SELL').length,
        tradingPeriod: {
            start: allTrades[0]?.trade_date,
            end: allTrades[allTrades.length - 1]?.trade_date,
        },
    };
}

// ── Statistical Helpers ────────────────────────────────────────────────────────

function matchTradePairs(trades) {
    const bySymbol = {};
    trades.forEach(t => {
        if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
        bySymbol[t.symbol].push(t);
    });
    const pairs = [];
    Object.entries(bySymbol).forEach(([symbol, symTrades]) => {
        const buys  = symTrades.filter(t => t.action === 'BUY').sort((a, b) => new Date(a.trade_date) - new Date(b.trade_date));
        const sells = symTrades.filter(t => t.action === 'SELL').sort((a, b) => new Date(a.trade_date) - new Date(b.trade_date));
        sells.forEach(sell => {
            const buy = buys.find(b => new Date(b.trade_date) <= new Date(sell.trade_date));
            if (!buy) return;
            const buyPrice  = parseFloat(buy.price);
            const sellPrice = parseFloat(sell.price);
            const qty       = parseFloat(sell.quantity);
            const pnl       = (sellPrice - buyPrice) * qty;
            const pnlPct    = ((sellPrice - buyPrice) / buyPrice) * 100;
            const holdDays  = Math.ceil((new Date(sell.trade_date) - new Date(buy.trade_date)) / 86400000);
            pairs.push({
                symbol,
                buyPrice, sellPrice, qty, pnl, returnPercent: pnlPct,
                profitLoss: pnl,
                holdDays,
                aiScore:    buy.ai_score,
                sector:     buy.sector,
                setupFamily: null,
                buyDate:    buy.trade_date,
                sellDate:   sell.trade_date,
            });
        });
    });
    return pairs;
}

function groupBy(arr, field) {
    const map = {};
    arr.forEach(item => {
        const key = item[field] || 'unknown';
        if (!map[key]) map[key] = [];
        map[key].push(item);
    });
    return map;
}

function formatGroupStats(groups) {
    return Object.entries(groups).map(([key, items]) => {
        const pnls   = items.map(i => parseFloat(i.pnl_percent || i.pnl || 0));
        const wins   = pnls.filter(p => p > 0);
        const losses = pnls.filter(p => p <= 0);
        return {
            key,
            trades:  items.length,
            winRate: items.length ? ((wins.length / items.length) * 100).toFixed(1) : '0.0',
            avgPnl:  avg(pnls).toFixed(2),
            totalPnl: pnls.reduce((s, v) => s + v, 0).toFixed(2),
            bestTrade:  Math.max(...pnls, 0).toFixed(2),
            worstTrade: Math.min(...pnls, 0).toFixed(2),
        };
    }).sort((a, b) => parseFloat(b.totalPnl) - parseFloat(a.totalPnl));
}

function buildScoreBandStats(trades) {
    const bands = [
        { label: '60-64', min: 60, max: 64 },
        { label: '65-69', min: 65, max: 69 },
        { label: '70-74', min: 70, max: 74 },
        { label: '75-79', min: 75, max: 79 },
        { label: '80+',   min: 80, max: 100 },
    ];
    return bands.map(band => {
        const inBand = trades.filter(t => t.score >= band.min && t.score <= band.max);
        if (!inBand.length) return null;
        const pnls = inBand.map(t => parseFloat(t.pnlPct || t.pnl || 0));
        const wins = pnls.filter(p => p > 0);
        return {
            band: band.label,
            trades: inBand.length,
            winRate: ((wins.length / inBand.length) * 100).toFixed(1),
            avgPnl:  avg(pnls).toFixed(2),
        };
    }).filter(Boolean);
}

function buildHoldBuckets(pairs) {
    const buckets = [
        { label: '1 day',    min: 0,  max: 1  },
        { label: '2-3 days', min: 2,  max: 3  },
        { label: '4-7 days', min: 4,  max: 7  },
        { label: '1-2 wks',  min: 8,  max: 14 },
        { label: '2-4 wks',  min: 15, max: 28 },
        { label: '1+ month', min: 29, max: 999 },
    ];
    return buckets.map(b => {
        const items = pairs.filter(p => p.holdDays >= b.min && p.holdDays <= b.max);
        if (!items.length) return null;
        const pnls = items.map(i => i.returnPercent);
        const wins = pnls.filter(p => p > 0);
        return {
            period:  b.label,
            trades:  items.length,
            winRate: ((wins.length / items.length) * 100).toFixed(1),
            avgPnl:  avg(pnls).toFixed(2),
        };
    }).filter(Boolean);
}

function analyseScoreLogs(journal) {
    // Count which scoring components appear in winning vs losing trades
    const winners = journal.filter(j => parseFloat(j.pnl || 0) > 0);
    const losers  = journal.filter(j => parseFloat(j.pnl || 0) <= 0);

    const countComponent = (trades, component) =>
        trades.filter(t => {
            const log = t.metadata?.scoringLog || [];
            return log.some(l => l.includes(component) && !l.includes('0 ('));
        }).length;

    const components = ['RSI', 'MACD', 'Momentum', 'BB', 'RelStrength', '52wkHigh', 'Pattern', 'ORACLE'];
    return components.map(c => ({
        component: c,
        winnerPresence: winners.length ? ((countComponent(winners, c) / winners.length) * 100).toFixed(0) + '%' : 'N/A',
        loserPresence:  losers.length  ? ((countComponent(losers, c)  / losers.length)  * 100).toFixed(0) + '%' : 'N/A',
    }));
}

function analyseNewsSentiment(journal) {
    const withNews    = journal.filter(j => (j.metadata?.newsSentiment || 0) > 0);
    const withoutNews = journal.filter(j => (j.metadata?.newsSentiment || 0) <= 0);
    const pnlAvg = arr => arr.length ? avg(arr.map(j => parseFloat(j.pnl_percent || 0))).toFixed(2) : 'N/A';
    return {
        withPositiveNews:    { count: withNews.length,    avgPnl: pnlAvg(withNews) },
        withoutPositiveNews: { count: withoutNews.length, avgPnl: pnlAvg(withoutNews) },
    };
}

async function analyseStopsWithATR(pairs) {
    if (!pairs.length) return null;
    // Sample up to 10 pairs to check if stop-losses were ATR-calibrated
    const sample = pairs.filter(p => p.profitLoss < 0).slice(0, 10);
    let tooTightCount = 0, tooWideCount = 0;
    for (const p of sample) {
        try {
            const atr = await dailyBarsService.getATR(p.symbol, 14);
            if (!atr) continue;
            const stopDistance = Math.abs(p.buyPrice - p.sellPrice);
            // Ideal stop = 1.5–2.5× ATR
            if (stopDistance < atr * 1.2) tooTightCount++;
            if (stopDistance > atr * 3.0) tooWideCount++;
        } catch { /* skip */ }
    }
    return {
        losersAnalysed: sample.length,
        stopsTooTight: tooTightCount,
        stopsTooWide:  tooWideCount,
        recommendation: tooTightCount > tooWideCount
            ? 'Stops are too tight — increase to 1.5–2× ATR'
            : tooWideCount > tooTightCount
            ? 'Stops are too wide — tighten to 1.5–2× ATR'
            : 'Stop sizing appears appropriate',
    };
}

async function getSPYBenchmark(trades) {
    if (!trades.length) return null;
    const start = trades[0]?.trade_date;
    const end   = trades[trades.length - 1]?.trade_date;
    try {
        const bars = await dailyBarsService.getBars('SPY', 365);
        if (bars.length < 2) return null;
        const startBar = bars.find(b => new Date(b.timestamp) >= new Date(start));
        const endBar   = bars[bars.length - 1];
        if (!startBar || !endBar) return null;
        const spyReturn = ((parseFloat(endBar.close) - parseFloat(startBar.close)) / parseFloat(startBar.close) * 100).toFixed(2);
        return { startDate: start, endDate: end, spyReturn: parseFloat(spyReturn) };
    } catch { return null; }
}

function buildOverallStats(pairs) {
    if (!pairs.length) return { totalTrades: 0 };
    const wins   = pairs.filter(p => p.profitLoss > 0);
    const losses = pairs.filter(p => p.profitLoss <= 0);
    const totalPnl = pairs.reduce((s, p) => s + p.profitLoss, 0);
    const winPnl   = wins.reduce((s, p) => s + p.profitLoss, 0);
    const lossPnl  = Math.abs(losses.reduce((s, p) => s + p.profitLoss, 0));
    const rets     = pairs.map(p => p.returnPercent);
    const avgRet   = avg(rets);
    const stdDev   = Math.sqrt(avg(rets.map(r => Math.pow(r - avgRet, 2))));

    // Max drawdown on equity curve
    let peak = 0, maxDD = 0, equity = 0;
    pairs.sort((a, b) => new Date(a.sellDate) - new Date(b.sellDate)).forEach(p => {
        equity += p.profitLoss;
        if (equity > peak) peak = equity;
        const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
        if (dd > maxDD) maxDD = dd;
    });

    return {
        totalTrades:  pairs.length,
        wins:         wins.length,
        losses:       losses.length,
        winRate:      ((wins.length / pairs.length) * 100).toFixed(1),
        avgWinPct:    wins.length   ? avg(wins.map(p => p.returnPercent)).toFixed(2)   : '0',
        avgLossPct:   losses.length ? avg(losses.map(p => p.returnPercent)).toFixed(2) : '0',
        totalPnl:     totalPnl.toFixed(2),
        profitFactor: lossPnl > 0 ? (winPnl / lossPnl).toFixed(2) : winPnl > 0 ? '∞' : '0',
        sharpe:       stdDev > 0 ? (avgRet / stdDev).toFixed(2) : '0',
        maxDrawdown:  maxDD.toFixed(1),
        avgHoldDays:  avg(pairs.map(p => p.holdDays)).toFixed(1),
        largestWin:   Math.max(...pairs.map(p => p.returnPercent), 0).toFixed(2),
        largestLoss:  Math.min(...pairs.map(p => p.returnPercent), 0).toFixed(2),
    };
}

function avg(arr) {
    if (!arr.length) return 0;
    return arr.reduce((s, v) => s + (parseFloat(v) || 0), 0) / arr.length;
}

// ── Ollama Insight Engine ──────────────────────────────────────────────────────

/**
 * Send pre-computed stats to Ollama using STREAMING mode.
 * Streaming avoids socket timeout — data flows as tokens are generated.
 * TIMEOUT_MS only applies to silence between individual chunks.
 */
async function getOllamaInsights(stats) {
    if (!BASE_URL) return { error: 'Ollama not configured', available: false };

    const prompt = buildAnalysisPrompt(stats);
    logger.info(`[OllamaBacktest] Prompt length: ${prompt.length} chars — sending to ${MODEL} (streaming)`);

    try {
        const url     = new URL('/api/chat', BASE_URL);
        const payload = JSON.stringify({
            model:  MODEL,
            stream: true,   // ← streaming: tokens arrive progressively, no socket idle timeout
            messages: [
                {
                    role: 'system',
                    content: 'You are a quantitative trading analyst. Review the bot performance data and give specific, numbered recommendations. Be concise and use exact numbers from the data.'
                },
                { role: 'user', content: prompt }
            ],
            options: { temperature: 0.25, num_predict: 800 },
        });

        const http = require('http');
        const analysis = await new Promise((resolve, reject) => {
            const reqOptions = {
                hostname: url.hostname,
                port:     parseInt(url.port) || 11434,
                path:     url.pathname,
                method:   'POST',
                headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            };

            const req = http.request(reqOptions, res => {
                let fullText  = '';
                let idleTimer = null;

                function resetIdle() {
                    if (idleTimer) clearTimeout(idleTimer);
                    idleTimer = setTimeout(() => {
                        req.destroy();
                        if (fullText.length > 100) {
                            // Partial result is still useful
                            resolve(fullText + '\n[response truncated — idle timeout]');
                        } else {
                            reject(new Error('Ollama idle timeout — no tokens received'));
                        }
                    }, TIMEOUT_MS);
                }

                resetIdle();

                res.on('data', chunk => {
                    resetIdle();
                    const lines = chunk.toString().split('\n').filter(Boolean);
                    for (const line of lines) {
                        try {
                            const parsed = JSON.parse(line);
                            if (parsed.message?.content) fullText += parsed.message.content;
                            if (parsed.done) {
                                clearTimeout(idleTimer);
                                resolve(fullText);
                            }
                        } catch { /* incomplete JSON line — continue */ }
                    }
                });

                res.on('end', () => {
                    clearTimeout(idleTimer);
                    if (fullText) resolve(fullText);
                    else reject(new Error('Ollama: empty streaming response'));
                });

                res.on('error', err => { clearTimeout(idleTimer); reject(err); });
            });

            req.on('error', err => reject(new Error(`Ollama connection failed: ${err.message}`)));
            req.write(payload);
            req.end();
        });

        logger.info(`[OllamaBacktest] Analysis complete — ${analysis.length} chars`);
        return { available: true, analysis, model: MODEL, generatedAt: new Date().toISOString() };

    } catch (err) {
        logger.warn(`[OllamaBacktest] Analysis failed: ${err.message}`);
        return { available: false, error: err.message };
    }
}

function buildAnalysisPrompt(stats) {
    const { overall, bySetup, byRegime, byScoreBand,
            byHoldDays, stopAnalysis, spyBench, tradingPeriod } = stats;

    const period = tradingPeriod?.start
        ? `${new Date(tradingPeriod.start).toDateString()} → ${new Date(tradingPeriod.end).toDateString()}`
        : 'recent period';

    const spyLine = spyBench
        ? `SPY return: ${spyBench.spyReturn}% | Bot P&L: $${overall.totalPnl}`
        : `Bot total P&L: $${overall.totalPnl}`;

    // Compact prompt — keeps token count low for llama3.2:3b
    return [
        `TRADING BOT PERFORMANCE (${period}):`,
        `Overall: ${overall.totalTrades} trades | WinRate ${overall.winRate}% | PF ${overall.profitFactor} | Sharpe ${overall.sharpe} | MaxDD ${overall.maxDrawdown}%`,
        `P&L: $${overall.totalPnl} | AvgWin +${overall.avgWinPct}% | AvgLoss ${overall.avgLossPct}% | AvgHold ${overall.avgHoldDays}d`,
        spyLine,
        '',
        'SCORE BANDS (score → winrate, avgPnL):',
        byScoreBand.map(b => `  ${b.band}: ${b.trades}tr ${b.winRate}% ${b.avgPnl}%`).join(' | ') || '  n/a',
        '',
        'HOLD DURATION (days → winrate, avgPnL):',
        byHoldDays.map(h => `  ${h.period}: ${h.trades}tr ${h.winRate}% ${h.avgPnl}%`).join(' | ') || '  n/a',
        '',
        bySetup.length > 1 ? 'SETUP FAMILY:\n' + bySetup.map(s => `  ${s.key}: ${s.trades}tr ${s.winRate}% ${s.avgPnl}%`).join('\n') : '',
        byRegime.length > 1 ? 'REGIME:\n' + byRegime.map(r => `  ${r.key}: ${r.trades}tr ${r.winRate}% ${r.avgPnl}%`).join('\n') : '',
        stopAnalysis ? `STOPS: ${stopAnalysis.recommendation}` : '',
        '',
        'Give 6 numbered recommendations to improve this trading bot (be specific, use numbers):',
        '1. Biggest issue hurting performance',
        '2. Best edge to exploit more',
        '3. Ideal minimum AI score threshold',
        '4. Best hold duration range',
        '5. Stop-loss improvement',
        '6. One regime-specific rule change',
    ].filter(Boolean).join('\n').trim();
}

// ── Main Export ────────────────────────────────────────────────────────────────

/**
 * Full AI-powered backtest analysis.
 * Steps: pull stats → compute metrics → Ollama insights → return combined report.
 *
 * @param {string} userId
 * @returns {Promise<object>}
 */
async function getAIBacktestAnalysis(userId) {
    logger.info(`[OllamaBacktest] Starting AI analysis for user ${userId}`);
    const start = Date.now();

    try {
        // Step 1: Build statistics from DB
        const stats = await buildTradeStats(userId);

        if (!stats.overall.totalTrades) {
            return {
                hasData: false,
                message: 'No completed trades found. Execute and close some positions to generate analysis.',
            };
        }

        // Step 2: Backfill daily_bars for traded symbols in background (non-blocking)
        const tradedSymbols = await dailyBarsService.getTradedSymbols();
        dailyBarsService.backfillSymbols(['SPY', ...tradedSymbols], 365, 500)
            .catch(e => logger.warn('[OllamaBacktest] Background backfill failed:', e.message));

        // Step 3: Get Ollama insights
        const ollamaResult = await getOllamaInsights(stats);

        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        logger.info(`[OllamaBacktest] Analysis done in ${elapsed}s`);

        return {
            hasData: true,
            generatedAt: new Date().toISOString(),
            elapsedSeconds: parseFloat(elapsed),
            stats,
            ollamaAnalysis: ollamaResult,
        };

    } catch (err) {
        logger.error('[OllamaBacktest] Fatal error', { error: err.message });
        throw err;
    }
}

module.exports = { getAIBacktestAnalysis, buildTradeStats };
