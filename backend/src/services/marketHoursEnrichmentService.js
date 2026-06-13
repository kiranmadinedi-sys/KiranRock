/**
 * Market-Hours Enrichment Service
 *
 * Adds live price data and real-time trading guidance to nightly scan picks:
 *   • livePrice / changePct / volumeRatio
 *   • entryAssessment  – GOOD_ENTRY | WAIT_FOR_OPEN | HAIRCUT | CAUTION | SKIP | LATE_DAY | REASSESS
 *   • buyTiming        – specific "when to buy" instruction for the current moment
 *   • stopLoss         – ATR-aware stop price + %
 *   • trailingStop     – stock-tier trailing % and dollar amount
 *   • target           – live-price recalculated target
 *
 * Gate logic mirrors the trading bot in enhancedAITradingBot.js:
 *   Opening window (9:30–10:00 AM ET) → wait
 *   Late day (after 3:30 PM ET)       → exits only
 *   Gap >20%                          → SKIP
 *   Gap 12–20%, score <86             → CAUTION
 *   Gap 3–12%                         → score haircut shown
 *   Down >4%                          → REASSESS
 *   Volume <50% avg                   → thin-volume warning
 */

const https = require('https');
const { logger } = require('../utils/logger');

// 5-minute live quote cache — avoids hammering Yahoo Finance on every page load
const _quoteCache = new Map(); // symbol → { data, fetchedAt }
const CACHE_TTL_MS = 5 * 60 * 1000;

// ── ET context ────────────────────────────────────────────────────────────────

function getETContext() {
    const etNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day  = etNow.getDay();
    const mins = etNow.getHours() * 60 + etNow.getMinutes();
    const isWeekday = day >= 1 && day <= 5;
    const isOpen    = isWeekday && mins >= 9 * 60 + 30 && mins < 16 * 60;
    return { mins, isOpen, isWeekday };
}

// ── Yahoo Finance quote fetch ─────────────────────────────────────────────────

function fetchQuoteHTTP(symbol) {
    return new Promise((resolve) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`;
        const req = https.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 6000,
        }, (res) => {
            let raw = '';
            res.on('data', d => raw += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(raw);
                    const meta = json?.chart?.result?.[0]?.meta;
                    if (!meta) return resolve(null);
                    const price     = meta.regularMarketPrice     || null;
                    const prevClose = meta.previousClose          || meta.chartPreviousClose || null;
                    resolve({
                        price,
                        prevClose,
                        open:     meta.regularMarketOpen          || null,
                        volume:   meta.regularMarketVolume        || null,
                        avgVolume: meta.averageDailyVolume3Month  || meta.averageDailyVolume10Day || null,
                        changePercent: price && prevClose
                            ? ((price - prevClose) / prevClose) * 100 : null,
                    });
                } catch { resolve(null); }
            });
        });
        req.on('error',   () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

async function getLiveQuote(symbol) {
    const cached = _quoteCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.data;
    const data = await fetchQuoteHTTP(symbol);
    if (data) _quoteCache.set(symbol, { data, fetchedAt: Date.now() });
    return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Entry assessment ──────────────────────────────────────────────────────────

function assessEntry(changePct, etMins, score) {
    if (etMins >= 9 * 60 + 30 && etMins < 10 * 60) {
        return { rating: 'WAIT_FOR_OPEN', label: '⏳ Wait until 10:00 AM ET — opening volatility', color: 'yellow' };
    }
    if (etMins >= 15 * 60 + 30) {
        return { rating: 'LATE_DAY', label: '🕒 After 3:30 PM ET — exits only today', color: 'gray' };
    }
    if (changePct > 20) {
        return { rating: 'SKIP', label: `🚫 Gapped +${changePct.toFixed(1)}% — dangerous chase, skip`, color: 'red' };
    }
    if (changePct > 12) {
        return score >= 86
            ? { rating: 'PROCEED_CAUTIOUS', label: `⚠️ Gapped +${changePct.toFixed(1)}% — high score qualifies`, color: 'orange' }
            : { rating: 'CAUTION', label: `⚠️ Gapped +${changePct.toFixed(1)}% — requires score ≥ 86 to enter`, color: 'orange' };
    }
    if (changePct > 3) {
        const penalty = Math.round(Math.min(12, changePct));
        const effectiveScore = score - penalty;
        return {
            rating: 'HAIRCUT',
            label:  `📊 Gapped +${changePct.toFixed(1)}% — effective score ~${effectiveScore} after haircut`,
            color:  'yellow',
            scorePenalty: penalty,
            effectiveScore,
        };
    }
    if (changePct < -8) {
        return { rating: 'REASSESS', label: `📉 Down ${Math.abs(changePct).toFixed(1)}% — thesis may have changed`, color: 'red' };
    }
    if (changePct < -4) {
        return { rating: 'REASSESS', label: `📉 Down ${Math.abs(changePct).toFixed(1)}% — monitor closely`, color: 'orange' };
    }
    return { rating: 'GOOD_ENTRY', label: '✅ Within normal range — valid entry window', color: 'green' };
}

// ── Buy-timing guidance ───────────────────────────────────────────────────────

function buildBuyTiming(entry, changePct, livePrice, scanPrice, etMins) {
    const { rating } = entry;

    if (rating === 'WAIT_FOR_OPEN') {
        return `⏳ After 10:00 AM ET: wait for the first 5-min candle to close above $${livePrice.toFixed(2)}, then enter with a limit order within 0.3%.`;
    }
    if (rating === 'LATE_DAY') {
        return `🕒 Too late for new entries today. Manage existing positions; revisit tomorrow morning.`;
    }
    if (rating === 'SKIP') {
        return `🚫 Skip this stock today — gap too large to chase. Set an alert at scan price $${scanPrice?.toFixed(2) ?? '--'} for a future pullback entry.`;
    }
    if (rating === 'CAUTION') {
        return `⚠️ High gap — only enter if score ≥ 86 and you see a 2-min consolidation above $${livePrice.toFixed(2)} after 10:00 AM ET.`;
    }
    if (rating === 'HAIRCUT') {
        return `📊 Mild gap — wait for a micro-pullback toward $${(livePrice * 0.993).toFixed(2)}, then limit buy. Gap reduces effective score; size conservatively.`;
    }
    if (rating === 'REASSESS') {
        return `📉 Stock is down — thesis weakened. Wait for stabilisation; if it holds above $${(livePrice * 0.98).toFixed(2)} on volume, re-evaluate.`;
    }
    if (rating === 'GOOD_ENTRY') {
        return etMins < 10 * 60 + 30
            ? `✅ Optimal window. Enter after 10:00 AM ET with a limit order at or below $${livePrice.toFixed(2)}.`
            : `✅ Good entry now. Limit buy at $${livePrice.toFixed(2)} or place a buy-stop just above the current 5-min high.`;
    }
    return `Monitor price action around $${livePrice.toFixed(2)} and enter on confirmation.`;
}

// ── Stop-loss calculation ─────────────────────────────────────────────────────
// Uses ATR from scan metadata where available; falls back to price-tier defaults.

function calcStopLoss(livePrice, changePct, atr, volatilityRaw) {
    // ATR-aware: stop = 1.5× ATR below entry (minimum 3%, maximum 12%)
    let stopPct;
    if (atr && atr > 0) {
        const atrPct = (atr / livePrice) * 100;
        stopPct = Math.min(12, Math.max(3, atrPct * 1.5));
    } else if (volatilityRaw && volatilityRaw > 0) {
        stopPct = Math.min(12, Math.max(3, volatilityRaw * 1.5));
    } else {
        // Price-tier default
        if (livePrice < 20)        stopPct = 5;
        else if (livePrice < 50)   stopPct = 6;
        else if (livePrice < 200)  stopPct = 7;
        else                       stopPct = 8;
    }

    // Widen slightly on large gap-ups (more volatile open)
    if (changePct > 5)  stopPct = Math.min(12, stopPct + 1.5);
    if (changePct > 10) stopPct = Math.min(12, stopPct + 1.5);

    const stopPrice = livePrice * (1 - stopPct / 100);
    return {
        price:  parseFloat(stopPrice.toFixed(2)),
        pct:    parseFloat(stopPct.toFixed(1)),
        basis:  atr ? 'ATR-based (1.5× ATR)' : 'Price-tier default',
    };
}

// ── Trailing-stop calculation ─────────────────────────────────────────────────
// Tier-based trailing % that adapts to stock volatility and price level.

function calcTrailingStop(livePrice, changePct, atr) {
    let trailPct;

    if (atr && atr > 0) {
        // ATR-relative: trail = 2× ATR
        const atrPct = (atr / livePrice) * 100;
        trailPct = Math.min(15, Math.max(3, atrPct * 2));
    } else {
        // Price-tier defaults
        if (livePrice < 20)        trailPct = 5;
        else if (livePrice < 50)   trailPct = 5;
        else if (livePrice < 100)  trailPct = 6;
        else if (livePrice < 300)  trailPct = 7;
        else                       trailPct = 8;
    }

    // Widen on volatile gap opens
    if (changePct > 5) trailPct = Math.min(15, trailPct + 1);

    const dollarAmount = parseFloat((livePrice * trailPct / 100).toFixed(2));

    let note;
    if (trailPct <= 4) {
        note = 'Tight — mega-cap/low-vol; lock in gains quickly';
    } else if (trailPct <= 7) {
        note = 'Standard — adjust upward as stock rallies';
    } else {
        note = 'Wide — high-beta stock; gives room to breathe';
    }

    return {
        pct:         parseFloat(trailPct.toFixed(1)),
        dollarAmount,
        note,
        instruction: `Set a trailing stop of ${trailPct.toFixed(1)}% ($${dollarAmount.toFixed(2)}) once the position is up 2%.`,
    };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Enriches an array of picks with live market data and trading guidance.
 * Safe to call outside market hours — returns picks unchanged.
 */
async function enrichWithMarketHours(picks, batchSize = 5, batchDelay = 400) {
    const { mins, isOpen } = getETContext();
    if (!isOpen || !picks?.length) return picks;

    let enriched = 0;
    let failed   = 0;

    for (let i = 0; i < picks.length; i += batchSize) {
        const batch = picks.slice(i, i + batchSize);

        await Promise.all(batch.map(async (pick) => {
            const symbol = pick.symbol;
            if (!symbol) return;

            try {
                const quote = await getLiveQuote(symbol);
                if (!quote?.price) { failed++; return; }

                const livePrice   = quote.price;
                const changePct   = quote.changePercent ?? 0;
                const scanPrice   = parseFloat(pick.currentPrice) || 0;
                const volRatio    = (quote.avgVolume > 0 && quote.volume)
                    ? quote.volume / quote.avgVolume : null;

                // Pull ATR from scan metadata if available
                const meta = pick._meta || {};
                const atr         = parseFloat(meta.atr || 0) || null;
                const volatility  = parseFloat(meta.volatility || meta.atr || 0) || null;

                const score = pick.totalScore || pick.score || pick.aiScore || 50;
                const entry = assessEntry(changePct, mins, score);

                const stopLoss     = calcStopLoss(livePrice, changePct, atr, volatility);
                const trailingStop = calcTrailingStop(livePrice, changePct, atr);
                const buyTiming    = buildBuyTiming(entry, changePct, livePrice, scanPrice, mins);

                // Recalculate target from live price
                const expectedMovePct = parseFloat(pick.prediction?.expectedMove) || 0;
                const targetPrice     = expectedMovePct > 0
                    ? parseFloat((livePrice * (1 + expectedMovePct / 100)).toFixed(2))
                    : parseFloat(pick.prediction?.targetPrice) || null;

                // Risk/reward ratio for this live entry
                const reward = targetPrice ? ((targetPrice - livePrice) / livePrice) * 100 : 0;
                const rrRatio = stopLoss.pct > 0 ? parseFloat((reward / stopLoss.pct).toFixed(1)) : null;

                // Volume signal
                let volumeWarning = null;
                if (volRatio !== null && volRatio < 0.5) {
                    volumeWarning = `🔇 Thin volume (${(volRatio * 100).toFixed(0)}% of avg) — weak conviction`;
                } else if (volRatio !== null && volRatio >= 1.5) {
                    volumeWarning = `🔊 Strong volume (${(volRatio * 100).toFixed(0)}% of avg) — confirms move`;
                }

                pick.liveData = {
                    livePrice:    livePrice.toFixed(2),
                    changePct:    changePct.toFixed(2),
                    volumeRatio:  volRatio ? volRatio.toFixed(2) : null,
                    scanPrice:    scanPrice > 0 ? scanPrice : null,
                    priceVsScan:  scanPrice > 0
                        ? (((livePrice - scanPrice) / scanPrice) * 100).toFixed(1) + '%'
                        : null,
                    entry,
                    buyTiming,
                    stopLoss,
                    trailingStop,
                    target: {
                        price:          targetPrice,
                        expectedMovePct: expectedMovePct.toFixed(1),
                        rewardPct:      parseFloat(reward.toFixed(1)),
                    },
                    riskReward:   rrRatio,
                    volumeWarning,
                    marketHours:  true,
                    updatedAt:    new Date().toISOString(),
                };

                // Update display fields to live values
                pick.currentPrice = livePrice.toFixed(2);
                if (pick.prediction && targetPrice) {
                    pick.prediction.targetPrice = targetPrice.toFixed(2);
                }

                enriched++;
            } catch (err) {
                failed++;
                logger.warn('[MarketEnrich] Failed to enrich symbol', { symbol, error: err.message });
            }
        }));

        if (i + batchSize < picks.length) await sleep(batchDelay);
    }

    logger.info('[MarketEnrich] Enrichment complete', { total: picks.length, enriched, failed });
    return picks;
}

module.exports = { enrichWithMarketHours, getETContext };
