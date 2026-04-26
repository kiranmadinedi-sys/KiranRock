const { query } = require('../src/config/database');
const yfClient = require('../src/utils/yfClient');

async function getTopSymbols(limit = 5) {
  const res = await query(`SELECT symbol, quantity, average_price FROM holdings WHERE symbol IS NOT NULL ORDER BY (quantity * COALESCE(average_price,0)) DESC LIMIT $1`, [limit]);
  return res.rows.map(r => r.symbol);
}

async function primeSymbols(symbols, delayMs = 10000) {
  console.log('Priming symbols:', symbols.join(', '));
  for (const s of symbols) {
    try {
      console.log(`Fetching ${s}...`);
      const q = await yfClient.quote(s);
      const price = q && (q.regularMarketPrice || q.price || (q.price && q.price.regularMarketPrice)) || null;
      console.log(`${s} -> ${price}`);
    } catch (e) {
      console.error(`Failed to fetch ${s}:`, e && e.message ? e.message : e);
    }
    console.log(`Waiting ${delayMs}ms before next symbol...`);
    await new Promise(r => setTimeout(r, delayMs));
  }
  console.log('Priming complete');
}

if (require.main === module) (async () => {
  const top = await getTopSymbols(5);
  await primeSymbols(top, 10000);
  process.exit(0);
})();

module.exports = { getTopSymbols, primeSymbols };