// automate-claude-analysis.js
// Node.js script to automate Claude Code CLI for pre-market stock analysis
// Ensures benefit: runs before market open, logs results, and handles errors gracefully

const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const CLAUDE_PROMPT = path.join(__dirname, 'CLAUDE.md');
const OUTPUT_LOG = path.join(__dirname, 'claude_analysis_output.txt');
const ERROR_LOG = path.join(__dirname, 'claude_analysis_error.txt');

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
    console.log('Claude analysis completed. Results saved to claude_analysis_output.txt');
  });
}

// Run the analysis
runClaudeAnalysis();
