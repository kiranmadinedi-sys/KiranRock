// automate-claude-analysis-interval.js
// Runs Claude Code CLI for stock analysis every 30 minutes until process is stopped

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLAUDE_PROMPT = path.join(__dirname, 'CLAUDE.md');
const OUTPUT_LOG = path.join(__dirname, 'claude_analysis_output.txt');
const ERROR_LOG = path.join(__dirname, 'claude_analysis_error.txt');
const INTERVAL_MINUTES = 30;

function runClaudeAnalysis() {
  if (!fs.existsSync(CLAUDE_PROMPT)) {
    fs.writeFileSync(ERROR_LOG, 'CLAUDE.md prompt file not found.');
    console.error('CLAUDE.md prompt file not found.');
    return;
  }
  exec(`claude /run "${CLAUDE_PROMPT}"`, (err, stdout, stderr) => {
    if (err) {
      fs.writeFileSync(ERROR_LOG, `Claude analysis failed: ${err}\n${stderr}`);
      console.error('Claude analysis failed. See error log for details.');
      return;
    }
    fs.writeFileSync(OUTPUT_LOG, stdout);
    console.log(`[Claude] Analysis completed at ${new Date().toLocaleString()}`);
  });
}

// Initial run
runClaudeAnalysis();

// Schedule every 30 minutes
setInterval(runClaudeAnalysis, INTERVAL_MINUTES * 60 * 1000);
