/**
 * COMPASS — Sector Navigator (PANTHEON agent)
 *
 * Computes Relative Strength (RS) for each market sector vs SPY over a
 * configurable lookback window.  Results are cached in-process for
 * COMPASS_CACHE_TTL (default 30 min) and exposed as:
 *   { sector: { rs, rank, label } }
 *
 * RS = sector ETF return / SPY return over the lookback period.
 * RS > 1 = outperforming (rotating in), RS < 1 = underperforming (rotating out).
 *
 * Sector ETFs used (liquid, >$1B AUM):
 *   XLK  Technology     XLF  Financials    XLV  Health Care
 *   XLY  Consumer Disc  XLP  Consumer Stap XLE  Energy
 *   XLI  Industrials    XLB  Materials     XLRE Real Estate
 *   XLU  Utilities      XLC  Communication
 */

const cacheService  = require('./cacheService');
const dataProvider  = require('./dataProvider');
const { logger }    = require('../utils/logger');

const SECTOR_ETFS = {
    Technology:            'XLK',
    Financials:            'XLF',
    'Health Care':         'XLV',
    'Consumer Discretionary': 'XLY',
    'Consumer Staples':    'XLP',
    Energy:                'XLE',
    Industrials:           'XLI',
    Materials:             'XLB',
    'Real Estate':         'XLRE',
    Utilities:             'XLU',
    'Communication Services': 'XLC',
};

const LOOKBACK_DAYS   = parseInt(process.env.COMPASS_LOOKBACK_DAYS || '20', 10);
const CACHE_TTL       = parseInt(process.env.COMPASS_CACHE_TTL_MS  || String(30 * 60 * 1000), 10);
const CACHE_KEY       = 'compass_sector_ranks';

/**
 * Return pct change of an asset over `days` bars.
 * Returns null if data unavailable.
 */
async function getSectorReturn(etf, days) {
    try {
        const bars   = await dataProvider.getBars(etf, '1d', days + 5);
        const closes = (bars || []).map(b => b.close).filter(Boolean);
        if (closes.length < 2) return null;
        const start = closes[Math.max(0, closes.length - days)];
        const end   = closes[closes.length - 1];
        return start > 0 ? (end - start) / start : null;
    } catch {
        return null;
    }
}

/**
 * Fetch RS ranks for all tracked sectors.
 * Returns a map: sector → { rs, rank, label, etf }
 * rank 1 = strongest sector.
 */
async function getSectorRanks() {
    const cached = cacheService.get(CACHE_KEY);
    if (cached) return cached;

    const spyReturn = await getSectorReturn('SPY', LOOKBACK_DAYS);

    const entries = await Promise.all(
        Object.entries(SECTOR_ETFS).map(async ([sector, etf]) => {
            const sectorReturn = await getSectorReturn(etf, LOOKBACK_DAYS);
            const rs = (sectorReturn !== null && spyReturn && spyReturn !== 0)
                ? sectorReturn / Math.abs(spyReturn)
                : null;
            return { sector, etf, sectorReturn, rs };
        })
    );

    // Sort by RS descending and assign rank
    const valid = entries.filter(e => e.rs !== null);
    valid.sort((a, b) => b.rs - a.rs);

    const result = {};
    valid.forEach((e, i) => {
        const label = i < 3 ? 'rotating_in' : i >= valid.length - 3 ? 'rotating_out' : 'neutral';
        result[e.sector] = {
            etf:    e.etf,
            rs:     Number(e.rs.toFixed(3)),
            rank:   i + 1,
            label,
            return: e.sectorReturn !== null ? Number((e.sectorReturn * 100).toFixed(2)) : null
        };
    });

    // Include sectors with no data as neutral
    Object.keys(SECTOR_ETFS).forEach(sector => {
        if (!result[sector]) {
            result[sector] = { etf: SECTOR_ETFS[sector], rs: null, rank: null, label: 'neutral', return: null };
        }
    });

    cacheService.set(CACHE_KEY, result, CACHE_TTL);

    logger.info('[COMPASS] Sector RS ranks refreshed', {
        lookbackDays: LOOKBACK_DAYS,
        top3:    valid.slice(0, 3).map(e => e.sector),
        bottom3: valid.slice(-3).map(e => e.sector)
    });

    return result;
}

/**
 * Get the COMPASS label for a single sector: 'rotating_in' | 'neutral' | 'rotating_out'.
 * Non-blocking — returns 'neutral' on any error.
 */
async function getSectorLabel(sector) {
    try {
        const ranks = await getSectorRanks();
        return ranks[sector]?.label ?? 'neutral';
    } catch {
        return 'neutral';
    }
}

module.exports = { getSectorRanks, getSectorLabel, SECTOR_ETFS };
