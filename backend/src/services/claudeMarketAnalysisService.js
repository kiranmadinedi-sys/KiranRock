/**
 * Market Analysis Service (Local Ollama backend)
 *
 * Applies financial-analyst + senior-data-scientist skill frameworks:
 *   • Bull / Base / Bear scenario analysis per pick
 *   • Risk/Reward ratio quantification (≥2:1 threshold)
 *   • Confidence-weighted position sizing (Kelly-inspired)
 *   • Feature-importance explanation (what drove the AI score)
 *   • Sector rotation overlay for allocation decisions
 *
 * All generation runs through the local Ollama model (llama3.2:3b by default).
 * Zero API cost — no Anthropic/Claude calls.
 */

const ollamaService = require('./ollamaService');
const { logger }    = require('../utils/logger');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function riskRewardRatio(expectedMove, riskScore) {
    const downside = Math.max(1, riskScore * 0.15);
    const reward   = Math.abs(expectedMove);
    return reward > 0 ? (reward / downside).toFixed(1) : '0.0';
}

function signalDrivers(p) {
    const scores  = p.componentScores || {};
    const drivers = [];

    if (scores.technical   != null) drivers.push({ name: 'Technical',   val: scores.technical });
    if (scores.fundamental != null) drivers.push({ name: 'Fundamental', val: scores.fundamental });
    if (scores.sentiment   != null) drivers.push({ name: 'Sentiment',   val: scores.sentiment });
    if (scores.momentum    != null) drivers.push({ name: 'Momentum',    val: scores.momentum });
    if (scores.volume      != null) drivers.push({ name: 'Volume',      val: scores.volume });

    return drivers
        .sort((a, b) => b.val - a.val)
        .slice(0, 3)
        .map(d => `${d.name}(${d.val})`)
        .join(', ') || 'Composite score';
}

// ─── Weekly analyst prompt ────────────────────────────────────────────────────

function buildPrompt({ picks, marketContext, macroNews, weekLabel }) {
    const pickLines = picks.map((p, i) => {
        const score    = p.totalScore              || 0;
        const signal   = p.prediction?.signal      || 'Hold';
        const move     = p.prediction?.expectedMove || 0;
        const conf     = p.prediction?.confidence   || 0;
        const price    = p.currentPrice             || '?';
        const target   = p.prediction?.targetPrice  || '?';
        const sector   = p.sector                   || 'Unknown';
        const risk     = p.riskAnalysis?.riskScore  || 50;
        const rr       = riskRewardRatio(move, risk);
        const drivers  = signalDrivers(p);
        const rationale = p.rationale || '';
        const events   = (p.upcomingEvents || []).join(', ') || 'none';

        return `${i + 1}. $${p.symbol} (${p.name || p.symbol})
   AI Score: ${score}/100 | Signal: ${signal} | Confidence: ${conf}%
   Price: $${price} → Target: $${target} | Expected move: ${move > 0 ? '+' : ''}${move}%
   Sector: ${sector} | Risk score: ${risk}/100 | R/R ratio: ${rr}:1
   Top signal drivers: ${drivers}
   Rationale: ${rationale}
   Upcoming events: ${events}`;
    }).join('\n\n');

    const rotatingIn  = marketContext?.sectorRotation?.rotatingIn?.join(', ')  || 'None identified';
    const rotatingOut = marketContext?.sectorRotation?.rotatingOut?.join(', ') || 'None identified';
    const regime      = marketContext?.marketRegime || 'Unknown';
    const avgScore    = marketContext?.averageScore  || 50;

    const regimeText = `Market regime: ${regime}
Avg AI score across universe: ${avgScore}/100
Sectors rotating IN (favour): ${rotatingIn}
Sectors rotating OUT (avoid): ${rotatingOut}`;

    const newsText = macroNews.length > 0
        ? macroNews.slice(0, 6).map(n => `• [${n.source}] ${n.headline}`).join('\n')
        : 'No major macro news available';

    const systemFraming = `
ANALYTICAL FRAMEWORKS TO APPLY:

FINANCIAL ANALYST LENS:
• For each recommended stock apply a 3-scenario framework:
    Bull case:  AI signal fires, momentum holds    → target price + upside %
    Base case:  partial thesis plays out           → midpoint return
    Bear case:  signal fails or macro headwind     → stop-loss level
• Require R/R ≥ 2:1 to recommend. Flag picks with R/R < 2:1 as speculative.
• Use sector rotation data to weight allocation (favour rotating-in sectors).

DATA SCIENTIST LENS:
• Confidence score = AI signal quality (% of model features aligned).
    ≥ 75% = high conviction  |  50-74% = moderate  |  < 50% = speculative
• Top signal drivers show WHICH factors are moving the score — use these to
  explain WHY each pick is interesting this week, not just WHAT the score says.
• When multiple picks share the same sector + same signal type, note the
  cluster and flag concentration risk.

POSITION SIZING (Kelly-inspired, conservative):
  Position weight = (Confidence% / 100) × (Expected move / Risk score) × Base%
  Cap any single position at 20% of portfolio. Default base = 10%.
`;

    return `You are a senior financial analyst and quantitative strategist helping a retail investor prepare for the trading week.

Today is ${weekLabel}.

${systemFraming}

=== MARKET CONTEXT ===
${regimeText}

=== THIS WEEK'S MACRO NEWS ===
${newsText}

=== AI-SCORED STOCK PICKS (Quantitative Pipeline Output) ===
${pickLines}

=== YOUR TASK ===
Using the analytical frameworks above, produce a structured Weekly Buy List.

Format your response EXACTLY using these section headers (do not skip any):

📊 ✅ WEEKLY BUY LIST — [current week date range]

---INTRO---
3-sentence market summary: regime, dominant sector theme, key risk for the week.

---HIGH_RISK---
🚀 High-Risk / High-Reward (Momentum & Speculative)
Only stocks with risk score > 60 or confidence < 60%. For each:
• Ticker + name, signal, confidence%
• Bull / Base / Bear: one price target per scenario
• Top signal driver + why it matters this week
• Position sizing: max % of portfolio (cap at 10% for high-risk)
End with a 1-line concentration-risk warning if picks cluster in same sector.

---GROWTH---
🤖 AI / Tech / Growth (Best Short-Term + Medium Potential)
Stocks with R/R ≥ 2:1 and confidence ≥ 60% in growth sectors. For each:
• Ticker + name, signal, confidence%
• Expected move range (bear/base/bull)
• The single biggest signal driver explaining this pick
Mark your single best pick this week with ⭐ and give 2 sentences of reasoning.

---STABLE---
🛡️ Stable / Safer Picks (Balance Your Risk)
Defensive, dividend, or low-volatility picks (risk score < 45). For each:
• Ticker + name, signal
• Why this is a safe base position this week
• Suggested portfolio weight %

---NICHE---
🧪 Niche / Sector Specific (Only If You Have Extra Budget)
2-3 picks that don't fit above. One sentence each, with the niche thesis.

---ALLOCATION---
💼 Suggested Allocation (Portfolio Sizing)
Based on the market regime and sector rotation, give a concrete allocation for a $5K–$10K portfolio:
• % to High-Risk bucket
• % to Growth bucket
• % to Stable / Defensive bucket
• % to Cash (if regime is bearish/uncertain, suggest higher cash)
Include a 1-line Kelly-sizing note: "At X% average confidence, no single pick should exceed Y% of portfolio."

---BEST5---
📈 Best 5 Picks THIS WEEK
The 5 highest-conviction picks. For each: ticker, confidence%, expected move, and the single best reason.
Rank 1 must be the pick with the best combination of R/R ratio AND confidence.

---HONEST---
⚠️ Honest Reality Check
4 bullet points. Cover: what the AI model could be wrong about, macro tail risks, sector concentration, and one scenario where you'd stay 100% in cash this week. Be direct.

Rules:
- Only use stocks from the data above
- Apply the R/R threshold: explicitly flag any pick with R/R < 2:1
- If market regime is bearish/volatile, shift allocation toward Stable + Cash
- No generic disclaimers (the platform adds legal text separately)
- Be specific, confident, and quantitative — cite scores, %, and price targets`;
}

// ─── Beginner daily prompt ────────────────────────────────────────────────────

function buildBeginnerDailyPrompt({ picks, marketContext, macroNews, todayLabel }) {
    const top = picks.slice(0, 10);

    const pickLines = top.map((p, i) => {
        const signal  = p.prediction?.signal       || 'Hold';
        const conf    = p.prediction?.confidence    || 0;
        const move    = p.prediction?.expectedMove  || 0;
        const price   = p.currentPrice              || '?';
        const target  = p.prediction?.targetPrice   || '?';
        const risk    = p.riskAnalysis?.riskScore    || 50;
        const gain1k  = Math.round((Math.abs(move) / 100) * 1000);
        const lose1k  = Math.round((risk / 100) * 1000 * 0.15);
        return `${i + 1}. $${p.symbol} (${p.name || p.symbol})
   Signal: ${signal} | AI confidence: ${conf}% | Current price: $${price} → Target: $${target}
   Expected change: ${move > 0 ? '+' : ''}${move}% | Risk level: ${risk}/100
   $1,000 invested: could gain ~$${gain1k} OR could lose ~$${lose1k}
   Why: ${p.rationale || 'No rationale available'}`;
    }).join('\n\n');

    const regime   = marketContext?.marketRegime || 'Normal';
    const avgScore = marketContext?.averageScore  || 50;
    const newsText = macroNews.length > 0
        ? macroNews.slice(0, 3).map(n => `• ${n.headline}`).join('\n')
        : 'No major news today';

    return `You are a friendly stock market teacher explaining today's top stock picks to a complete beginner investor.

Today is ${todayLabel}.
Market mood: ${regime} (Average AI score today: ${avgScore}/100)

TODAY'S BIG NEWS:
${newsText}

TODAY'S AI-SCORED STOCKS:
${pickLines}

YOUR TASK:
Write a SHORT, beginner-friendly daily briefing. Use plain everyday English — no financial jargon.
If you must use a term like "Bull" or "Bearish", explain it in brackets immediately after.

Format EXACTLY like this:

📊 TODAY'S AI STOCK BRIEFING — ${todayLabel}
_Your daily guide to what the AI is seeing in the market_

---MARKET_MOOD---
🌤️ Today's Market in Plain English
One sentence describing how the market feels today and what it means for a beginner.

---TOP3---
🎯 Top 3 Picks for Today
Pick the 3 stocks with the highest confidence AND a Buy or Strong Buy signal.
For each:
  [Rank]. $TICKER — [Signal in plain English]
  📈 AI confidence: X% — [what this means in plain English]
  💰 If you invest $1,000: you could gain ~$XX or lose ~$XX
  📌 Why in plain English: [1-2 plain sentences]
  🔰 Good for beginners? [Yes / With caution / No — and one sentence why]

---AVOID---
⚠️ Stocks to Watch Out For Today
List 2-3 stocks with Avoid or Hold signals, or risk score > 70. One plain sentence each.

---TIP---
🔰 Beginner Tip of the Day
One practical tip about investing that applies to today's market. Simple and direct.

---BOTTOM_LINE---
📝 Bottom Line (30 seconds read)
2-3 sentences summarising what a beginner should take away. End with one honest sentence about risk.

Rules:
- NEVER use jargon without explaining it
- NEVER recommend putting all money in one stock
- Keep the whole message under 600 words
- Be warm, encouraging, and honest about risk
- Only use stocks from the data above`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Generate beginner-friendly daily briefing using local Ollama.
 */
async function analyzeDailyWithClaude({ picks, marketContext, macroNews, todayLabel }) {
    if (!ollamaService.isEnabled()) {
        logger.warn('[MarketAnalysis] Ollama not configured — skipping daily briefing');
        return '';
    }

    const prompt = buildBeginnerDailyPrompt({ picks, marketContext, macroNews, todayLabel });
    logger.info('[MarketAnalysis] Generating daily briefing via Ollama...', { picks: picks.length });

    const text = await ollamaService.generate(prompt, '', { maxTokens: 1500, temperature: 0.35 });
    logger.info('[MarketAnalysis] Daily briefing complete', { chars: text.length });
    return text;
}

/**
 * Generate full weekly analyst report using local Ollama.
 */
async function analyzeMarketWithClaude({ picks, marketContext, macroNews, weekLabel }) {
    if (!ollamaService.isEnabled()) {
        logger.warn('[MarketAnalysis] Ollama not configured — skipping weekly report');
        return '';
    }

    const prompt = buildPrompt({ picks, marketContext, macroNews, weekLabel });
    logger.info('[MarketAnalysis] Generating weekly report via Ollama...', {
        picks:  picks.length,
        regime: marketContext?.marketRegime || 'unknown',
    });

    const text = await ollamaService.generate(prompt, '', { maxTokens: 3000, temperature: 0.3 });
    logger.info('[MarketAnalysis] Weekly report complete', { chars: text.length });
    return text;
}

module.exports = { analyzeMarketWithClaude, analyzeDailyWithClaude };
