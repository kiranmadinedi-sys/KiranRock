// backfill-stock-prices-controlled.js
// Downloads historical OHLCV for the full HERMES universe (400+ stocks).
// Writes to:
//   stock_prices  — legacy table used by localdataRoutes
//   ohlcv_cache   — primary table used by Ollama DB-enriched ORACLE verdicts

require('./src/bootstrapRuntime');

const { getStockUniverse } = require('./src/services/stockUniverseService');
const { getStockData }     = require('./src/services/stockDataService');
const { query, connect, disconnect } = require('./src/config/database');
const fs   = require('fs');
const path = require('path');

const LOG_FILE    = path.join(__dirname, 'backfill_log.txt');
const ERROR_FILE  = path.join(__dirname, 'backfill_errors.txt');
const LOADED_FILE = path.join(__dirname, 'backfill_loaded_tickers.txt');

// Throttle: ms to wait between symbols (avoids rate-limiting Alpaca)
const DELAY_MS = 300;

async function upsertCandle(symbol, candle) {
    const date   = new Date(candle.time * 1000).toISOString().slice(0, 10);
    const open   = candle.open;
    const high   = candle.high;
    const low    = candle.low;
    const close  = candle.close;
    const volume = candle.volume;

    // stock_prices — legacy table
    await query(`
        INSERT INTO stock_prices (symbol, date, open, high, low, close, volume)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (symbol, date) DO UPDATE SET
            open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
            close=EXCLUDED.close, volume=EXCLUDED.volume
    `, [symbol, date, open, high, low, close, volume]);

    // ohlcv_cache — used by Ollama ORACLE for DB-enriched analysis
    await query(`
        INSERT INTO ohlcv_cache (symbol, date, open, high, low, close, volume)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (symbol, date) DO UPDATE SET
            open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low,
            close=EXCLUDED.close, volume=EXCLUDED.volume
    `, [symbol, date, open, high, low, close, volume]);
}

(async () => {
    await connect();

    const tickers = await getStockUniverse();
    console.log(`[Backfill] Universe: ${tickers.length} symbols`);

    // Reset log files
    fs.writeFileSync(LOG_FILE,    `Backfill started: ${new Date().toISOString()}\n`);
    fs.writeFileSync(ERROR_FILE,  '');
    fs.writeFileSync(LOADED_FILE, '');

    const loaded = [];
    const errors = [];

    for (let i = 0; i < tickers.length; i++) {
        const symbol = tickers[i];
        try {
            const candles = await getStockData(symbol, '1d');
            if (candles && candles.length > 0) {
                for (const candle of candles) {
                    await upsertCandle(symbol, candle);
                }
                loaded.push(symbol);
                fs.appendFileSync(LOG_FILE, `${symbol}: ${candles.length} days OK\n`);
                if ((i + 1) % 25 === 0) {
                    console.log(`[Backfill] Progress: ${i + 1}/${tickers.length} (${loaded.length} loaded, ${errors.length} errors)`);
                }
            } else {
                errors.push({ symbol, error: 'No data' });
                fs.appendFileSync(ERROR_FILE, `${symbol}: No data\n`);
                fs.appendFileSync(LOG_FILE,   `${symbol}: No data\n`);
            }
        } catch (e) {
            errors.push({ symbol, error: e.message });
            fs.appendFileSync(ERROR_FILE, `${symbol}: ${e.message}\n`);
            fs.appendFileSync(LOG_FILE,   `${symbol}: Error - ${e.message}\n`);
        }

        // Throttle to avoid rate-limiting
        if (DELAY_MS > 0 && i < tickers.length - 1) {
            await new Promise(r => setTimeout(r, DELAY_MS));
        }
    }

    fs.writeFileSync(LOADED_FILE, loaded.join('\n'));
    await disconnect();

    console.log(`Backfill complete. Loaded: ${loaded.length}, Errors: ${errors.length}`);
    console.log(`  → stock_prices table: updated`);
    console.log(`  → ohlcv_cache table:  updated (feeds Ollama ORACLE)`);
    if (errors.length > 0) {
        console.log(`  → Failed symbols logged to: backfill_errors.txt`);
    }
})();
