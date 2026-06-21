require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/database');

// Known sectors for current holdings that show as Unknown
const SECTOR_MAP = {
    'GE':   'Industrials',
    'MAR':  'Consumer Discretionary',
    'CROX': 'Consumer Discretionary',
    'PNC':  'Financials',
    'ASML': 'Technology',
    'CARR': 'Industrials',
    'HMN':  'Financials',
    'FITB': 'Financials',
    'LEVI': 'Consumer Discretionary',
    'ROST': 'Consumer Discretionary',
    'MTB':  'Financials',
    // Previously traded
    'TJX':  'Consumer Discretionary',
    'CSX':  'Industrials',
    'TREX': 'Industrials',
    'DRS':  'Industrials',
    'CEVA': 'Technology',
    'ALGM': 'Technology',
    'ARCB': 'Industrials',
    'MRVL': 'Technology',
};

const USER = 'ca632c53-8798-46f4-be94-29be0fede7f2';

async function main() {
    let updated = 0;

    // Update holdings
    for (const [sym, sector] of Object.entries(SECTOR_MAP)) {
        const r = await query(
            `UPDATE holdings SET sector=$1 WHERE user_id=$2 AND symbol=$3 AND (sector IS NULL OR sector='Unknown') RETURNING symbol`,
            [sector, USER, sym]
        );
        if (r.rows.length > 0) { console.log('  holdings: ' + sym + ' → ' + sector); updated++; }
    }

    // Update trades too (so sector caps work retroactively)
    for (const [sym, sector] of Object.entries(SECTOR_MAP)) {
        const r = await query(
            `UPDATE trades SET sector=$1 WHERE user_id=$2 AND symbol=$3 AND (sector IS NULL OR sector='Unknown')`,
            [sector, USER, sym]
        );
        const cnt = r.rowCount;
        if (cnt > 0) console.log('  trades:   ' + sym + ' → ' + sector + ' (' + cnt + ' rows)');
    }

    console.log('\nSector backfill done. ' + updated + ' holdings updated.');
    process.exit(0);
}
main().catch(function(e){ console.error(e.message); process.exit(1); });
