/**
 * One-time / occasional sector backfill from Finnhub (2026-10-08).
 *
 * Fills src/services/sectorFinnhubCache.json for every symbol in the current scan universe,
 * recent scans and current holdings that has no known sector yet (static SECTOR_MAP or the
 * learned cache). Rate-limited for Finnhub's free tier (60/min). Progress is saved every 25
 * symbols, so it can be stopped and re-run; already-resolved symbols are skipped.
 * Finally updates the sector column of the two most recent scan dates' rows that were
 * 'Unknown'/NULL, so analytics on those scans reflect real sectors.
 *
 *   node scripts/backfillSectors.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env'), quiet: true });
const fs = require('fs');
const path = require('path');
const { query } = require('../src/config/database');
const sm = require('../src/services/sectorMetadataService');

const OUT = path.join(__dirname, '../src/services/sectorFinnhubCache.json');
const DELAY_MS = 1100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const cache = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
    const save = () => fs.writeFileSync(OUT, JSON.stringify(cache, null, 2));

    const { rows } = await query(`
        SELECT DISTINCT symbol FROM (
            SELECT symbol FROM hermes_symbol_log
             WHERE universe_date = (SELECT MAX(universe_date) FROM hermes_symbol_log) AND passed = true
            UNION SELECT symbol FROM daily_universe_analysis WHERE analysis_date >= CURRENT_DATE - 14
            UNION SELECT symbol FROM holdings WHERE quantity > 0
        ) s`);
    const todo = rows.map(r => r.symbol.toUpperCase())
        .filter(s => !s.includes('/') && !cache[s] && !sm.knownSector(s));
    console.log(`${rows.length} symbols, ${todo.length} without a sector — ~${Math.ceil(todo.length * DELAY_MS / 60000)} min`);

    let found = 0, none = 0, errors = 0;
    const unmapped = {};
    for (let i = 0; i < todo.length; i++) {
        const sym = todo[i];
        try {
            const { sector, industry } = await sm.lookupSectorFromFinnhub(sym);
            if (sector) { cache[sym] = sector; found++; }
            else { none++; if (industry) unmapped[industry] = (unmapped[industry] || 0) + 1; }
        } catch (err) {
            if (err.response?.status === 429) { console.log('rate limited — waiting 60s'); await sleep(60000); i--; continue; }
            errors++;
        }
        if ((i + 1) % 25 === 0) { save(); console.log(`  ${i + 1}/${todo.length}  found ${found}, none ${none}, errors ${errors}`); }
        await sleep(DELAY_MS);
    }
    save();
    console.log(`done: found ${found}, no sector (ETFs/funds/unmapped) ${none}, errors ${errors}`);
    if (Object.keys(unmapped).length) console.log('unmapped Finnhub industries (add to FINNHUB_INDUSTRY_TO_SECTOR):', JSON.stringify(unmapped));

    // Correct the latest two scan dates' rows.
    const dates = (await query(`SELECT DISTINCT analysis_date FROM daily_universe_analysis ORDER BY analysis_date DESC LIMIT 2`)).rows.map(r => r.analysis_date);
    let updated = 0;
    for (const [sym, sector] of Object.entries(cache)) {
        const r = await query(
            `UPDATE daily_universe_analysis SET sector = $1
              WHERE symbol = $2 AND analysis_date = ANY($3::date[]) AND (sector IS NULL OR sector = 'Unknown')`,
            [sector, sym, dates]
        );
        updated += r.rowCount;
    }
    console.log(`scan rows corrected for ${dates.map(d => new Date(d).toISOString().slice(0, 10)).join(', ')}: ${updated}`);
    process.exit(0);
})().catch(err => { console.error('backfill failed:', err.message); process.exit(1); });
