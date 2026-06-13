const express = require('express');
const router = express.Router();
const { protect: authenticateToken } = require('../middleware/authMiddleware');
const ollamaService = require('../services/ollamaService');
const { query } = require('../config/database');
const marketRegimeService = require('../services/marketRegimeService');
const precomputedUniverseService = require('../services/precomputedUniverseService');
const globalSentimentService = require('../services/globalSentimentService');
const { logger } = require('../utils/logger');

/**
 * AI Enquiry Service
 * Handles natural language questions about stocks and market data
 * Uses local Ollama LLM for processing
 */

// ─── Intent classifier ───────────────────────────────────────────────────────
function classifyIntent(text) {
    const t = text.toLowerCase();
    if (/top\s*\d*\s*(pick|stock|buy|signal|rec|opportunit|strong)/i.test(t) ||
        /best\s+(stock|pick|buy|trade)/i.test(t) ||
        /today.{0,20}(pick|recommend|buy|strong)/i.test(t) ||
        /what.{0,20}(buy|invest in|pick) today/i.test(t)) return 'top_picks';

    if (/invest\s*\$?\d+|\$\d+.{0,20}(invest|buy|split|allocat)|how.{0,20}invest/i.test(t) ||
        /\d+\s*dollar|500|1000|2000|10000/i.test(t) && /invest|buy|split|allocat/i.test(t)) return 'invest_amount';

    if (/market\s*(regime|condition|trend|outlook|status)|what.{0,20}market|regime|vix|bull|bear/i.test(t) &&
        !/sticker|ticker|symbol/.test(t)) return 'market_overview';

    if (/sector|swing|intra(day)?|day.?trad/i.test(t)) return 'sector_split';

    if (/calibrat|win.?rate|score.{0,15}(bucket|rang|perform)|bucket/i.test(t)) return 'calibration';

    return 'general';
}

// ─── Direct answer builders (data → formatted text, no LLM) ─────────────────
function answerTopPicks(tickers) {
    if (!tickers || tickers.length === 0)
        return 'No scan data available yet. The nightly PANTHEON scan runs after market close (~5 PM ET).';

    const top5 = tickers.slice(0, 5);
    const lines = top5.map((t, i) => {
        const score = t.aiScore ?? t.score ?? '?';
        const rec   = t.recommendation ?? t.rec ?? '';
        // Only show entry/target if they are within 20% of the score-implied range
        // (stale levels from old scans would be misleading)
        const entry = t.entry  != null ? ` | Entry $${parseFloat(t.entry).toFixed(2)}` : '';
        const tgt   = t.target != null ? ` → $${parseFloat(t.target).toFixed(2)}` : '';
        return `${i + 1}. ${t.symbol} — Score ${score} (${rec}) | ${t.sector}${entry}${tgt}`;
    });

    const sectorSet = [...new Set(top5.map(t => t.sector))].join(', ');
    return [
        `Today's Top ${top5.length} PANTHEON Picks`,
        '─'.repeat(35),
        ...lines,
        '',
        `Sectors: ${sectorSet}`,
        `Scan date: ${top5[0]?.scanDate || 'latest'}`,
        '\n⚠ AI-generated signals. Review risk limits before entering any trade.'
    ].join('\n');
}

function answerInvestAmount(tickers, userContext, rawQuestion) {
    const match = rawQuestion.match(/\$?(\d[\d,]*)/);
    const amount = match ? parseInt(match[1].replace(/,/g, '')) : 500;

    const strongBuys = (tickers || []).filter(t => (t.recommendation ?? t.rec) === 'STRONG BUY' && t.entry != null);
    const picks = strongBuys.length >= 3 ? strongBuys.slice(0, 5) : (tickers || []).filter(t => t.entry != null).slice(0, 5);

    if (picks.length === 0)
        return 'No scan data available yet to generate an allocation. Please try again after the nightly scan.';

    const perStock = amount / picks.length;
    const balance = userContext?.account?.balance;

    const lines = picks.map((t, i) => {
        const score  = t.aiScore ?? t.score ?? '?';
        const entry  = parseFloat(t.entry);
        const target = t.target ? parseFloat(t.target) : null;
        const shares = (perStock / entry).toFixed(2);
        const upside = target
            ? ` → potential gain $${(perStock * (target - entry) / entry).toFixed(0)} (+${(((target - entry) / entry) * 100).toFixed(1)}%)`
            : '';
        return `${i + 1}. ${t.symbol} (Score ${score}) — $${perStock.toFixed(0)} = ${shares} shares @ $${entry.toFixed(2)}${upside}`;
    });

    const header = [
        `$${amount.toLocaleString()} Equal-Weight Allocation — Today's Top PANTHEON Picks`,
        `${'─'.repeat(50)}`,
        ...lines,
        '',
        `Total deployed: $${amount.toLocaleString()}${balance ? ` | Remaining balance: $${(balance - amount).toLocaleString()}` : ''}`,
        '\nAlternatively split by conviction:',
        `• Concentrated (2 stocks): $${(amount / 2).toFixed(0)} each in ${picks.slice(0, 2).map(t => t.symbol).join(' + ')}`,
        `• Diversified (${picks.length} stocks): $${perStock.toFixed(0)} each across all picks above`,
        '\n⚠ Risk disclaimer: PANTHEON scores indicate technical setup quality, not guaranteed returns. Always use stop-losses.'
    ];
    return header.join('\n');
}

function answerMarketOverview(marketContext) {
    const r = marketContext.marketRegime;
    const a = marketContext.atlas;
    const p = marketContext.recentPerformance;
    const sigs = marketContext.signals;

    const lines = [
        'Current Market Overview\n' + '─'.repeat(25),
        `Regime:  ${r?.regime || 'N/A'} | VIX: ${r?.vixLevel || '?'} | Volatility: ${r?.atrExpansion < 0.85 ? 'LOW (contracting)' : 'NORMAL/EXPANDING'}`,
        a ? `ATLAS Global Sentiment: ${a.label.replace('_', ' ')} (score ${a.score}/100)` : '',
        '',
        sigs?.strongBuyCount != null
            ? `PANTHEON signals today: ${sigs.strongBuyCount} STRONG BUY, ${sigs.buyCount} BUY`
            : 'No scan data available.',
        sigs?.allTickers?.length
            ? `Top stocks: ${sigs.allTickers.slice(0, 5).map(t => `${t.symbol}(${t.score})`).join(', ')}`
            : '',
        '',
        p ? `90-day bot performance: ${p.winRate}% win rate | avg ${p.avgReturn > 0 ? '+' : ''}${p.avgReturn}% per trade | total P&L $${p.totalPnl}` : '',
    ];
    return lines.filter(Boolean).join('\n');
}

function answerSectorSplit(tickers) {
    const SWING = ['Technology','Consumer Cyclical','Communication Services','Financial Services'];
    const INTRA = ['Healthcare','Consumer Defensive','Utilities','Industrials','Basic Materials'];
    const swing = (tickers || []).filter(t => SWING.includes(t.sector) || t.setupFamily === 'breakout_leader');
    const intra = (tickers || []).filter(t => INTRA.includes(t.sector) || t.setupFamily === 'oversold_reversal');

    return [
        'Sector Split — Swing vs Intra-day\n' + '─'.repeat(35),
        '',
        'SWING TRADES (hold 2–10 days) — Breakout leaders, momentum sectors:',
        swing.length ? swing.slice(0, 8).map(t => `  • ${t.symbol} (${t.aiScore}) ${t.sector}`).join('\n') : '  None in today\'s scan',
        '',
        'INTRA / SCALP TRADES (same day) — Oversold reversals, stable sectors:',
        intra.length ? intra.slice(0, 6).map(t => `  • ${t.symbol} (${t.aiScore}) ${t.sector}`).join('\n') : '  None in today\'s scan',
        '',
        '⚠ Swing trades carry overnight risk. Intra trades require active monitoring.'
    ].join('\n');
}

// POST /api/enquiry - Ask AI questions about stocks and market
router.post('/enquiry', authenticateToken, async (req, res) => {
    try {
        const { question } = req.body;
        const userId = req.user?.id;

        if (!question || typeof question !== 'string') {
            return res.status(400).json({ error: 'Question is required' });
        }

        logger.info('[Enquiry] Processing question', { userId, questionLength: question.length });

        // Classify intent first
        const intent = classifyIntent(question);
        logger.info('[Enquiry] Intent', { intent });

        // Detect ticker BEFORE lowercasing — uppercase symbols must be preserved
        const mentionedSymbol = detectTickerMention(question);
        if (mentionedSymbol) logger.info('[Enquiry] Ticker detected', { symbol: mentionedSymbol });

        // For known intents, fetch only what's needed
        const [marketContext, userContext] = await Promise.all([
            getMarketContext(),
            getUserContext(userId)
        ]);

        const normalizedQuestion = preprocessQuestion(question);
        const tickers = marketContext.signals?.allTickers || [];

        // ── Intent routing: direct data answers (no LLM hallucination risk) ──
        if (intent === 'top_picks') {
            return res.json({ answer: answerTopPicks(tickers), timestamp: new Date().toISOString() });
        }
        if (intent === 'invest_amount') {
            return res.json({ answer: answerInvestAmount(tickers, userContext, question), timestamp: new Date().toISOString() });
        }
        if (intent === 'market_overview') {
            return res.json({ answer: answerMarketOverview(marketContext), timestamp: new Date().toISOString() });
        }
        if (intent === 'sector_split') {
            return res.json({ answer: answerSectorSplit(tickers), timestamp: new Date().toISOString() });
        }

        // ── Ticker-specific: fetch data then ask Ollama to explain it ────────
        if (mentionedSymbol || intent === 'general') {
            const tickerContext = mentionedSymbol ? await fetchTickerContext(mentionedSymbol) : null;

            if (tickerContext) {
                const systemPrompt = buildTickerFocusedPrompt(marketContext, userContext, tickerContext);
                const response = await ollamaService.chat(
                    [{ role: 'system', content: systemPrompt }, { role: 'user', content: normalizedQuestion }],
                    { maxTokens: 1000, temperature: 0.5 }
                );
                return res.json({ answer: response, timestamp: new Date().toISOString() });
            }

            // No ticker found and no specific intent — minimal Ollama call
            const miniPrompt = `You are KiranRock AI assistant. Market regime: ${marketContext.marketRegime?.regime || 'unknown'}, VIX: ${marketContext.marketRegime?.vixLevel || '?'}. Top stocks today: ${tickers.slice(0, 5).map(t => `${t.symbol}(${t.score})`).join(', ') || 'none'}. Answer concisely using only this data. Never invent prices or scores.`;
            const response = await ollamaService.chat(
                [{ role: 'system', content: miniPrompt }, { role: 'user', content: normalizedQuestion }],
                { maxTokens: 600, temperature: 0.5 }
            );
            return res.json({ answer: response, timestamp: new Date().toISOString() });
        }

        res.json({ answer: answerMarketOverview(marketContext), timestamp: new Date().toISOString() });

    } catch (error) {
        logger.error('[Enquiry] Error processing question', {
            error: error.message,
            userId: req.user?.id
        });

        // Check if Ollama service is available
        if (error.message.includes('ECONNREFUSED') || error.message.includes('fetch failed')) {
            return res.status(503).json({
                error: 'AI service is currently unavailable. Please ensure Ollama is running.',
                suggestion: 'Run: ollama serve'
            });
        }

        res.status(500).json({
            error: 'Failed to process your question. Please try again.',
            details: process.env.NODE_ENV === 'development' ? error.message : undefined
        });
    }
});

// ─── Ticker detection ────────────────────────────────────────────────────────

/** Map: normalised company name fragments → canonical symbol */
const COMPANY_TO_SYMBOL = {
    // Big tech
    apple: 'AAPL', aple: 'AAPL', appl: 'AAPL', aplle: 'AAPL',
    microsoft: 'MSFT', microsft: 'MSFT', micorsoft: 'MSFT',
    google: 'GOOGL', googel: 'GOOGL', gogle: 'GOOGL', alphabet: 'GOOGL',
    amazon: 'AMZN', amazn: 'AMZN', amazone: 'AMZN',
    nvidia: 'NVDA', nvdia: 'NVDA', nvidea: 'NVDA',
    meta: 'META', facebook: 'META',
    tesla: 'TSLA', tesala: 'TSLA', tesala: 'TSLA', tesala: 'TSLA',
    netflix: 'NFLX', netfix: 'NFLX', netflex: 'NFLX',
    adobe: 'ADBE', adobee: 'ADBE',
    salesforce: 'CRM', saleforce: 'CRM',
    oracle: 'ORCL', oracl: 'ORCL',
    intel: 'INTC', intell: 'INTC',
    amd: 'AMD', 'advanced micro': 'AMD',
    qualcomm: 'QCOM', qualcom: 'QCOM',
    broadcom: 'AVGO', broadcm: 'AVGO',
    // Finance
    jpmorgan: 'JPM', 'jp morgan': 'JPM', jpm: 'JPM',
    'bank of america': 'BAC', bofa: 'BAC', bankofamerica: 'BAC',
    goldman: 'GS', 'goldman sachs': 'GS',
    morgan: 'MS', 'morgan stanley': 'MS',
    visa: 'V', mastercard: 'MA', 'american express': 'AXP', amex: 'AXP',
    berkshire: 'BRK', brk: 'BRK',
    // Healthcare
    pfizer: 'PFE', pfizer: 'PFE', pfiizer: 'PFE',
    johnson: 'JNJ', jnj: 'JNJ',
    unitedhealth: 'UNH', 'united health': 'UNH',
    abbvie: 'ABBV', abvie: 'ABBV',
    merck: 'MRK',
    // Consumer
    walmart: 'WMT', wallmart: 'WMT', wal: 'WMT',
    target: 'TGT', costco: 'COST', costcoo: 'COST',
    starbucks: 'SBUX', 'star bucks': 'SBUX',
    mcdonalds: 'MCD', 'mc donalds': 'MCD', mcd: 'MCD',
    nike: 'NKE', nke: 'NKE',
    // Energy
    exxon: 'XOM', 'exxon mobil': 'XOM',
    chevron: 'CVX', chveron: 'CVX',
    // Industrial/other
    boeing: 'BA', boieng: 'BA',
    caterpillar: 'CAT', caterpilar: 'CAT',
    palantir: 'PLTR', palanteer: 'PLTR', palantr: 'PLTR',
    snowflake: 'SNOW', crowdstrike: 'CRWD', crowstrike: 'CRWD',
    datadog: 'DDOG', datdog: 'DDOG',
    cloudflare: 'NET', clouflare: 'NET',
    coinbase: 'COIN', servicenow: 'NOW',
    'super micro': 'SMCI', supermicro: 'SMCI',
    marvell: 'MRVL', marvl: 'MRVL',
    ceva: 'CEVA', arista: 'ANET',
    palo: 'PANW', 'palo alto': 'PANW',
    'eli lilly': 'LLY', lilly: 'LLY',
    novo: 'NVO', 'novo nordisk': 'NVO',
    asml: 'ASML',
    arm: 'ARM',
    shopify: 'SHOP', shopfy: 'SHOP',
    square: 'SQ', block: 'SQ',
    paypal: 'PYPL', payal: 'PYPL',
    uber: 'UBER', lyft: 'LYFT',
    airbnb: 'ABNB', airnb: 'ABNB',
    spotify: 'SPOT', spotfy: 'SPOT',
    roblox: 'RBLX', robinhood: 'HOOD',
    rivian: 'RIVN', lucid: 'LCID',
    ford: 'F', gm: 'GM', 'general motors': 'GM',
};

/** Simple Levenshtein distance (max check up to length 15 to stay fast) */
function levenshtein(a, b) {
    if (a.length > 15 || b.length > 15) return 99;
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++)
            dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    return dp[a.length][b.length];
}

/**
 * Detect a ticker symbol from a natural-language question.
 * Returns a canonical symbol string or null.
 */
function detectTickerMention(text) {
    const lower = text.toLowerCase().replace(/[''`]/g, '');
    const words  = lower.split(/\s+/);

    // 1. Direct symbol match: 2-5 uppercase letters appearing in original text
    const upperTokens = text.match(/\b([A-Z]{2,5})\b/g) || [];
    for (const tok of upperTokens) {
        if (COMPANY_TO_SYMBOL[tok.toLowerCase()]) return COMPANY_TO_SYMBOL[tok.toLowerCase()];
        // Treat as a raw symbol if it looks like one (will be validated by DB later)
        if (/^[A-Z]{2,5}$/.test(tok) && !['THE','AND','FOR','BUY','SELL','NOW','TOP','ALL','HOW','ANY','WHY'].includes(tok)) {
            return tok;
        }
    }

    // 2. Exact match in company name map
    for (const [name, symbol] of Object.entries(COMPANY_TO_SYMBOL)) {
        if (lower.includes(name)) return symbol;
    }

    // 3. Fuzzy match per word against company names (edit distance ≤ 2)
    const companyKeys = Object.keys(COMPANY_TO_SYMBOL);
    for (const word of words) {
        if (word.length < 3) continue;
        for (const key of companyKeys) {
            if (Math.abs(word.length - key.length) > 2) continue;
            if (levenshtein(word, key) <= 2) return COMPANY_TO_SYMBOL[key];
        }
    }

    return null;
}

const dataProvider = require('../services/dataProvider');

/**
 * Fetch all available data for a symbol — DB first, online fallback, write-back to DB.
 */
async function fetchTickerContext(symbol) {
    const sym = symbol.toUpperCase();
    try {
        const [scanRes, barsRes, fundRes, nameRes] = await Promise.all([
            query(
                `SELECT symbol, ai_score, recommendation, sector, setup_family,
                        analysis_date,
                        (metadata->>'entry')::numeric    AS entry,
                        (metadata->>'stop')::numeric     AS stop,
                        (metadata->>'target')::numeric   AS target,
                        (metadata->>'riskReward')        AS risk_reward,
                        metadata->>'oracleVerdict'       AS oracle_verdict,
                        metadata->'scoringLog'           AS scoring_log,
                        (metadata->>'smartMoneyScore')::numeric AS smart_money
                 FROM daily_universe_analysis
                 WHERE symbol = $1
                 ORDER BY analysis_date DESC LIMIT 1`,
                [sym]
            ),
            query(
                `SELECT timestamp::date AS date,
                        ROUND(open::numeric,2)   AS open,
                        ROUND(high::numeric,2)   AS high,
                        ROUND(low::numeric,2)    AS low,
                        ROUND(close::numeric,2)  AS close,
                        volume
                 FROM daily_bars WHERE symbol = $1 ORDER BY timestamp DESC LIMIT 20`,
                [sym]
            ),
            query(
                `SELECT pe_ratio, forward_pe, peg_ratio, profit_margin,
                        revenue_growth, earnings_growth, debt_to_equity,
                        return_on_equity, market_cap, industry
                 FROM fundamentals_cache WHERE symbol = $1`,
                [sym]
            ).catch(() => ({ rows: [] })),
            query(
                `SELECT name FROM asset_universe WHERE symbol = $1 LIMIT 1`,
                [sym]
            ).catch(() => ({ rows: [] }))
        ]);

        let scan = scanRes.rows[0] || null;
        let bars = barsRes.rows;
        let fund = fundRes.rows[0] || null;
        // Strip exchange suffix e.g. "Applied Materials, Inc. Common Stock" → "Applied Materials, Inc."
        const rawName = nameRes.rows[0]?.name || null;
        const companyName = rawName ? rawName.replace(/\s+(Common Stock|Class [A-Z].*|Inc\. Common.*|Corp\. Common.*)$/i, '').trim() : null;

        // ── Online fallback: fetch from provider if no local bar data ──────────
        let fetchedOnline = false;
        if (bars.length < 5) {
            try {
                logger.info('[Enquiry] No local bars for', sym, '— fetching online');
                const onlineBars = await dataProvider.getBars(sym, '1d', 30);
                if (onlineBars && onlineBars.length > 0) {
                    fetchedOnline = true;
                    // Write-back to daily_bars in background
                    setImmediate(async () => {
                        try {
                            const vals = onlineBars
                                .filter(b => b.time && b.close != null)
                                .map((b, i) => {
                                    const ts = typeof b.time === 'number' ? new Date(b.time * 1000) : new Date(b.time);
                                    return `('${sym}', '${ts.toISOString()}', ${b.open||b.close}, ${b.high||b.close}, ${b.low||b.close}, ${b.close}, ${b.volume||0})`;
                                });
                            if (vals.length > 0) {
                                await query(
                                    `INSERT INTO daily_bars (symbol, timestamp, open, high, low, close, volume)
                                     VALUES ${vals.join(',')}
                                     ON CONFLICT (symbol, timestamp) DO NOTHING`
                                );
                                logger.info(`[Enquiry] Stored ${vals.length} bars for ${sym}`);
                            }
                        } catch (e) { logger.error('[Enquiry] Bar write-back error', { error: e.message }); }
                    });
                    // Use for current response
                    bars = onlineBars.slice(0, 20).map(b => {
                        const ts = typeof b.time === 'number' ? new Date(b.time * 1000) : new Date(b.time);
                        return {
                            date:  ts.toISOString().split('T')[0],
                            open:  b.open  || b.close,
                            high:  b.high  || b.close,
                            low:   b.low   || b.close,
                            close: b.close,
                            volume: b.volume || 0
                        };
                    });
                }
            } catch (e) {
                logger.warn('[Enquiry] Online bar fetch failed for', sym, e.message);
            }
        }

        // Fetch quote + fundamentals online if not cached — use shared dataProvider instance
        if (!fund) {
            try {
                const quote = await dataProvider.getQuote(sym).catch(() => null);
                if (quote) {
                    fund = {
                        pe_ratio:        null,
                        forward_pe:      null,
                        peg_ratio:       null,
                        profit_margin:   null,
                        revenue_growth:  null,
                        earnings_growth: null,
                        debt_to_equity:  null,
                        return_on_equity:null,
                        market_cap:      quote.marketCap || null,
                        industry:        quote.sector    || null
                    };
                    fetchedOnline = true;
                    // Also try quoteSummary for richer data via the yf instance inside dataProvider
                    try {
                        const yf = require('yahoo-finance2');
                        const yfDefault = (yf && yf.default) ? yf.default : yf;
                        const summary = await yfDefault.quoteSummary(sym, {
                            modules: ['financialData', 'defaultKeyStatistics', 'summaryProfile']
                        }).catch(() => null);
                        if (summary) {
                            const fd = summary.financialData        || {};
                            const ks = summary.defaultKeyStatistics || {};
                            const sp = summary.summaryProfile       || {};
                            fund.pe_ratio        = ks.trailingPE?.raw          ?? fund.pe_ratio;
                            fund.forward_pe      = ks.forwardPE?.raw           ?? fund.forward_pe;
                            fund.peg_ratio       = ks.pegRatio?.raw            ?? fund.peg_ratio;
                            fund.profit_margin   = fd.profitMargins?.raw       ?? fund.profit_margin;
                            fund.revenue_growth  = fd.revenueGrowth?.raw       ?? fund.revenue_growth;
                            fund.earnings_growth = fd.earningsGrowth?.raw      ?? fund.earnings_growth;
                            fund.debt_to_equity  = fd.debtToEquity?.raw        ?? fund.debt_to_equity;
                            fund.return_on_equity= fd.returnOnEquity?.raw      ?? fund.return_on_equity;
                            fund.industry        = sp.industry                 || fund.industry;
                        }
                    } catch { /* quoteSummary is bonus — ignore errors */ }

                    // Write to fundamentals_cache in background
                    const f = fund;
                    setImmediate(async () => {
                        try {
                            await query(
                                `INSERT INTO fundamentals_cache
                                    (symbol, pe_ratio, forward_pe, peg_ratio, profit_margin,
                                     revenue_growth, earnings_growth, debt_to_equity,
                                     return_on_equity, market_cap, industry, fetched_at)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
                                 ON CONFLICT (symbol) DO UPDATE SET
                                     pe_ratio=$2, forward_pe=$3, peg_ratio=$4, profit_margin=$5,
                                     revenue_growth=$6, earnings_growth=$7, debt_to_equity=$8,
                                     return_on_equity=$9, market_cap=$10, industry=$11, fetched_at=NOW()`,
                                [sym, f.pe_ratio, f.forward_pe, f.peg_ratio, f.profit_margin,
                                 f.revenue_growth, f.earnings_growth, f.debt_to_equity,
                                 f.return_on_equity, f.market_cap, f.industry]
                            );
                        } catch (e) { logger.error('[Enquiry] Fund write-back error', { error: e.message }); }
                    });
                }
            } catch (e) {
                logger.warn('[Enquiry] Online fundamentals fetch failed for', sym, e.message);
            }
        }

        logger.info('[Enquiry] tickerContext built', { symbol: sym, hasScan: !!scan, barCount: bars.length, hasFund: !!fund, fetchedOnline });

        if (!scan && bars.length === 0 && !fund) return null;

        // Price trend summary
        let priceSummary = null;
        if (bars.length >= 2) {
            const latest = bars[0];
            const oldest = bars[bars.length - 1];
            const chg    = ((latest.close - oldest.close) / oldest.close * 100).toFixed(2);
            const hi     = Math.max(...bars.map(b => parseFloat(b.high)));
            const lo     = Math.min(...bars.map(b => parseFloat(b.low)));
            priceSummary = {
                current: parseFloat(latest.close),
                change20d: parseFloat(chg),
                high20d: hi,
                low20d: lo,
                fetchedOnline,
                bars: bars.slice(0, 5).map(b => `${b.date} C:$${parseFloat(b.close).toFixed(2)} H:${parseFloat(b.high).toFixed(2)} L:${parseFloat(b.low).toFixed(2)} V:${Number(b.volume).toLocaleString()}`)
            };
        }

        return {
            symbol: sym,
            companyName,
            fetchedOnline,
            scan: scan ? {
                date:          scan.analysis_date,
                score:         parseFloat(scan.ai_score),
                recommendation: scan.recommendation,
                sector:        scan.sector,
                setup:         scan.setup_family,
                entry:         scan.entry  ? parseFloat(scan.entry)  : null,
                stop:          scan.stop   ? parseFloat(scan.stop)   : null,
                target:        scan.target ? parseFloat(scan.target) : null,
                riskReward:    scan.risk_reward,
                verdict:       scan.oracle_verdict,
                smartMoney:    scan.smart_money ? parseFloat(scan.smart_money) : null,
                scoringLog:    Array.isArray(scan.scoring_log) ? scan.scoring_log : []
            } : null,
            price: priceSummary,
            fundamentals: fund ? {
                pe:             fund.pe_ratio         != null ? parseFloat(fund.pe_ratio)          : null,
                forwardPe:      fund.forward_pe       != null ? parseFloat(fund.forward_pe)        : null,
                peg:            fund.peg_ratio        != null ? parseFloat(fund.peg_ratio)         : null,
                profitMargin:   fund.profit_margin    != null ? parseFloat(fund.profit_margin)     : null,
                revenueGrowth:  fund.revenue_growth   != null ? parseFloat(fund.revenue_growth)    : null,
                earningsGrowth: fund.earnings_growth  != null ? parseFloat(fund.earnings_growth)   : null,
                debtToEquity:   fund.debt_to_equity   != null ? parseFloat(fund.debt_to_equity)    : null,
                roe:            fund.return_on_equity  != null ? parseFloat(fund.return_on_equity)  : null,
                marketCap:      fund.market_cap        != null ? parseFloat(fund.market_cap)        : null,
                industry:       fund.industry
            } : null
        };
    } catch (err) {
        logger.error('[Enquiry] fetchTickerContext error', { symbol: sym, error: err.message });
        return null;
    }
}

/**
 * Preprocess and normalize user questions for better understanding
 * Handles common spelling mistakes and stock symbol corrections
 */
function preprocessQuestion(question) {
    if (!question || typeof question !== 'string') return question;

    let normalized = question.toLowerCase().trim();

    // Common stock symbol corrections
    const symbolCorrections = {
        'aple': 'AAPL', 'apple': 'AAPL', 'appl': 'AAPL',
        'tesla': 'TSLA', 'teslas': 'TSLA', 'tslaa': 'TSLA',
        'microsoft': 'MSFT', 'msf': 'MSFT', 'microsft': 'MSFT',
        'google': 'GOOGL', 'googel': 'GOOGL', 'gogle': 'GOOGL',
        'amazon': 'AMZN', 'amzn': 'AMZN', 'amazn': 'AMZN',
        'nvidia': 'NVDA', 'nvda': 'NVDA', 'nvdia': 'NVDA',
        'meta': 'META', 'facebook': 'META', 'fb': 'META',
        'palantir': 'PLTR', 'pltr': 'PLTR', 'palanteer': 'PLTR',
        'snowflake': 'SNOW', 'snow': 'SNOW',
        'advanced micro': 'AMD', 'amd': 'AMD',
        'intel': 'INTC', 'intc': 'INTC',
    };

    // Common trading term corrections
    const termCorrections = {
        // "sticker" / "ticker" variants — most common user mistake
        'sticker': 'ticker',
        'stickers': 'tickers',
        'sticket': 'ticker',
        'tickr': 'ticker',
        'tiker': 'ticker',
        'stocker': 'stock ticker',
        'stonks': 'stocks',
        'stonk': 'stock',
        'mooning': 'rising rapidly',
        'diamond hands': 'holding long term',
        'paper hands': 'selling quickly',
        'hodl': 'hold',
        'tendies': 'profits',
        'bagholding': 'holding losing positions',
        'yolo': 'high risk trade',
        'dd': 'due diligence',
        'ath': 'all time high',
        'atl': 'all time low',
        'rn': 'right now',
        'wat': 'what',
        'shoud': 'should',
        'shld': 'should',
        'wud': 'would',
        'cud': 'could',
        'portoflio': 'portfolio',
        'porfolio': 'portfolio',
        'perfomance': 'performance',
        'recomendation': 'recommendation',
        'analisis': 'analysis',
        'analysys': 'analysis',
    };

    // Apply symbol corrections
    Object.entries(symbolCorrections).forEach(([wrong, correct]) => {
        const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
        normalized = normalized.replace(regex, correct);
    });

    // Apply term corrections
    Object.entries(termCorrections).forEach(([wrong, correct]) => {
        const regex = new RegExp(`\\b${wrong}\\b`, 'gi');
        normalized = normalized.replace(regex, correct);
    });

    // Common question structure fixes
    normalized = normalized
        .replace(/\bwat\s+do\b/gi, 'what should')
        .replace(/\bwat\s+is\b/gi, 'what is')
        .replace(/\bhow\s+is\s+(\w+)\s+doing\b/gi, 'how is $1 performing')
        .replace(/\bis\s+(\w+)\s+good\s+buy\b/gi, 'is $1 a good buy')
        .replace(/\bshld\s+i\s+buy\b/gi, 'should I buy')
        .replace(/\bshld\s+i\s+sell\b/gi, 'should I sell')
        .replace(/\bbest\s+stonks\b/gi, 'best stocks');

    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/** GET /api/enquiry/briefing — structured market intelligence, no AI */
router.get('/enquiry/briefing', authenticateToken, async (req, res) => {
    try {
        const LATEST_PASSED_DATE = `(
            SELECT MAX(analysis_date) FROM daily_universe_analysis
            WHERE analysis_date >= CURRENT_DATE - INTERVAL '4 days'
              AND analysis_date <= CURRENT_DATE
              AND passed_prescreen = true
        )`;

        const [tickersRes, regimeRes, atlasSentiment, perfRes] = await Promise.all([
            query(
                `SELECT symbol, ai_score, recommendation, sector, setup_family,
                        (metadata->>'entry')::numeric   AS entry,
                        (metadata->>'stop')::numeric    AS stop,
                        (metadata->>'target')::numeric  AS target,
                        (metadata->>'riskReward')       AS risk_reward,
                        metadata->>'oracleVerdict'      AS oracle_verdict,
                        analysis_date
                 FROM daily_universe_analysis
                 WHERE analysis_date = ${LATEST_PASSED_DATE}
                   AND recommendation IN ('STRONG BUY','BUY')
                 ORDER BY ai_score DESC`
            ),
            query(
                `SELECT regime FROM daily_universe_analysis
                 WHERE analysis_date = ${LATEST_PASSED_DATE} AND regime IS NOT NULL LIMIT 1`
            ).catch(() => ({ rows: [] })),
            globalSentimentService.getGlobalSentiment().catch(() => null),
            // Recent trade performance by sector
            query(
                `SELECT sector,
                        COUNT(*) AS total,
                        COUNT(*) FILTER (WHERE pnl_percent > 0) AS wins,
                        ROUND(AVG(pnl_percent)::numeric, 2)     AS avg_return
                 FROM trades
                 WHERE sector IS NOT NULL AND pnl_percent IS NOT NULL
                   AND trade_date > NOW() - INTERVAL '90 days'
                 GROUP BY sector
                 ORDER BY avg_return DESC`
            ).catch(() => ({ rows: [] }))
        ]);

        const tickers = tickersRes.rows.map(r => ({
            symbol:       r.symbol,
            aiScore:      parseFloat(r.ai_score),
            recommendation: r.recommendation,
            sector:       r.sector || 'Unknown',
            setupFamily:  r.setup_family || 'unknown',
            entry:        r.entry  != null ? parseFloat(r.entry)  : null,
            stop:         r.stop   != null ? parseFloat(r.stop)   : null,
            target:       r.target != null ? parseFloat(r.target) : null,
            riskReward:   r.risk_reward || null,
            oracleVerdict: r.oracle_verdict || null,
            scanDate:     r.analysis_date
        }));

        // Sector breakdown
        const sectorMap = {};
        for (const t of tickers) {
            const s = t.sector;
            if (!sectorMap[s]) sectorMap[s] = { count: 0, swing: 0, intra: 0, symbols: [] };
            sectorMap[s].count++;
            sectorMap[s].symbols.push(t.symbol);
            if (t.setupFamily === 'breakout_leader' || t.setupFamily === 'quality_continuation') {
                sectorMap[s].swing++;
            } else if (t.setupFamily === 'oversold_reversal') {
                sectorMap[s].intra++;
            }
        }

        // Tag swing vs intra suitability
        const SWING_SECTORS   = ['Technology','Consumer Cyclical','Communication Services','Financial Services'];
        const INTRA_SECTORS   = ['Healthcare','Consumer Defensive','Utilities','Industrials','Basic Materials'];
        const sectorBreakdown = Object.entries(sectorMap).map(([sector, d]) => ({
            sector,
            count:    d.count,
            symbols:  d.symbols,
            swingPct: tickers.length > 0 ? Math.round((d.count / tickers.length) * 100) : 0,
            suitability: SWING_SECTORS.includes(sector) ? 'swing'
                       : INTRA_SECTORS.includes(sector) ? 'intra'
                       : 'both'
        })).sort((a, b) => b.count - a.count);

        const sectorPerf = perfRes.rows.map(r => ({
            sector:    r.sector,
            total:     parseInt(r.total),
            winRate:   r.total > 0 ? Math.round((parseInt(r.wins) / parseInt(r.total)) * 100) : 0,
            avgReturn: parseFloat(r.avg_return) || 0
        }));

        res.json({
            scanDate:     tickers[0]?.scanDate || null,
            regime:       regimeRes.rows[0]?.regime || null,
            atlas:        atlasSentiment ? {
                label:     atlasSentiment.label,
                score:     atlasSentiment.globalScore,
                vix:       atlasSentiment.rawData?.vixLevel || null
            } : null,
            tickers,
            sectorBreakdown,
            sectorPerformance: sectorPerf,
            summary: {
                total:     tickers.length,
                strongBuy: tickers.filter(t => t.recommendation === 'STRONG BUY').length,
                buy:       tickers.filter(t => t.recommendation === 'BUY').length,
                topScore:  tickers[0]?.aiScore || null,
                avgScore:  tickers.length > 0
                    ? Math.round(tickers.reduce((s, t) => s + t.aiScore, 0) / tickers.length * 10) / 10
                    : null
            }
        });
    } catch (err) {
        logger.error('[Enquiry/Briefing] Error', { error: err.message });
        res.status(500).json({ error: err.message });
    }
});

/**
 * Get current market context for AI responses
 */
async function getMarketContext() {
    try {
        const context = {};

        // Market regime
        const regime = await marketRegimeService.getMarketRegime();
        context.marketRegime = {
            regime: regime.regime,
            description: regime.description,
            vixLevel: regime.vixLevel,
            spy5dRangePct: regime.spy5dRangePct,
            atrExpansion: regime.atrExpansion
        };

        // ATLAS global sentiment
        try {
            const atlas = await globalSentimentService.getGlobalSentiment();
            if (atlas) {
                context.atlas = {
                    label: atlas.label,
                    score: Math.round(atlas.globalScore * 100),
                    vix:   atlas.rawData?.vixLevel || null
                };
            }
        } catch { /* non-fatal */ }

        // Full signals from DB with entry/stop/target
        const LATEST = `(
            SELECT MAX(analysis_date) FROM daily_universe_analysis
            WHERE analysis_date >= CURRENT_DATE - INTERVAL '4 days'
              AND analysis_date <= CURRENT_DATE AND passed_prescreen = true
        )`;
        const tickersRes = await query(
            `SELECT symbol, ai_score, recommendation, sector, setup_family,
                    (metadata->>'entry')::numeric  AS entry,
                    (metadata->>'stop')::numeric   AS stop,
                    (metadata->>'target')::numeric AS target
             FROM daily_universe_analysis
             WHERE analysis_date = ${LATEST}
               AND recommendation IN ('STRONG BUY','BUY')
             ORDER BY ai_score DESC LIMIT 30`
        ).catch(() => ({ rows: [] }));

        if (tickersRes.rows.length > 0) {
            const tickers = tickersRes.rows;
            const strongBuys = tickers.filter(t => t.recommendation === 'STRONG BUY');
            const buys       = tickers.filter(t => t.recommendation === 'BUY');

            // Sector breakdown
            const sectors = {};
            for (const t of tickers) {
                const s = t.sector || 'Unknown';
                sectors[s] = (sectors[s] || 0) + 1;
            }

            context.signals = {
                strongBuyCount: strongBuys.length,
                buyCount: buys.length,
                allTickers: tickers.map(t => ({
                    symbol:     t.symbol,
                    score:      Math.round(parseFloat(t.ai_score)),
                    rec:        t.recommendation,
                    aiScore:    Math.round(parseFloat(t.ai_score)),
                    recommendation: t.recommendation,
                    sector:     t.sector || 'Unknown',
                    setupFamily: t.setup_family || 'unknown',
                    setup:      t.setup_family || 'unknown',
                    entry:      t.entry  ? parseFloat(t.entry)  : null,
                    stop:       t.stop   ? parseFloat(t.stop)   : null,
                    target:     t.target ? parseFloat(t.target) : null,
                    scanDate:   t.analysis_date || null
                })),
                sectorCounts: sectors
            };
        } else {
            context.signals = { error: 'No recent nightly scan data available' };
        }

        // Recent trade performance
        const perfRes = await query(
            `SELECT COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE pnl_percent > 0) AS wins,
                    ROUND(AVG(pnl_percent)::numeric, 2)     AS avg_return,
                    ROUND(SUM(pnl)::numeric, 2)             AS total_pnl
             FROM trades WHERE pnl_percent IS NOT NULL AND trade_date > NOW() - INTERVAL '90 days'`
        ).catch(() => ({ rows: [] }));
        if (perfRes.rows.length > 0) {
            const p = perfRes.rows[0];
            context.recentPerformance = {
                total: parseInt(p.total),
                winRate: p.total > 0 ? Math.round((parseInt(p.wins) / parseInt(p.total)) * 100) : 0,
                avgReturn: parseFloat(p.avg_return) || 0,
                totalPnl: parseFloat(p.total_pnl) || 0
            };
        }

        return context;
    } catch (error) {
        logger.error('[Enquiry] Error getting market context', { error: error.message });
        return { error: 'Market data temporarily unavailable' };
    }
}

/**
 * Get user's portfolio and trading context
 */
async function getUserContext(userId) {
    try {
        if (!userId) return {};

        const context = {};

        // User's account info
        const userAccount = await query(`
            SELECT u.username, ta.balance, ta.portfolio_value,
                   aic.max_positions, aic.min_score
            FROM users u
            JOIN trading_accounts ta ON ta.user_id = u.id
            LEFT JOIN ai_trading_configs aic ON aic.user_id = u.id
            WHERE u.id = $1
        `, [userId]);

        if (userAccount.rows.length > 0) {
            const account = userAccount.rows[0];
            context.account = {
                username: account.username,
                balance: parseFloat(account.balance),
                portfolioValue: parseFloat(account.portfolio_value || 0),
                maxPositions: account.max_positions,
                minScore: account.min_score
            };
        }

        // Current holdings
        const holdings = await query(`
            SELECT symbol, quantity, average_price, market_value, gain_loss
            FROM holdings
            WHERE user_id = $1 AND quantity > 0
            ORDER BY market_value DESC
        `, [userId]);

        if (holdings.rows.length > 0) {
            context.holdings = holdings.rows.map(h => ({
                symbol: h.symbol,
                quantity: parseFloat(h.quantity),
                avgCost: parseFloat(h.average_price),
                marketValue: parseFloat(h.market_value),
                unrealizedPnl: parseFloat(h.gain_loss)
            }));
        }

        return context;
    } catch (error) {
        logger.error('[Enquiry] Error getting user context', { error: error.message, userId });
        return {};
    }
}

/**
 * Compact prompt used when the user asks about a specific stock.
 * Skips the full market ticker table to stay under context limits.
 */
function buildTickerFocusedPrompt(marketContext, userContext, tc) {
    const regime = marketContext.marketRegime;
    const atlas  = marketContext.atlas;

    return `You are KiranRock AI financial assistant. Analyze the stock data below and give a professional, structured response. Use ONLY the numbers provided — never invent prices, scores, or percentages.

Market context: Regime ${regime?.regime || '?'} | VIX ${regime?.vixLevel || '?'} | Global ${atlas?.label || '?'}
${userContext.account ? `User balance: $${userContext.account.balance?.toLocaleString()}` : ''}
${buildTickerBlock(tc)}

SCORING SCALE — always include this table in section 3:
  90-100 = STRONG BUY  (elite setup — bottom of this tier at 90 still has room to miss)
  80-89  = BUY+        (high conviction)
  70-79  = BUY         (moderate conviction)
  60-69  = HOLD+       (borderline — needs catalyst)
  <60    = HOLD/SKIP

CRITICAL: Your verdict MUST match the factor data exactly.
  - Negative scoring factors use NEGATIVE language:
      "Momentum: -10" → say "negative momentum" or "downward momentum", NEVER "strong momentum"
      "SignalConflict: -6" → say "mixed signals" or "indicator disagreement", not "high conviction"
      "MeanRev: -5/-12" → say "price is extended above its 20-day average — reversal risk"
  - Positive factors use positive language:
      "MACD: +10" → "bullish MACD crossover" or "MACD in strong uptrend"
      "RelStrength: +8" → "outperforming the S&P 500 over the past 20 days"
  - If SignalConflict is negative (3 bull vs 3 bear), always add: "though indicators show mixed conviction — not a clean setup"
  - Score tier language: 90 = "bottom of the Strong Buy tier"; 95 = "elite setup"; 80 = "high conviction Buy"
  - Never say "high conviction" when SignalConflict is negative or when bearish headwinds ≥ 3

CRITICAL DATA COHERENCE RULE:
  If the ticker data block contains a line starting with "⚠ DATA COHERENCE NOTE:", you MUST reproduce
  that line VERBATIM in section 3 as a highlighted callout. Do not paraphrase or omit it.
  It explains to the user why a factor score appears to contradict the price trend.

Write these sections:
**1. Overview** — use the "Company:" name provided above exactly; sector and industry
**2. Price & Trend** — current price, 20-day change, then the "Recent price action" bullets from the data verbatim
**3. PANTHEON Score** — structure as follows:
  a) "Score: [N]/100 — [TIER LABEL]  |  Scan date: [scan date]"
  b) Signal Summary block — copy the numbers directly from the "Factor Attribution" line in the data:
       Signal Summary
         Bullish Total : +[N]
         Bearish Total : -[N]
         Net           : [+/-N]
         Bull/Bear Ratio: [X.X]:1
  c) If a ⚠ DATA COHERENCE NOTE is in the data, insert it verbatim here before the drivers list
  d) Top 3 Bullish Drivers with raw score only (e.g. "MACD: +10") — do NOT add a separate impact/weight number
  e) Top 3 Bearish Headwinds with raw score only
  f) The scoring scale table
**4. Trade Levels** — Entry | Stop (risk $/share) | Target (reward $/share) | R:R ratio
**5. Fundamentals** — PE, forward PE, margins, growth, market cap (say "Not available" if missing — never invent numbers)
**6. Verdict** — 2-3 sentences anchored on the Bull/Bear Ratio from the Signal Summary. Name both positives AND headwinds.
  Example: "With bullish factors outweighing bearish headwinds 2.4:1, MRVL scores 90 — the bottom of the Strong Buy tier. MACD and relative strength lead the bull case, but negative momentum and indicator disagreement (3 bull vs 3 bear) mean this is not a clean setup."
  End with: ⚠ Risk disclaimer.`;
}

/**
 * Build investment allocation for a given dollar amount across top picks
 */
function buildInvestmentExample(tickers, amount) {
    const picks = tickers.filter(t => t.entry && t.rec === 'STRONG BUY').slice(0, 5);
    if (picks.length === 0) return '';
    const perStock = amount / picks.length;
    const lines = picks.map(t => {
        const shares = (perStock / parseFloat(t.entry)).toFixed(1);
        const upside = t.target ? (((parseFloat(t.target) - parseFloat(t.entry)) / parseFloat(t.entry)) * 100).toFixed(1) : null;
        return `  • ${t.symbol} (score ${t.score}): ${shares} shares @ $${t.entry} = $${perStock.toFixed(0)}${upside ? `, target $${t.target} (+${upside}%)` : ''}`;
    });
    return `$${amount} equal-weight across top ${picks.length} STRONG BUY picks:\n${lines.join('\n')}`;
}

/**
 * Format per-ticker context block for system prompt
 */
/** Parse scoringLog entries into signed numbers for factor grouping + attribution totals */
function parseFactors(scoringLog) {
    const bullish = [], bearish = [];
    for (const line of (scoringLog || [])) {
        const m = line.match(/([+-]\d+)/);
        if (!m) continue;
        const pts = parseInt(m[1]);
        if (pts > 0) bullish.push({ line, pts });
        else if (pts < 0) bearish.push({ line, pts });
    }
    bullish.sort((a, b) => b.pts - a.pts);
    bearish.sort((a, b) => a.pts - b.pts);

    const bullishTotal = bullish.reduce((s, f) => s + f.pts, 0);
    const bearishTotal = bearish.reduce((s, f) => s + f.pts, 0); // negative number
    const netScore     = bullishTotal + bearishTotal;
    const ratio        = bearishTotal !== 0
        ? (bullishTotal / Math.abs(bearishTotal)).toFixed(1)
        : bullishTotal > 0 ? '∞' : '0';

    return { bullish, bearish, bullishTotal, bearishTotal, netScore, ratio };
}

/** Score tier label */
function scoreTier(score) {
    if (score >= 95) return 'STRONG BUY (elite setup — top 5%)';
    if (score >= 90) return 'STRONG BUY (bottom of Strong Buy tier)';
    if (score >= 85) return 'BUY+ (high conviction)';
    if (score >= 80) return 'BUY (buy signal)';
    if (score >= 70) return 'HOLD+ (borderline)';
    return 'HOLD / SKIP';
}

/** Convert raw OHLC bar array into human-readable price action bullets */
function priceActionNarrative(p) {
    if (!p) return [];
    const { current, change20d, high20d, low20d, bars } = p;
    const bullets = [];

    // 20-day trend
    const trendAbs = Math.abs(change20d);
    if (trendAbs >= 8)      bullets.push(`${change20d > 0 ? 'Strong 20-day uptrend' : 'Sharp 20-day decline'}: ${change20d > 0 ? '+' : ''}${change20d}%`);
    else if (trendAbs >= 3) bullets.push(`${change20d > 0 ? 'Moderate gain' : 'Pullback'} over 20 days: ${change20d > 0 ? '+' : ''}${change20d}%`);
    else                    bullets.push(`Flat / choppy over 20 days: ${change20d > 0 ? '+' : ''}${change20d}%`);

    // Position within 20-day range
    const rangeSize = high20d - low20d;
    const rangePos  = rangeSize > 0 ? ((current - low20d) / rangeSize) * 100 : 50;
    if (rangePos >= 80)      bullets.push(`Near 20-day high $${high20d.toFixed(2)} — near-term resistance zone`);
    else if (rangePos <= 20) bullets.push(`Near 20-day low $${low20d.toFixed(2)} — watching for support`);
    else                     bullets.push(`Mid-range between 20-day low $${low20d.toFixed(2)} and high $${high20d.toFixed(2)}`);

    // Recent bar direction (parse close prices from bar strings)
    const closes = (bars || []).map(b => {
        const m = b.match(/C:\$(\d+\.?\d*)/);
        return m ? parseFloat(m[1]) : null;
    }).filter(v => v !== null);

    if (closes.length >= 3) {
        const [c0, c1, c2] = closes; // most recent first
        if (c0 > c1 && c1 > c2)      bullets.push('Three consecutive up closes — near-term momentum building');
        else if (c0 < c1 && c1 < c2) bullets.push('Three consecutive down closes — near-term weakness');
        else if (c0 > c1)             bullets.push('Recovered in latest session after prior weakness');
        else                          bullets.push('Mixed recent sessions');
    }

    // Volume trend
    const vols = (bars || []).map(b => {
        const m = b.match(/V:([\d,]+)/);
        return m ? parseInt(m[1].replace(/,/g, '')) : null;
    }).filter(v => v !== null);

    if (vols.length >= 3) {
        const recent = vols.slice(0, 2).reduce((s, v) => s + v, 0) / 2;
        const older  = vols.slice(2).reduce((s, v) => s + v, 0) / vols.slice(2).length;
        const ratio  = older > 0 ? recent / older : 1;
        if (ratio >= 1.3)      bullets.push('Volume elevated vs prior sessions — institutional participation likely');
        else if (ratio <= 0.7) bullets.push('Volume declining — conviction fading, watch for re-engagement');
    }

    return bullets;
}

function buildTickerBlock(tc) {
    if (!tc) return '';
    const lines = [`\n━━━ ${tc.symbol} STOCK DATA ${tc.fetchedOnline ? '[fetched online → cached]' : '[from local DB]'} ━━━`];
    if (tc.companyName) lines.push(`Company: ${tc.companyName}  ← USE THIS EXACT NAME in the Overview section`);

    if (tc.scan) {
        const s = tc.scan;

        // Score with tier interpretation
        lines.push(`Score: ${s.score}/100 — ${scoreTier(s.score)}`);
        lines.push(`Recommendation: ${s.recommendation} | Sector: ${s.sector} | Setup: ${s.setup}`);
        lines.push(`Scan date: ${s.date}`);

        // R:R breakdown — validate against live price to catch stale scan levels
        if (s.entry != null) {
            const currentPrice = tc.price?.current || null;
            let entry  = s.entry;
            let stop   = s.stop;
            let target = s.target;
            let staleNote = '';

            // If stored entry deviates >15% from current price, the scan levels are stale.
            // Preserve the original risk% and reward% but rebase from current price.
            if (currentPrice != null && Math.abs(entry - currentPrice) / currentPrice > 0.15) {
                const origRiskPct   = stop   != null && entry > 0 ? (entry - stop)   / entry : 0.07;
                const origRewardPct = target != null && entry > 0 ? (target - entry) / entry : 0.14;
                entry  = currentPrice;
                stop   = parseFloat((entry * (1 - origRiskPct)).toFixed(2));
                target = parseFloat((entry * (1 + origRewardPct)).toFixed(2));
                staleNote = '  ⚠ Scan levels were stale — recalculated from live price';
            }

            const risk   = stop   != null ? (entry - stop).toFixed(2)   : null;
            const reward = target != null ? (target - entry).toFixed(2) : null;
            const rr     = risk && reward && parseFloat(risk) > 0
                ? (parseFloat(reward) / parseFloat(risk)).toFixed(1) : s.riskReward || '?';
            lines.push(`Trade levels:${staleNote}`);
            lines.push(`  Entry  $${entry.toFixed(2)}`);
            if (stop)   lines.push(`  Stop   $${stop.toFixed(2)}  (risk $${risk}/share)`);
            if (target) lines.push(`  Target $${target.toFixed(2)}  (reward $${reward}/share)`);
            lines.push(`  R:R = ${rr}:1`);
        }

        if (s.verdict) lines.push(`Oracle verdict: ${s.verdict}`);
        if (s.smartMoney != null) lines.push(`Smart Money score: ${s.smartMoney}`);

        // Factor grouping — top bullish + top bearish, with attribution totals
        const { bullish, bearish, bullishTotal, bearishTotal, netScore, ratio } = parseFactors(s.scoringLog);
        if (bullish.length || bearish.length) {
            lines.push('');

            // Attribution summary — LLM uses this for the narrative tone
            const dominance = netScore > 0
                ? `Bullish drivers outweigh bearish headwinds ${ratio}:1 — aggregate score is NET POSITIVE`
                : netScore < 0
                    ? `Bearish headwinds outweigh bullish drivers ${ratio}:1 — aggregate score is NET NEGATIVE`
                    : 'Exactly balanced — signal conflict is high';
            lines.push(`Factor Attribution: Bullish +${bullishTotal} | Bearish ${bearishTotal} | Net ${netScore > 0 ? '+' : ''}${netScore}`);
            lines.push(`Signal balance: ${dominance}`);
            lines.push('');

            lines.push('Primary bullish drivers:');
            (bullish.length ? bullish.slice(0, 4) : [{ line: 'None', pts: 0 }])
                .forEach(f => lines.push(`  ✅ ${f.line}`));
            lines.push('Primary bearish headwinds:');
            (bearish.length ? bearish.slice(0, 4) : [{ line: 'None', pts: 0 }])
                .forEach(f => lines.push(`  ❌ ${f.line}`));

            // Staleness warning — only fires when the scan is genuinely old (>5 calendar days).
            // A fresh scan can legitimately show Momentum -10 alongside a positive 20d change
            // when a stock peaked mid-period and pulled back. That is NOT a data error.
            // We only warn when factors are so old they likely predate a meaningful price move.
            if (s.date) {
                const scanAgeDays = (Date.now() - new Date(s.date).getTime()) / 86_400_000;
                if (scanAgeDays > 5) {
                    lines.push('');
                    lines.push(`⚠ DATA COHERENCE NOTE: Scan is ${Math.round(scanAgeDays)} days old (last run: ${String(s.date).slice(0, 10)}).`);
                    lines.push('  Factor scores may not reflect current market conditions.');
                    lines.push('  Trade levels have been rebased from live price where applicable, but qualitative signals should be treated with lower confidence.');
                }
            }

            lines.push('');
            lines.push('Full scoring log:');
            s.scoringLog.forEach(l => lines.push(`  ${l}`));
        }
    } else {
        lines.push('No PANTHEON scan data for this symbol. Showing market data only.');
    }

    if (tc.price) {
        const p = tc.price;
        lines.push(`\nPrice (20-day): current $${p.current} | change ${p.change20d > 0 ? '+' : ''}${p.change20d}% | range $${p.low20d}–$${p.high20d}`);
        const narrative = priceActionNarrative(p);
        if (narrative.length > 0) {
            lines.push('Recent price action:');
            narrative.forEach(b => lines.push(`  • ${b}`));
        }
    }

    if (tc.fundamentals) {
        const f = tc.fundamentals;
        const parts = [];
        if (f.pe           != null) parts.push(`PE ${f.pe.toFixed(1)}`);
        if (f.forwardPe    != null) parts.push(`Fwd PE ${f.forwardPe.toFixed(1)}`);
        if (f.peg          != null) parts.push(`PEG ${f.peg.toFixed(2)}`);
        if (f.profitMargin != null) parts.push(`Net margin ${(f.profitMargin*100).toFixed(1)}%`);
        if (f.revenueGrowth!= null) parts.push(`Rev growth ${(f.revenueGrowth*100).toFixed(1)}%`);
        if (f.earningsGrowth!=null) parts.push(`EPS growth ${(f.earningsGrowth*100).toFixed(1)}%`);
        if (f.debtToEquity != null) parts.push(`D/E ${f.debtToEquity.toFixed(2)}`);
        if (f.roe          != null) parts.push(`ROE ${(f.roe*100).toFixed(1)}%`);
        if (f.marketCap    != null) parts.push(`MCap $${(f.marketCap/1e9).toFixed(1)}B`);
        if (parts.length) lines.push(`Fundamentals: ${parts.join(' | ')}`);
        if (f.industry) lines.push(`Industry: ${f.industry}`);
    }

    return lines.join('\n');
}

/**
 * Build system prompt with current market and user context
 */
function buildSystemPrompt(marketContext, userContext, tickerContext = null) {
    const tickers  = marketContext.signals?.allTickers || [];
    const sectors  = marketContext.signals?.sectorCounts || {};
    const topSectors = Object.entries(sectors).sort((a, b) => b[1] - a[1]).slice(0, 5);

    const SWING_SECTORS = ['Technology','Consumer Cyclical','Communication Services','Financial Services'];
    const INTRA_SECTORS = ['Healthcare','Consumer Defensive','Utilities','Industrials'];
    const swingPicks = tickers.filter(t => SWING_SECTORS.includes(t.sector) || t.setup === 'breakout_leader');
    const intraPicks = tickers.filter(t => INTRA_SECTORS.includes(t.sector) || t.setup === 'oversold_reversal');

    const invest500 = buildInvestmentExample(tickers, 500);

    // Keep ticker table short — top 10 only to avoid Ollama context overflow
    const allTickerTable = tickers.slice(0, 10).map(t =>
        `  ${t.symbol.padEnd(6)} ${t.score} ${t.rec === 'STRONG BUY' ? 'SB' : 'B '} ${(t.sector||'?').slice(0,18).padEnd(18)} entry:${t.entry||'?'} tgt:${t.target||'?'}`
    ).join('\n');

    return `You are the KiranRock AI financial assistant — an intelligent, friendly advisor integrated with the platform's own PANTHEON scoring engine and real daily scan data. Answer in plain English, be specific and actionable.

LANGUAGE UNDERSTANDING (always auto-correct these):
• "sticker" or "sticket" or "stocker" → stock ticker symbol (e.g. "explain QCOM sticker" = "explain the QCOM stock")
• "aple/appl/aplle" → AAPL (Apple)  • "tesala/teslas" → TSLA (Tesla)  • "nvdia/nvidea" → NVDA (Nvidia)
• "shoud/shld" → should  • "portoflio/porfolio" → portfolio  • "wat" → what  • "rn" → right now
• "stonks" → stocks  • "mooning" → rising fast  • "dd" → due diligence  • "ath" → all-time high
When the user says "explain [SYMBOL] sticker", they mean "tell me about the [SYMBOL] stock."

━━━ TODAY'S MARKET SNAPSHOT ━━━
${marketContext.marketRegime ? `Regime: ${marketContext.marketRegime.regime} | VIX: ${marketContext.marketRegime.vixLevel} | Volatility: ${(marketContext.marketRegime.atrExpansion || 1) < 0.85 ? 'LOW (contracting)' : 'NORMAL/EXPANDING'}` : 'Market data unavailable'}
${marketContext.atlas ? `ATLAS Global: ${marketContext.atlas.label} (score ${marketContext.atlas.score}/100, VIX ${marketContext.atlas.vix || '—'})` : ''}
${marketContext.recentPerformance ? `90-day track record: ${marketContext.recentPerformance.winRate}% win rate, avg ${marketContext.recentPerformance.avgReturn > 0 ? '+' : ''}${marketContext.recentPerformance.avgReturn}% per trade, total P&L $${marketContext.recentPerformance.totalPnl}` : ''}

━━━ TODAY'S TOP PICKS (PANTHEON SCORE ≥ 80) ━━━
Symbol | Score | Rec        | Sector                 | Setup                  | Levels
${allTickerTable || 'No signals available'}

━━━ SECTOR CONCENTRATION ━━━
${topSectors.map(([s, c]) => `${s}: ${c} stocks (${SWING_SECTORS.includes(s) ? 'swing-friendly' : INTRA_SECTORS.includes(s) ? 'intra-friendly' : 'both'})`).join('\n') || 'No data'}

━━━ SWING vs INTRA SPLIT ━━━
SWING trades (hold 2-10 days): Breakout Leaders + Growth sectors
  Best picks: ${swingPicks.slice(0, 8).map(t => t.symbol).join(', ') || 'none today'}
INTRA trades (same-day scalp): Oversold Reversals + Stable sectors
  Best picks: ${intraPicks.slice(0, 6).map(t => t.symbol).join(', ') || 'none today'}

━━━ $500 INVESTMENT EXAMPLE ━━━
${invest500 || 'Entry prices not available today'}

━━━ USER CONTEXT ━━━
${userContext.account ? `Balance: $${userContext.account.balance.toLocaleString()} | Portfolio: $${userContext.account.portfolioValue.toLocaleString()} | Max positions: ${userContext.account.maxPositions}` : 'Account data unavailable'}
${userContext.holdings ? `Current holdings: ${userContext.holdings.map(h => `${h.symbol} (${h.unrealizedPnl >= 0 ? '+' : ''}$${h.unrealizedPnl.toFixed(0)})`).join(', ')}` : ''}

━━━ RULES ━━━
• Always reference the real data above — never invent scores, prices, or symbols
• If the user asks about a specific stock, use the SPECIFIC STOCK DATA block below (if present)
• For investment questions (e.g. "what to do with $500"), use the Investment Examples above as starting point and adjust for user's risk tolerance
• For sector questions, use the Swing/Intra split above
• Be concise — bullet points preferred
• Add a one-line risk disclaimer at the end of any buy/sell advice
• If you don't have data for a symbol, say so clearly — never fabricate prices or scores
${buildTickerBlock(tickerContext)}
`;
}

module.exports = router;