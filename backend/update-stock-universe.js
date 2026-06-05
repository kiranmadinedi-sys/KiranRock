// update-stock-universe.js
// Fetches top 1000 US stocks by market cap using Yahoo Finance and updates the stock universe

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const UNIVERSE_FILE = path.join(__dirname, 'top1000_tickers.json');
const SERVICE_FILE = path.join(__dirname, 'src/services/stockUniverseService.js');

async function fetchTopTickers() {
  // Yahoo screener API for US stocks by market cap (pagination: 100 per page)
  let tickers = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?count=100&offset=${offset}&scrIds=most_actives&lang=en-US&region=US`;
    try {
      const res = await axios.get(url);
      const quotes = res.data?.finance?.result?.[0]?.quotes || [];
      tickers.push(...quotes.map(q => q.symbol));
    } catch (e) {
      console.error('Error fetching tickers:', e.message);
      break;
    }
  }
  // Remove duplicates and filter for valid tickers
  tickers = Array.from(new Set(tickers)).filter(t => /^[A-Z.]+$/.test(t));
  return tickers.slice(0, 1000);
}

(async () => {
  const tickers = await fetchTopTickers();
  if (tickers.length < 500) {
    console.error('Failed to fetch enough tickers. Got:', tickers.length);
    return;
  }
  fs.writeFileSync(UNIVERSE_FILE, JSON.stringify(tickers, null, 2));
  // Update stockUniverseService.js
  let content = fs.readFileSync(SERVICE_FILE, 'utf8');
  content = content.replace(/const STATIC_STOCK_UNIVERSE = \[[\s\S]*?\];/, `const STATIC_STOCK_UNIVERSE = [\n  '${tickers.join("',\n  '")}'\n];`);
  fs.writeFileSync(SERVICE_FILE, content);
  console.log(`Updated stock universe with ${tickers.length} tickers.`);
})();
