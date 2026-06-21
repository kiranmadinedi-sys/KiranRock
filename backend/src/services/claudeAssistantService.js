/**
 * Claude Assistant Service — Personal AI for kmadined
 *
 * Wraps the Anthropic Messages API with tool_use so Claude can pull
 * live data (portfolio, signals, health, stock analysis) before answering.
 *
 * READ-ONLY. No order placement.
 * Access restricted to KMADINED_USER_ID at the route level.
 */

const axios      = require('axios');
const { query }  = require('../config/database');
const { logger } = require('../utils/logger');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const KMADINED_USER_ID  = 'ca632c53-8798-46f4-be94-29be0fede7f2';
const MODEL             = 'claude-sonnet-4-6';
const MAX_TOOL_ROUNDS   = 4;  // max back-and-forth before forcing a text answer

// ─── Tool definitions (what Claude can call) ──────────────────────────────────

const TOOLS = [
    {
        name: 'get_portfolio',
        description: 'Get live portfolio: open positions, P&L per position, total account value, cash, and buying power from Alpaca.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'get_signals',
        description: 'Get today\'s top PANTHEON signals — stocks with BUY or STRONG BUY recommendations from the nightly scan.',
        input_schema: {
            type: 'object',
            properties: {
                limit:          { type: 'number',  description: 'Max stocks to return (default 10)' },
                recommendation: { type: 'string',  description: 'Filter: STRONG BUY or BUY (default: both)' }
            },
            required: []
        }
    },
    {
        name: 'get_system_status',
        description: 'Check system health: worker heartbeat, HALT_ALL state, bot cycle success rate, stop coverage.',
        input_schema: { type: 'object', properties: {}, required: [] }
    },
    {
        name: 'get_recent_trades',
        description: 'Get recent trade history — recent buys and sells with price, quantity, and realized P&L.',
        input_schema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Number of trades to return (default 10)' }
            },
            required: []
        }
    },
    {
        name: 'get_stock_analysis',
        description: 'Get detailed PANTHEON analysis for a specific stock symbol: score, recommendation, sector, entry/stop/target, scoring breakdown.',
        input_schema: {
            type: 'object',
            properties: {
                symbol: { type: 'string', description: 'Stock ticker symbol e.g. NVDA' }
            },
            required: ['symbol']
        }
    }
];

// ─── Tool implementations ─────────────────────────────────────────────────────

async function getPortfolio() {
    try {
        const creds = await query(
            'SELECT alpaca_key_id, alpaca_secret_key, alpaca_paper FROM users WHERE id=$1',
            [KMADINED_USER_ID]
        );
        const { alpaca_key_id, alpaca_secret_key, alpaca_paper } = creds.rows[0];
        const base    = alpaca_paper === false ? 'https://api.alpaca.markets' : 'https://paper-api.alpaca.markets';
        const headers = { 'APCA-API-KEY-ID': alpaca_key_id, 'APCA-API-SECRET-KEY': alpaca_secret_key };

        const [posRes, acctRes, ordRes] = await Promise.all([
            axios.get(`${base}/v2/positions`, { headers }),
            axios.get(`${base}/v2/account`,   { headers }),
            axios.get(`${base}/v2/orders`,     { headers, params: { status: 'open', limit: 200 } })
        ]);

        const acct = acctRes.data;
        const stopSyms = new Set(
            ordRes.data.filter(o => (o.type === 'stop' || o.type === 'stop_limit') && o.side === 'sell')
                       .map(o => o.symbol)
        );

        const positions = posRes.data.map(p => ({
            symbol:       p.symbol,
            qty:          parseFloat(p.qty),
            entryPrice:   parseFloat(p.avg_entry_price).toFixed(2),
            currentPrice: parseFloat(p.current_price).toFixed(2),
            marketValue:  parseFloat(p.market_value).toFixed(2),
            unrealizedPL: parseFloat(p.unrealized_pl).toFixed(2),
            unrealizedPct:parseFloat(p.unrealized_plpc * 100).toFixed(1) + '%',
            hasStop:      stopSyms.has(p.symbol)
        }));

        const dayPL = parseFloat(acct.equity) - parseFloat(acct.last_equity);

        return {
            portfolioValue: parseFloat(acct.portfolio_value).toFixed(2),
            cash:           parseFloat(acct.cash).toFixed(2),
            buyingPower:    parseFloat(acct.buying_power).toFixed(2),
            dayPL:          dayPL.toFixed(2),
            dayPLPct:       acct.last_equity > 0 ? ((dayPL / acct.last_equity) * 100).toFixed(2) + '%' : '0%',
            positionCount:  positions.length,
            unprotected:    positions.filter(p => !p.hasStop).map(p => p.symbol),
            positions
        };
    } catch (e) {
        return { error: `Portfolio fetch failed: ${e.message}` };
    }
}

async function getSignals({ limit = 10, recommendation = null } = {}) {
    try {
        const LATEST = `(
            SELECT MAX(analysis_date) FROM daily_universe_analysis
            WHERE analysis_date >= CURRENT_DATE - INTERVAL '4 days'
              AND analysis_date <= CURRENT_DATE AND passed_prescreen = true
        )`;
        const recFilter = recommendation
            ? `AND recommendation = '${recommendation.toUpperCase()}'`
            : `AND recommendation IN ('STRONG BUY','BUY')`;

        const res = await query(`
            SELECT symbol, ai_score, recommendation, sector, setup_family,
                   (metadata->>'entry')::numeric  AS entry,
                   (metadata->>'stop')::numeric   AS stop,
                   (metadata->>'target')::numeric AS target,
                   (metadata->>'riskReward')      AS rr,
                   analysis_date
            FROM daily_universe_analysis
            WHERE analysis_date = ${LATEST}
              ${recFilter}
            ORDER BY ai_score DESC
            LIMIT $1
        `, [limit]);

        return {
            scanDate: res.rows[0]?.analysis_date || null,
            count: res.rows.length,
            signals: res.rows.map(r => ({
                symbol: r.symbol,
                score:  parseFloat(r.ai_score),
                rec:    r.recommendation,
                sector: r.sector,
                setup:  r.setup_family,
                entry:  r.entry  ? parseFloat(r.entry).toFixed(2)  : null,
                stop:   r.stop   ? parseFloat(r.stop).toFixed(2)   : null,
                target: r.target ? parseFloat(r.target).toFixed(2) : null,
                rr:     r.rr     || null
            }))
        };
    } catch (e) {
        return { error: `Signals fetch failed: ${e.message}` };
    }
}

async function getSystemStatus() {
    try {
        const [hbRes, scRes, cycRes] = await Promise.all([
            query(`SELECT heartbeat_at FROM worker_runtime_status ORDER BY heartbeat_at DESC LIMIT 1`),
            query(`SELECT halt_all_reason FROM system_controls WHERE id=1`),
            query(`SELECT success, message, timestamp FROM ai_trading_logs WHERE user_id=$1 ORDER BY timestamp DESC LIMIT 5`, [KMADINED_USER_ID])
        ]);

        const age     = hbRes.rows[0] ? (Date.now() - new Date(hbRes.rows[0].heartbeat_at)) / 60000 : 999;
        const halt    = scRes.rows[0]?.halt_all_reason;
        const cycles  = cycRes.rows;
        const okCycles = cycles.filter(c => c.success).length;

        return {
            worker:     age < 8 ? `healthy (${age.toFixed(1)}m ago)` : `STALLED (${age.toFixed(1)}m — needs restart)`,
            haltAll:    halt || 'clear',
            botCycles:  `${okCycles}/${cycles.length} recent cycles succeeded`,
            lastCycleAt: cycles[0]?.timestamp || null
        };
    } catch (e) {
        return { error: `System status failed: ${e.message}` };
    }
}

async function getRecentTrades({ limit = 10 } = {}) {
    try {
        const res = await query(`
            SELECT symbol, action, quantity, price, total, pnl, pnl_percent, trade_date, executed_by
            FROM trades
            WHERE user_id = $1
            ORDER BY trade_date DESC
            LIMIT $2
        `, [KMADINED_USER_ID, limit]);

        return {
            count: res.rows.length,
            trades: res.rows.map(t => ({
                date:    new Date(t.trade_date).toLocaleString('en-US', { timeZone: 'America/Chicago', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }),
                action:  t.action,
                symbol:  t.symbol,
                qty:     parseFloat(t.quantity),
                price:   parseFloat(t.price).toFixed(2),
                total:   parseFloat(t.total).toFixed(2),
                pnl:     t.pnl     != null ? parseFloat(t.pnl).toFixed(2)     : null,
                pnlPct:  t.pnl_percent != null ? parseFloat(t.pnl_percent).toFixed(1) + '%' : null,
                by:      t.executed_by
            }))
        };
    } catch (e) {
        return { error: `Trade history failed: ${e.message}` };
    }
}

async function getStockAnalysis({ symbol }) {
    try {
        const sym = symbol.toUpperCase();
        const LATEST = `(
            SELECT MAX(analysis_date) FROM daily_universe_analysis
            WHERE symbol=$1 AND analysis_date >= CURRENT_DATE - INTERVAL '4 days'
        )`;
        const [scanRes, fundRes] = await Promise.all([
            query(`
                SELECT symbol, ai_score, recommendation, sector, setup_family,
                       (metadata->>'entry')::numeric       AS entry,
                       (metadata->>'stop')::numeric        AS stop,
                       (metadata->>'target')::numeric      AS target,
                       (metadata->>'riskReward')           AS rr,
                       metadata->>'oracleVerdict'          AS verdict,
                       metadata->'scoringLog'              AS scoring_log,
                       (metadata->>'smartMoneyScore')::numeric AS smart_money,
                       analysis_date
                FROM daily_universe_analysis
                WHERE symbol=$1 AND analysis_date = ${LATEST}
                LIMIT 1
            `, [sym]),
            query(`
                SELECT pe_ratio, forward_pe, profit_margin, revenue_growth,
                       earnings_growth, market_cap, industry
                FROM fundamentals_cache WHERE symbol=$1
            `, [sym]).catch(() => ({ rows: [] }))
        ]);

        if (!scanRes.rows[0]) {
            return { symbol: sym, found: false, message: `No PANTHEON scan data for ${sym} in the last 4 days.` };
        }

        const s = scanRes.rows[0];
        const f = fundRes.rows[0];

        // Parse top scoring factors
        const log = Array.isArray(s.scoring_log) ? s.scoring_log : [];
        const bullish = [], bearish = [];
        for (const line of log) {
            const m = line.match(/([+-]\d+)/);
            if (!m) continue;
            const pts = parseInt(m[1]);
            if (pts > 0) bullish.push(line);
            else if (pts < 0) bearish.push(line);
        }

        return {
            symbol:     sym,
            found:      true,
            scanDate:   s.analysis_date,
            score:      parseFloat(s.ai_score),
            recommendation: s.recommendation,
            sector:     s.sector,
            setup:      s.setup_family,
            entry:      s.entry  ? parseFloat(s.entry).toFixed(2)  : null,
            stop:       s.stop   ? parseFloat(s.stop).toFixed(2)   : null,
            target:     s.target ? parseFloat(s.target).toFixed(2) : null,
            rr:         s.rr     || null,
            verdict:    s.verdict || null,
            smartMoney: s.smart_money ? parseFloat(s.smart_money) : null,
            topBullish: bullish.slice(0, 4),
            topBearish: bearish.slice(0, 4),
            fundamentals: f ? {
                pe:           f.pe_ratio      != null ? parseFloat(f.pe_ratio).toFixed(1)      : null,
                forwardPe:    f.forward_pe    != null ? parseFloat(f.forward_pe).toFixed(1)    : null,
                netMargin:    f.profit_margin != null ? (parseFloat(f.profit_margin)*100).toFixed(1)+'%' : null,
                revenueGrowth:f.revenue_growth!= null ? (parseFloat(f.revenue_growth)*100).toFixed(1)+'%' : null,
                epsGrowth:    f.earnings_growth!=null ? (parseFloat(f.earnings_growth)*100).toFixed(1)+'%' : null,
                marketCap:    f.market_cap    != null ? `$${(parseFloat(f.market_cap)/1e9).toFixed(1)}B` : null,
                industry:     f.industry      || null
            } : null
        };
    } catch (e) {
        return { error: `Stock analysis failed: ${e.message}` };
    }
}

async function executeTool(name, input) {
    switch (name) {
        case 'get_portfolio':      return getPortfolio();
        case 'get_signals':        return getSignals(input);
        case 'get_system_status':  return getSystemStatus();
        case 'get_recent_trades':  return getRecentTrades(input);
        case 'get_stock_analysis': return getStockAnalysis(input);
        default: return { error: `Unknown tool: ${name}` };
    }
}

// ─── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt() {
    const now = new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'full', timeStyle: 'short'
    });
    return `You are KiranRock AI — Kiran's personal trading assistant with live access to his trading system.

Current time: ${now} ET

You have tools to fetch:
• Live portfolio & P&L from Alpaca
• Today's PANTHEON stock signals
• System health (worker, bot cycles, stops)
• Recent trade history
• Detailed analysis for any stock

Guidelines:
- Be direct, specific, and use the actual numbers from your tools
- Flag risks clearly (no stops, stalled worker, losing positions)
- For portfolio questions, always show positions with P&L and whether each has a stop
- For signal questions, show score, entry/stop/target, and risk:reward
- Keep responses concise — bullet points when listing multiple items
- Never invent numbers; call a tool if you need data
- Add a brief risk disclaimer for any trade suggestions`;
}

// ─── Main chat function ───────────────────────────────────────────────────────

/**
 * Send a message to Claude with tool_use and return the final text response.
 * @param {string} userMessage - The user's question
 * @returns {Promise<string>} Claude's response text
 */
async function chat(userMessage) {
    if (!ANTHROPIC_API_KEY) {
        throw new Error('ANTHROPIC_API_KEY not configured');
    }

    const messages = [{ role: 'user', content: userMessage }];
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
        rounds++;

        const response = await axios.post(
            'https://api.anthropic.com/v1/messages',
            {
                model:      MODEL,
                max_tokens: 1024,
                system:     buildSystemPrompt(),
                tools:      TOOLS,
                messages
            },
            {
                headers: {
                    'x-api-key':         ANTHROPIC_API_KEY,
                    'anthropic-version': '2023-06-01',
                    'content-type':      'application/json'
                },
                timeout: 30000
            }
        );

        const { stop_reason, content } = response.data;

        // Add assistant's response to conversation
        messages.push({ role: 'assistant', content });

        // If no tool calls or final answer — return text
        if (stop_reason === 'end_turn' || stop_reason !== 'tool_use') {
            const textBlock = content.find(b => b.type === 'text');
            return textBlock?.text || 'No response generated.';
        }

        // Process tool calls
        const toolResults = [];
        for (const block of content) {
            if (block.type !== 'tool_use') continue;
            logger.info('[ClaudeAssistant] Tool call', { tool: block.name, input: block.input });
            const result = await executeTool(block.name, block.input || {});
            toolResults.push({
                type:        'tool_result',
                tool_use_id: block.id,
                content:     JSON.stringify(result)
            });
        }

        // Feed results back to Claude
        messages.push({ role: 'user', content: toolResults });
    }

    return 'I reached the maximum number of tool calls. Please try a more specific question.';
}

module.exports = { chat };
