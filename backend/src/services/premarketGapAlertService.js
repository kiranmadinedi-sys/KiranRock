/**
 * Pre-Market Gap Alert Service
 *
 * Runs at 8:30 AM ET Mon–Fri, ~60 minutes before open.
 * For every top-scored signal from last night's scan it:
 *   1. Pulls the current pre-market price from Yahoo Finance
 *   2. Compares it against the nightly scan entry price
 *   3. Buckets stocks into: CHASE (gap >+2%), VALID (−1% to +2%), BELOW (gap <−1.5%)
 *   4. Sends a Telegram briefing to all active trading users
 *
 * This prevents entering stale prices after a strong overnight / pre-market move.
 */

'use strict';

const axios          = require('axios');
const YahooFinance   = require('yahoo-finance2').default;
const yf             = new YahooFinance();
const { query }      = require('../config/database');
const { logger }     = require('../utils/logger');
const alertService   = require('./telegramAlertService');
const userDb         = require('./userDatabaseService');

const GAP_CHASE_PCT  =  2.0;   // gap UP by this % → wait for pullback
const GAP_BELOW_PCT  = -1.5;   // gap DOWN by this % → potential better entry

// ── Polygon snapshot (preferred — no 429 risk, real-time last trade) ──────────
async function _fetchViaPolygon(symbol) {
    const key = process.env.POLYGON_API_KEY;
    if (!key) return null;
    try {
        const url  = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${symbol}`;
        const resp = await axios.get(url, { params: { apiKey: key }, timeout: 6000 });
        const t    = resp.data?.ticker;
        if (!t) return null;
        const lastTrade = t.lastTrade?.p   ?? t.day?.c ?? null;
        const prevClose = t.prevDay?.c     ?? null;
        if (!lastTrade || !prevClose) return null;
        return { preMarket: lastTrade, prevClose, isExtended: true };
    } catch {
        return null;
    }
}

// ── Yahoo Finance fallback (free, but 429-prone at scale) ─────────────────────
async function _fetchViaYahoo(symbol) {
    try {
        const q = await yf.quote(symbol, {}, { validateResult: false });
        const preMarket = q.preMarketPrice ?? q.regularMarketPrice ?? null;
        const prevClose = q.regularMarketPrice ?? null;
        if (!preMarket || !prevClose) return null;
        return { preMarket, prevClose, isExtended: q.preMarketPrice != null };
    } catch {
        return null;
    }
}

// ── Fetch pre-market price: Polygon first, Yahoo fallback ─────────────────────
async function _fetchPremarketPrice(symbol) {
    return (await _fetchViaPolygon(symbol)) ?? (await _fetchViaYahoo(symbol));
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function runPremarketGapAlert() {
    logger.info('[GapAlert] Starting pre-market gap scan');

    // 1. Load top signals (≥85 score) from the most recent nightly scan
    let signals = [];
    try {
        const res = await query(`
            SELECT
                symbol,
                ai_score        AS "aiScore",
                sector,
                recommendation,
                (metadata->>'entry')::numeric        AS entry,
                (metadata->>'daysToEarnings')::int   AS "daysToEarnings"
            FROM daily_universe_analysis
            WHERE analysis_date = (
                SELECT MAX(analysis_date)
                FROM daily_universe_analysis
                WHERE analysis_date >= CURRENT_DATE - INTERVAL '2 days'
            )
            AND recommendation IN ('STRONG BUY', 'BUY')
            AND ai_score >= 85
            ORDER BY ai_score DESC
            LIMIT 25
        `);
        signals = res.rows.filter(r => r.entry != null && parseFloat(r.entry) > 0);
    } catch (err) {
        logger.error('[GapAlert] DB query failed', { error: err.message });
        return;
    }

    if (signals.length === 0) {
        logger.warn('[GapAlert] No signals with entry prices — skipping');
        return;
    }

    // 2. Fetch pre-market quotes — throttled to avoid Yahoo 429s
    const gaps = [];
    for (const sig of signals) {
        const data = await _fetchPremarketPrice(sig.symbol);
        if (!data?.preMarket) continue;

        const entry   = parseFloat(sig.entry);
        const gapPct  = ((data.preMarket - entry) / entry) * 100;
        gaps.push({
            symbol:        sig.symbol,
            sector:        sig.sector,
            aiScore:       sig.aiScore,
            entry,
            preMarket:     data.preMarket,
            gapPct,
            isExtended:    data.isExtended,
            daysToEarnings: sig.daysToEarnings,
        });

        // Small pause — Yahoo rate-limits aggressive bulk fetches
        await new Promise(r => setTimeout(r, 150));
    }

    if (gaps.length === 0) {
        logger.info('[GapAlert] No pre-market prices available yet — market may not be open');
        return;
    }

    // 3. Bucket results
    const chasing  = gaps.filter(g => g.gapPct >= GAP_CHASE_PCT).sort((a, b) => b.gapPct - a.gapPct);
    const valid    = gaps.filter(g => g.gapPct > GAP_BELOW_PCT && g.gapPct < GAP_CHASE_PCT)
                        .sort((a, b) => b.aiScore - a.aiScore);
    const below    = gaps.filter(g => g.gapPct <= GAP_BELOW_PCT).sort((a, b) => a.gapPct - b.gapPct);

    // 4. Build Telegram message
    const etTime = new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', hour12: true
    });

    const lines = [
        `⚡ *Pre-Market Gap Briefing* · ${etTime} ET`,
        `_${gaps.length} signals checked · open in ~60 min_`,
        '',
    ];

    if (chasing.length) {
        lines.push('🚫 *Chasing risk — gapped >2% above entry:*');
        chasing.forEach(g => {
            const earn = g.daysToEarnings != null ? ` · ${g.daysToEarnings}d earn` : '';
            lines.push(`  • *${g.symbol}* | entry $${g.entry.toFixed(2)} → $${g.preMarket.toFixed(2)} | *+${g.gapPct.toFixed(1)}%*${earn}`);
        });
        lines.push('_⚠ Wait for a pullback to the entry zone before buying_');
        lines.push('');
    }

    if (valid.length) {
        lines.push('✅ *Entry valid — within pre-market range:*');
        valid.slice(0, 10).forEach(g => {
            const sign = g.gapPct >= 0 ? '+' : '';
            const earn = g.daysToEarnings != null && g.daysToEarnings <= 7 ? ` ⚠ ${g.daysToEarnings}d earn` : '';
            lines.push(`  • *${g.symbol}* (${g.aiScore}) | $${g.preMarket.toFixed(2)} | ${sign}${g.gapPct.toFixed(1)}%${earn}`);
        });
        lines.push('');
    }

    if (below.length) {
        lines.push('📉 *Gapping below entry — potential better price:*');
        below.forEach(g => {
            lines.push(`  • *${g.symbol}* | entry $${g.entry.toFixed(2)} → $${g.preMarket.toFixed(2)} | ${g.gapPct.toFixed(1)}%`);
        });
        lines.push('_Consider tightening stop or waiting for stabilisation_');
    }

    lines.push('');
    lines.push('_Pre-market prices are indicative — confirm at open._');

    const message = lines.join('\n');

    // 5. Broadcast to all active users
    try {
        const users = await userDb.getUsersWithAITradingEnabled();
        if (!users?.length) {
            logger.warn('[GapAlert] No active users found');
            return;
        }
        await alertService.broadcastToUsers(users.map(u => u.id), message);
        logger.info('[GapAlert] Alert sent', {
            users: users.length, chasing: chasing.length,
            valid: valid.length, below: below.length
        });
    } catch (err) {
        logger.error('[GapAlert] Broadcast failed', { error: err.message });
    }
}

module.exports = { runPremarketGapAlert };
