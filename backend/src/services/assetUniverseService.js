/**
 * Asset Universe Service
 * ======================
 * Production-grade symbol universe management.
 *
 * Layers:
 *   1. Master DB  — all active Alpaca US equity assets (~11k symbols)
 *   2. Daily DB   — filtered, quoted, RS-scored analysis universe
 *   3. Blacklist  — symbols to never touch
 *   4. Halts      — intraday halt tracking
 *
 * Designed to be purely additive. If Alpaca keys are missing OR the daily
 * universe is empty, marketScreenerService falls back to its static lists
 * automatically — the existing system is never broken.
 *
 * Key APIs consumed by other services:
 *   getDailyUniverseSymbols()  → string[]  (marketScreenerService calls this)
 *   isBlacklisted(symbol)      → boolean
 *   isHalted(symbol)           → boolean
 *   addDynamicSymbol(symbol)   → void  (intraday discovery)
 */

const https   = require('https');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

// ── Alpaca REST helper ────────────────────────────────────────────────────────

function getAlpacaBaseHost() {
    const isPaper = process.env.ALPACA_PAPER !== 'false';
    return isPaper ? 'paper-api.alpaca.markets' : 'api.alpaca.markets';
}

function alpacaRequest(path, timeoutMs = 30000) {
    const KEY_ID = process.env.ALPACA_KEY_ID;
    const SECRET = process.env.ALPACA_SECRET_KEY;
    if (!KEY_ID || !SECRET) {
        return Promise.reject(new Error('Alpaca keys not configured'));
    }

    return new Promise((resolve, reject) => {
        let data = '';
        const req = https.request({
            hostname: getAlpacaBaseHost(),
            path,
            method:   'GET',
            headers: {
                'APCA-API-KEY-ID':     KEY_ID,
                'APCA-API-SECRET-KEY': SECRET,
                'Accept':              'application/json'
            }
        }, (res) => {
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error(`Alpaca JSON parse failed: ${e.message}`)); }
            });
        });
        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error(`Alpaca request timed out: ${path}`));
        });
        req.on('error', reject);
        req.end();
    });
}

// ── Master asset refresh (nightly ~8 PM ET) ──────────────────────────────────

async function fetchAlpacaAssets() {
    const assets = await alpacaRequest('/v2/assets?status=active&asset_class=us_equity');
    if (!Array.isArray(assets)) {
        throw new Error(`Unexpected Alpaca response type: ${typeof assets}`);
    }
    return assets;
}

/**
 * Refresh the master asset_universe table from Alpaca.
 * Safe to call any time — uses ON CONFLICT upsert.
 * Returns { inserted, updated, total }
 */
async function refreshMasterAssets() {
    let assets;
    try {
        assets = await fetchAlpacaAssets();
    } catch (err) {
        logger.warn('[AssetUniverse] Cannot refresh master assets', { error: err.message });
        return { skipped: true, reason: err.message };
    }

    // Only US-equity stocks on major exchanges (exclude OTC/pink sheets initially)
    const MAJOR_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'ARCA', 'BATS', 'NYSEARCA', 'AMEX']);
    const valid = assets.filter(a =>
        a.symbol &&
        /^[A-Z]{1,5}$/.test(a.symbol) &&     // simple ticker only
        a.status === 'active' &&
        MAJOR_EXCHANGES.has((a.exchange || '').toUpperCase())
    );

    logger.info('[AssetUniverse] Upserting master assets', {
        total: assets.length,
        afterFilter: valid.length
    });

    let upserted = 0;
    const batchSize = 100;
    for (let i = 0; i < valid.length; i += batchSize) {
        const batch = valid.slice(i, i + batchSize);
        await Promise.all(batch.map(a => query(`
            INSERT INTO asset_universe
                (symbol, name, exchange, asset_class, tradable, shortable,
                 marginable, easy_to_borrow, fractionable, status, last_refreshed_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
            ON CONFLICT (symbol) DO UPDATE SET
                name             = EXCLUDED.name,
                exchange         = EXCLUDED.exchange,
                tradable         = EXCLUDED.tradable,
                shortable        = EXCLUDED.shortable,
                marginable       = EXCLUDED.marginable,
                easy_to_borrow   = EXCLUDED.easy_to_borrow,
                fractionable     = EXCLUDED.fractionable,
                status           = EXCLUDED.status,
                last_refreshed_at = NOW()
        `, [
            a.symbol,
            a.name          || null,
            a.exchange      || null,
            a.class         || 'us_equity',
            a.tradable      === true,
            a.shortable     === true,
            a.marginable    === true,
            a.easy_to_borrow === true,
            a.fractionable  === true,
            a.status        || 'active'
        ])));
        upserted += batch.length;
    }

    logger.info('[AssetUniverse] Master refresh complete', { upserted });
    return { upserted, total: assets.length };
}

// ── Daily analysis universe (nightly + premarket) ────────────────────────────

/**
 * Retrieve tradable symbols from asset_universe for use as additional
 * inputs to marketScreenerService. Excludes blacklisted and halted.
 *
 * Returns a simple string[] — drop-in replacement / supplement for static lists.
 */
async function getDailyUniverseSymbols() {
    try {
        const today = new Date().toISOString().slice(0, 10);
        const result = await query(`
            SELECT symbol FROM asset_universe_daily
            WHERE universe_date = $1
            ORDER BY rs_score DESC NULLS LAST
        `, [today]);

        if (result.rows.length > 0) {
            return result.rows.map(r => r.symbol);
        }

        // Fallback: return tradable symbols from master universe (no price data)
        const master = await query(`
            SELECT symbol FROM asset_universe
            WHERE tradable = true
              AND status = 'active'
              AND exchange IN ('NYSE', 'NASDAQ', 'ARCA', 'BATS')
              AND symbol NOT IN (
                  SELECT symbol FROM asset_blacklist
                  WHERE expires_at IS NULL OR expires_at > NOW()
              )
            ORDER BY symbol
            LIMIT 800
        `);
        return master.rows.map(r => r.symbol);
    } catch (err) {
        logger.warn('[AssetUniverse] getDailyUniverseSymbols failed, returning []', { error: err.message });
        return [];
    }
}

/**
 * Record a symbol into today's daily universe (called after intraday discovery).
 * source: 'velocity' | 'premarket_mover' | 'earnings' | 'manual'
 */
async function addDynamicSymbol(symbol, source = 'velocity', meta = {}) {
    if (!symbol || !/^[A-Z]{1,5}$/.test(symbol)) return;
    if (await isBlacklisted(symbol)) return;

    const today = new Date().toISOString().slice(0, 10);
    try {
        await query(`
            INSERT INTO asset_universe_daily
                (universe_date, symbol, price, volume, market_cap, avg_volume,
                 rs_score, is_velocity, is_premarket_mover, source)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            ON CONFLICT (universe_date, symbol) DO UPDATE SET
                source = EXCLUDED.source,
                is_velocity = asset_universe_daily.is_velocity OR EXCLUDED.is_velocity,
                is_premarket_mover = asset_universe_daily.is_premarket_mover OR EXCLUDED.is_premarket_mover
        `, [
            today,
            symbol,
            meta.price       || null,
            meta.volume      || null,
            meta.marketCap   || null,
            meta.avgVolume   || null,
            meta.rsScore     || null,
            source === 'velocity',
            source === 'premarket_mover',
            source
        ]);
    } catch (err) {
        logger.warn('[AssetUniverse] addDynamicSymbol failed', { symbol, error: err.message });
    }
}

/**
 * Populate today's daily universe from the master DB.
 * Applies minimum filters: tradable + major exchange + not blacklisted.
 * Price/volume filtering happens later in marketScreenerService (it has Yahoo quotes).
 *
 * Runs nightly and optionally pre-market.
 */
async function buildDailyAnalysisUniverse() {
    const today = new Date().toISOString().slice(0, 10);

    // Already built for today?
    const existing = await query(`
        SELECT COUNT(*) AS cnt FROM asset_universe_daily
        WHERE universe_date = $1
    `, [today]);

    if (parseInt(existing.rows[0].cnt, 10) > 0) {
        logger.info('[AssetUniverse] Daily universe already built for today', { today });
        return { skipped: true, date: today };
    }

    // Pull from master universe
    const master = await query(`
        SELECT symbol, exchange FROM asset_universe
        WHERE tradable = true
          AND status   = 'active'
          AND exchange IN ('NYSE','NASDAQ','ARCA','BATS','NYSEARCA','AMEX')
          AND symbol NOT IN (
              SELECT symbol FROM asset_blacklist
              WHERE expires_at IS NULL OR expires_at > NOW()
          )
    `);

    if (master.rows.length === 0) {
        logger.warn('[AssetUniverse] Master universe empty — run refreshMasterAssets() first');
        return { skipped: true, reason: 'master-empty' };
    }

    let inserted = 0;
    const batchSize = 100;
    for (let i = 0; i < master.rows.length; i += batchSize) {
        const batch = master.rows.slice(i, i + batchSize);
        await Promise.all(batch.map(r => query(`
            INSERT INTO asset_universe_daily (universe_date, symbol, source)
            VALUES ($1, $2, 'master')
            ON CONFLICT (universe_date, symbol) DO NOTHING
        `, [today, r.symbol])));
        inserted += batch.length;
    }

    logger.info('[AssetUniverse] Daily universe built', { date: today, symbols: inserted });
    return { inserted, date: today };
}

// ── Blacklist ─────────────────────────────────────────────────────────────────

async function isBlacklisted(symbol) {
    try {
        const res = await query(`
            SELECT 1 FROM asset_blacklist
            WHERE symbol = $1
              AND (expires_at IS NULL OR expires_at > NOW())
            LIMIT 1
        `, [symbol]);
        return res.rowCount > 0;
    } catch { return false; }
}

async function addToBlacklist(symbol, reason = '', addedBy = 'system', expiresInDays = null) {
    const expiresAt = expiresInDays
        ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
        : null;
    await query(`
        INSERT INTO asset_blacklist (symbol, reason, added_by, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (symbol) DO UPDATE SET
            reason = EXCLUDED.reason,
            added_by = EXCLUDED.added_by,
            expires_at = EXCLUDED.expires_at
    `, [symbol, reason, addedBy, expiresAt]);
    logger.info('[AssetUniverse] Added to blacklist', { symbol, reason, expiresAt });
}

async function removeFromBlacklist(symbol) {
    const res = await query(`DELETE FROM asset_blacklist WHERE symbol = $1`, [symbol]);
    logger.info('[AssetUniverse] Removed from blacklist', { symbol, deleted: res.rowCount });
    return res.rowCount > 0;
}

async function getBlacklist() {
    const res = await query(`
        SELECT symbol, reason, added_by, expires_at, created_at
        FROM asset_blacklist
        WHERE expires_at IS NULL OR expires_at > NOW()
        ORDER BY created_at DESC
    `);
    return res.rows;
}

// ── Halt tracking ─────────────────────────────────────────────────────────────

async function markHalted(symbol, haltType = 'unknown', source = 'system') {
    await query(`
        INSERT INTO asset_halts (symbol, halt_type, source, halted_at)
        VALUES ($1, $2, $3, NOW())
    `, [symbol, haltType, source]);
    logger.warn('[AssetUniverse] Symbol halted', { symbol, haltType });
}

async function markResumed(symbol) {
    await query(`
        UPDATE asset_halts
        SET resumed_at = NOW()
        WHERE symbol = $1 AND resumed_at IS NULL
    `, [symbol]);
    logger.info('[AssetUniverse] Symbol resumed', { symbol });
}

async function isHalted(symbol) {
    try {
        const res = await query(`
            SELECT 1 FROM asset_halts
            WHERE symbol = $1 AND resumed_at IS NULL
            LIMIT 1
        `, [symbol]);
        return res.rowCount > 0;
    } catch { return false; }
}

async function getActiveHalts() {
    const res = await query(`
        SELECT symbol, halt_type, source, halted_at
        FROM asset_halts
        WHERE resumed_at IS NULL
        ORDER BY halted_at DESC
    `);
    return res.rows;
}

// ── Status / stats ────────────────────────────────────────────────────────────

async function getStatus() {
    try {
        const [master, daily, blacklist, halts] = await Promise.all([
            query(`SELECT COUNT(*) AS cnt, MAX(last_refreshed_at) AS refreshed FROM asset_universe`),
            query(`SELECT COUNT(*) AS cnt, universe_date FROM asset_universe_daily WHERE universe_date = CURRENT_DATE GROUP BY universe_date`),
            query(`SELECT COUNT(*) AS cnt FROM asset_blacklist WHERE expires_at IS NULL OR expires_at > NOW()`),
            query(`SELECT COUNT(*) AS cnt FROM asset_halts WHERE resumed_at IS NULL`)
        ]);
        return {
            master:      { count: parseInt(master.rows[0]?.cnt || 0, 10), lastRefreshed: master.rows[0]?.refreshed || null },
            daily:       { count: parseInt(daily.rows[0]?.cnt  || 0, 10), date: daily.rows[0]?.universe_date || null },
            blacklisted: parseInt(blacklist.rows[0]?.cnt || 0, 10),
            halted:      parseInt(halts.rows[0]?.cnt    || 0, 10)
        };
    } catch (err) {
        return { error: err.message };
    }
}

module.exports = {
    refreshMasterAssets,
    buildDailyAnalysisUniverse,
    getDailyUniverseSymbols,
    addDynamicSymbol,
    isBlacklisted,
    addToBlacklist,
    removeFromBlacklist,
    getBlacklist,
    markHalted,
    markResumed,
    isHalted,
    getActiveHalts,
    getStatus
};
