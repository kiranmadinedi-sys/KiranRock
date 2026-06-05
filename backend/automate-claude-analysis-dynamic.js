// automate-claude-analysis-dynamic.js
// Runs Claude Code CLI for stock analysis every 60 minutes using dynamic tickers and historical data from the database
// FIX: Reduced from 820 stocks to top 30, candles from 5 to 3, interval from 30min to 60min
// This prevents the 1M context limit error on Claude CLI

const { getStockUniverse } = require('./src/services/stockUniverseService');
const { getStockData }     = require('./src/services/stockDataService');
const { exec }             = require('child_process');
const fs                   = require('fs');
const path                 = require('path');

const OUTPUT_LOG      = path.join(__dirname, 'claude_analysis_output.txt');
const ERROR_LOG       = path.join(__dirname, 'claude_analysis_error.txt');
const INTERVAL_MINUTES = 60;   // ✅ was 30 — halved to reduce API pressure
const MAX_TICKERS     = 30;    // ✅ was ALL 820 — only top 30 high-conviction stocks
const CANDLES_BACK    = 3;     // ✅ was 5 — last 3 days is enough for trend signals

// ─── Prompt builder ──────────────────────────────────────────────────────────
async function buildPrompt() {
  const allTickers = await getStockUniverse();

  // Only take the top MAX_TICKERS — the universe service returns them ranked
  const tickers = allTickers.slice(0, MAX_TICKERS);

  console.log(`[Claude] Building prompt for ${tickers.length} stocks (of ${allTickers.length} in universe)`);

  let prompt = `You are a concise quantitative analyst. Analyze the following ${tickers.length} stocks using their last ${CANDLES_BACK} days of OHLCV data.\n`;
  prompt += `Focus only on actionable signals. Be brief — one line per stock.\n\n`;

  for (const symbol of tickers) {
    prompt += `=== ${symbol} ===\n`;
    try {
      const candles = await getStockData(symbol, '1d');
      if (candles && candles.length > 0) {
        const recent = candles.slice(-CANDLES_BACK);
        recent.forEach(c => {
          const date = new Date(c.time * 1000).toISOString().slice(0, 10);
          prompt += `${date}: O:${c.open} H:${c.high} L:${c.low} C:${c.close} V:${c.volume}\n`;
        });
      } else {
        prompt += `No recent data.\n`;
      }
    } catch (e) {
      prompt += `Data error.\n`;
    }
  }

  prompt += `\n=== YOUR TASK ===\n`;
  prompt += `1. List the TOP 5 stocks showing the strongest buy signals (momentum, volume, trend).\n`;
  prompt += `2. List 2-3 stocks to AVOID this session.\n`;
  prompt += `3. One sentence overall market tone.\n`;
  prompt += `Keep the total response under 300 words. No disclaimers.`;

  return prompt;
}

// ─── Main analysis runner ─────────────────────────────────────────────────────
async function runClaudeAnalysis() {
  const startTime = Date.now();
  console.log(`[Claude] Starting dynamic analysis at ${new Date().toLocaleString()}`);

  try {
    const prompt     = await buildPrompt();
    const promptFile = path.join(__dirname, 'claude_dynamic_prompt.txt');

    // Save prompt to file for Claude CLI
    fs.writeFileSync(promptFile, prompt);

    // Log prompt size so we can monitor it
    const promptSizeKB = (Buffer.byteLength(prompt, 'utf8') / 1024).toFixed(1);
    console.log(`[Claude] Prompt size: ${promptSizeKB} KB`);

    // Run Claude CLI with standard model (no 1M context needed)
    exec(`claude --model claude-sonnet-4-20250514 < "${promptFile}"`, (err, stdout, stderr) => {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      if (err) {
        const errMsg = `[${new Date().toISOString()}] Claude analysis failed after ${elapsed}s:\n${err}\n${stderr}\n`;
        fs.writeFileSync(ERROR_LOG, errMsg);
        console.error(`[Claude] Analysis failed after ${elapsed}s. See ${ERROR_LOG}`);
        return;
      }

      // Append timestamp to output
      const output = `\n${'─'.repeat(60)}\n[${new Date().toISOString()}] (${elapsed}s)\n${stdout}`;
      fs.writeFileSync(OUTPUT_LOG, output);
      console.log(`[Claude] ✓ Analysis completed in ${elapsed}s`);
    });

  } catch (e) {
    const errMsg = `[${new Date().toISOString()}] Prompt build failed:\n${e}\n`;
    fs.writeFileSync(ERROR_LOG, errMsg);
    console.error('[Claude] Prompt build failed:', e.message);
  }
}

// ─── Scheduler ───────────────────────────────────────────────────────────────
console.log(`[Claude] Dynamic analysis scheduler started`);
console.log(`[Claude] Config: top ${MAX_TICKERS} stocks | last ${CANDLES_BACK} candles | every ${INTERVAL_MINUTES} min`);

// Initial run on startup
runClaudeAnalysis();

// Then every INTERVAL_MINUTES
setInterval(runClaudeAnalysis, INTERVAL_MINUTES * 60 * 1000);
