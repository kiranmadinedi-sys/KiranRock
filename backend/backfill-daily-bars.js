/**
 * backfill-daily-bars.js
 * ======================
 * One-time (or scheduled) script to populate the daily_bars table
 * with 1 year of OHLCV data from Yahoo Finance for every symbol
 * the bot has ever traded, plus critical benchmarks (SPY, QQQ, IWM).
 *
 * Run: cd backend && node backfill-daily-bars.js
 *
 * Safe to re-run — upserts on (symbol, timestamp), so no duplicates.
 */

'use strict';

// Bootstrap environment
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const dailyBarsService = require('./src/services/dailyBarsService');

// Benchmark symbols always included regardless of trade history
const BENCHMARKS = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV'];

// How many days of history to fetch
const LOOKBACK_DAYS = 365;

// Delay between requests (ms) — keeps Yahoo Finance happy
const DELAY_MS = 900;

async function run() {
    console.log('');
    console.log('=== KiranRock Daily Bars Backfill ===');
    console.log(`Lookback: ${LOOKBACK_DAYS} days | Delay: ${DELAY_MS}ms/symbol`);
    console.log('');

    try {
        // 1. Get all symbols the bot has traded
        console.log('[1/3] Fetching traded symbols from database...');
        const tradedSymbols = await dailyBarsService.getTradedSymbols();
        console.log(`      Found ${tradedSymbols.length} traded symbols`);

        // 2. Merge with benchmarks (dedup)
        const allSymbols = [...new Set([...BENCHMARKS, ...tradedSymbols])];
        console.log(`      Total to process: ${allSymbols.length} symbols (${BENCHMARKS.length} benchmarks + ${tradedSymbols.length} traded)`);
        console.log('');

        // 3. Backfill
        console.log('[2/3] Fetching OHLCV data from Yahoo Finance...');
        console.log('      (This may take several minutes for large universes)');
        console.log('');

        const result = await dailyBarsService.backfillSymbols(allSymbols, LOOKBACK_DAYS, DELAY_MS);

        console.log('');
        console.log('[3/3] Backfill complete!');
        console.log(`      Symbols fetched:   ${result.fetched}`);
        console.log(`      Total bars stored: ${result.total}`);
        console.log(`      Already current:   ${allSymbols.length - result.fetched} symbols skipped`);
        console.log('');
        console.log('Daily bars table is now populated. You can run:');
        console.log('  GET /api/backtest/ai-analysis  — full Ollama backtest analysis');
        console.log('  GET /api/backtest/stats        — raw quantitative stats');
        console.log('');

    } catch (err) {
        console.error('');
        console.error('[ERROR] Backfill failed:', err.message);
        console.error(err.stack);
        process.exit(1);
    }

    process.exit(0);
}

run();
