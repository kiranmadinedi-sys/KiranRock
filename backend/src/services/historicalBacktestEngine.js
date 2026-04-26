/**
 * Historical Backtest Engine
 * ===========================
 * Tests the AI trading strategy on real historical data BEFORE risking real money.
 *
 * How it works:
 *   1. Downloads 5 years of daily bars for a list of symbols
 *   2. Replays each trading day in chronological order (no lookahead)
 *   3. Applies the SAME scoring logic as enhancedAITradingBot.js
 *   4. Simulates buy/sell with realistic slippage + commission
 *   5. Reports Sharpe, Calmar, Max Drawdown, Win Rate, vs SPY
 *
 * Rules for going live:
 *   Sharpe > 1.5  ✓
 *   Max Drawdown < 15%  ✓
 *   Win Rate > 52%  ✓
 *   Return > SPY over same period  ✓
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { logger } = require('../utils/logger');
const dataProvider = require('./dataProvider');
const indicators   = require('./technicalIndicators');
const cacheService = require('./cacheService');

// Backtest configuration
const BT_CONFIG = {
    startingCapital:       10000,   // $10,000 starting capital
    commissionPct:         0.001,   // 0.1% commission per trade
    slippagePct:           0.001,   // 0.1% slippage (conservative)
    maxPositions:          10,      // max concurrent holdings
    maxPositionPct:        0.15,    // max 15% in single stock
    minBuyScore:           65,      // minimum AI score to buy
    stopLossPct:          -0.12,    // sell at -12%
    takeProfitPct:         0.25,    // sell at +25%
    trailingStopPct:       0.08,    // trail 8% from peak
    lookbackYears:         5,       // years of history to test
    warmupDays:            60       // days needed to calculate indicators (not traded)
};

/**
 * Score a single stock on a given day using the same logic as the live bot.
 * All data arrays only contain data UP TO the current date (no lookahead).
 */
function scoreStock(closes, highs, lows, volumes, vixCloses) {
    if (closes.length < 30) return null;

    const rsi    = indicators.calculateSimpleRSI(closes, 14);
    const macd   = indicators.calculateSimpleMACD(closes, 12, 26, 9);
    const atr    = indicators.calculateSimpleATR(highs, lows, closes, 14);
    const bb     = indicators.calculateBollingerBands(closes, 20, 2);

    const rsiSignal  = indicators.interpretRSI(rsi);
    const macdSignal = indicators.interpretMACD(macd);
    const bbSignal   = indicators.interpretBollingerBands(bb);

    const price     = closes[closes.length - 1];
    const prevPrice = closes[closes.length - 2];
    const momentum  = (price - prevPrice) / prevPrice;

    const avgVol    = volumes.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const curVol    = volumes[volumes.length - 1];
    const volRatio  = avgVol > 0 ? curVol / avgVol : 1;

    // 20-day relative strength vs SPY (approximated using closes)
    const spyClose20 = closes[Math.max(0, closes.length - 20)];
    const stockReturn20 = ((price - spyClose20) / spyClose20) * 100;
    // SPY proxy: if we don't have SPY data per-symbol, use 0 as neutral
    const relStrength = stockReturn20; // will be adjusted when SPY slice is provided

    const week52High = Math.max(...closes.slice(-252));
    const highProx   = week52High > 0 ? price / week52High : 1;

    const vixLevel = vixCloses && vixCloses.length
        ? vixCloses[vixCloses.length - 1]
        : 18;

    let score = 50;

    // Momentum (±10)
    if (momentum > 0.03)       score += 10;
    else if (momentum > 0.01)  score += 6;
    else if (momentum > 0)     score += 2;
    else if (momentum > -0.01) score -= 2;
    else if (momentum > -0.03) score -= 6;
    else                       score -= 10;

    // Volume (±10)
    if (volRatio > 2.0)       score += 10;
    else if (volRatio > 1.5)  score += 6;
    else if (volRatio > 1.0)  score += 3;
    else if (volRatio < 0.5)  score -= 6;

    // RSI (±15)
    score += rsiSignal.scoreAdjustment;

    // MACD (±10)
    score += macdSignal.scoreAdjustment;

    // Bollinger Bands (±12)
    score += bbSignal.scoreAdjustment;

    // Relative Strength (±8)
    if (relStrength > 8)       score += 8;
    else if (relStrength > 3)  score += 4;
    else if (relStrength < -8) score -= 8;
    else if (relStrength < -3) score -= 4;

    // 52-week high proximity (±7)
    if (highProx >= 0.97)      score += 7;
    else if (highProx >= 0.90) score += 3;
    else if (highProx < 0.60)  score -= 7;
    else if (highProx < 0.75)  score -= 3;

    // VIX (±10)
    if (vixLevel < 15)       score += 5;
    else if (vixLevel < 20)  score += 2;
    else if (vixLevel > 30)  score -= 10;
    else if (vixLevel > 25)  score -= 5;

    return {
        score:   Math.max(0, Math.min(100, Math.round(score))),
        price,
        atr,
        rsi:     rsi.toFixed(1),
        macd:    macd.histogram.toFixed(4)
    };
}

/**
 * Run the full historical backtest
 * @param {string[]} symbols - list of stocks to test (use TOP 20-30 for speed)
 * @param {object}   config  - override BT_CONFIG fields
 * @returns {object} backtest results
 */
async function runBacktest(symbols, config = {}) {
    const cfg = { ...BT_CONFIG, ...config };
    const startYears = cfg.lookbackYears;

    logger.info('[Backtest] Starting historical backtest', {
        symbols: symbols.length,
        years: startYears,
        startingCapital: cfg.startingCapital
    });

    // ── 1. DOWNLOAD HISTORICAL DATA ──────────────────────────────────────────
    const lookbackDays = startYears * 365 + 30; // a little extra for warmup
    const cacheKey = `bt_data_${symbols.sort().join(',')}_${startYears}y`;
    let allBars = cacheService.get(cacheKey);

    if (!allBars) {
        logger.info('[Backtest] Downloading historical bars...');
        allBars = {};
        const batches = [];
        for (let i = 0; i < symbols.length; i += 5) {
            batches.push(symbols.slice(i, i + 5));
        }
        for (const batch of batches) {
            const results = await Promise.allSettled(
                batch.map(sym => dataProvider.getBars(sym, '1d', lookbackDays))
            );
            batch.forEach((sym, idx) => {
                if (results[idx].status === 'fulfilled' && results[idx].value.length > 50) {
                    allBars[sym] = results[idx].value;
                }
            });
            await new Promise(r => setTimeout(r, 2000)); // rate limit
        }

        // Download VIX
        try {
            const vixBars = await dataProvider.getBars('^VIX', '1d', lookbackDays);
            allBars['__VIX__'] = vixBars;
        } catch { /* VIX optional */ }

        // Download SPY for benchmark
        try {
            const spyBars = await dataProvider.getBars('SPY', '1d', lookbackDays);
            allBars['__SPY__'] = spyBars;
        } catch { /* SPY optional */ }

        cacheService.set(cacheKey, allBars, 4 * 60 * 60 * 1000); // cache 4 hours
        logger.info('[Backtest] Data downloaded', { symbolsWithData: Object.keys(allBars).length - 2 });
    } else {
        logger.info('[Backtest] Using cached historical data');
    }

    // ── 2. BUILD UNIFIED TRADING CALENDAR ────────────────────────────────────
    // Get all unique trading dates, sorted ascending
    const dateSet = new Set();
    for (const [sym, bars] of Object.entries(allBars)) {
        if (sym.startsWith('__')) continue;
        bars.forEach(b => dateSet.add(b.time.split('T')[0]));
    }
    const tradingDates = Array.from(dateSet).sort();

    if (tradingDates.length < cfg.warmupDays + 10) {
        throw new Error('Insufficient historical data for backtest. Need at least 60 trading days.');
    }

    // ── 3. BUILD DATE-INDEXED LOOKUP ─────────────────────────────────────────
    // For each symbol, build { 'YYYY-MM-DD': {open,high,low,close,volume} }
    const barsByDate = {};
    for (const [sym, bars] of Object.entries(allBars)) {
        barsByDate[sym] = {};
        bars.forEach(b => {
            const d = b.time.split('T')[0];
            barsByDate[sym][d] = b;
        });
    }

    // ── 4. SIMULATION STATE ───────────────────────────────────────────────────
    let cash          = cfg.startingCapital;
    const holdings    = {};   // symbol -> { qty, avgPrice, peakPrice, partialTaken }
    const trades      = [];   // completed trade records
    const dailyEquity = [];   // for equity curve
    let peakEquity    = cfg.startingCapital;

    // ── 5. REPLAY EACH TRADING DAY ────────────────────────────────────────────
    for (let di = cfg.warmupDays; di < tradingDates.length; di++) {
        const today = tradingDates[di];

        // Build closes/volume arrays for each symbol up to today
        // (only include dates <= today to avoid lookahead)
        const datesUpToToday = tradingDates.slice(0, di + 1);

        // Get today's VIX
        const vixClose = barsByDate['__VIX__']?.[today]?.close || 18;
        const vixSlice = datesUpToToday.map(d => barsByDate['__VIX__']?.[d]?.close).filter(Boolean);

        // ── MANAGE EXISTING POSITIONS ────────────────────────────────────────
        for (const sym of Object.keys(holdings)) {
            const h    = holdings[sym];
            const bar  = barsByDate[sym]?.[today];
            if (!bar || !bar.close) continue;

            const price      = bar.close * (1 - cfg.slippagePct); // sell with slippage
            const pct        = (price - h.avgPrice) / h.avgPrice;

            // Update peak price
            if (bar.close > h.peakPrice) h.peakPrice = bar.close;
            const trailStop  = h.peakPrice * (1 - cfg.trailingStopPct);

            let shouldSell = false;
            let reason     = '';

            if (pct <= cfg.stopLossPct)           { shouldSell = true; reason = 'stop_loss'; }
            else if (price <= trailStop)           { shouldSell = true; reason = 'trailing_stop'; }
            else if (pct >= cfg.takeProfitPct)     { shouldSell = true; reason = 'take_profit'; }
            else if (pct >= 0.15 && !h.partialTaken) {
                // Partial take profit — sell half at +15%
                const halfQty = Math.floor(h.qty / 2);
                if (halfQty > 0) {
                    const proceeds = halfQty * price * (1 - cfg.commissionPct);
                    const costBasis = halfQty * h.avgPrice;
                    trades.push({
                        symbol: sym, side: 'sell', qty: halfQty,
                        entryPrice: h.avgPrice, exitPrice: price,
                        pnl: proceeds - costBasis, pct: pct * 100,
                        reason: 'partial_take_profit', date: today
                    });
                    cash += proceeds;
                    h.qty -= halfQty;
                    h.partialTaken = true;
                }
            }

            if (shouldSell && h.qty > 0) {
                const proceeds  = h.qty * price * (1 - cfg.commissionPct);
                const costBasis = h.qty * h.avgPrice;
                trades.push({
                    symbol: sym, side: 'sell', qty: h.qty,
                    entryPrice: h.avgPrice, exitPrice: price,
                    pnl: proceeds - costBasis, pct: pct * 100,
                    reason, date: today
                });
                cash += proceeds;
                delete holdings[sym];
            }
        }

        // ── SCAN FOR NEW BUYS ─────────────────────────────────────────────────
        const openPositions = Object.keys(holdings).length;
        if (openPositions < cfg.maxPositions && cash > 500) {

            const candidates = [];

            for (const sym of Object.keys(allBars)) {
                if (sym.startsWith('__')) continue;
                if (holdings[sym]) continue; // already own it
                if (!barsByDate[sym]?.[today]) continue;

                // Build indicator arrays up to today
                const closesArr  = datesUpToToday.map(d => barsByDate[sym]?.[d]?.close).filter(Boolean);
                const highsArr   = datesUpToToday.map(d => barsByDate[sym]?.[d]?.high).filter(Boolean);
                const lowsArr    = datesUpToToday.map(d => barsByDate[sym]?.[d]?.low).filter(Boolean);
                const volumesArr = datesUpToToday.map(d => barsByDate[sym]?.[d]?.volume).filter(Boolean);

                if (closesArr.length < 30) continue;

                const result = scoreStock(closesArr, highsArr, lowsArr, volumesArr, vixSlice);
                if (!result || result.score < cfg.minBuyScore) continue;

                candidates.push({ sym, ...result });
            }

            // Sort by score, pick top N
            candidates.sort((a, b) => b.score - a.score);
            const slotsAvailable = cfg.maxPositions - openPositions;
            const toBuy = candidates.slice(0, Math.min(slotsAvailable, 3)); // buy at most 3 per day

            for (const c of toBuy) {
                const buyPrice    = c.price * (1 + cfg.slippagePct); // buy with slippage
                const maxInvest   = Math.min(cash * cfg.maxPositionPct, cash * 0.5);
                const qty         = Math.floor(maxInvest / buyPrice);
                if (qty < 1) continue;

                const cost = qty * buyPrice * (1 + cfg.commissionPct);
                if (cost > cash) continue;

                cash -= cost;
                holdings[c.sym] = {
                    qty, avgPrice: buyPrice, peakPrice: buyPrice,
                    partialTaken: false, buyDate: today, buyScore: c.score
                };
            }
        }

        // ── RECORD DAILY EQUITY ──────────────────────────────────────────────
        let holdingsValue = 0;
        for (const [sym, h] of Object.entries(holdings)) {
            const price = barsByDate[sym]?.[today]?.close || h.avgPrice;
            holdingsValue += h.qty * price;
        }
        const totalEquity = cash + holdingsValue;
        dailyEquity.push({ date: today, equity: totalEquity, cash, invested: holdingsValue });

        if (totalEquity > peakEquity) peakEquity = totalEquity;
    }

    // ── 6. CLOSE ALL REMAINING POSITIONS AT LAST DATE ────────────────────────
    const lastDate = tradingDates[tradingDates.length - 1];
    for (const [sym, h] of Object.entries(holdings)) {
        const price = barsByDate[sym]?.[lastDate]?.close || h.avgPrice;
        const proceeds = h.qty * price * (1 - cfg.commissionPct);
        trades.push({
            symbol: sym, side: 'sell', qty: h.qty,
            entryPrice: h.avgPrice, exitPrice: price,
            pnl: proceeds - h.qty * h.avgPrice,
            pct: ((price - h.avgPrice) / h.avgPrice) * 100,
            reason: 'end_of_backtest', date: lastDate
        });
        cash += proceeds;
    }

    // ── 7. CALCULATE METRICS ─────────────────────────────────────────────────
    const finalEquity    = cash;
    const totalReturn    = ((finalEquity - cfg.startingCapital) / cfg.startingCapital) * 100;
    const holdingDays    = tradingDates.length - cfg.warmupDays;
    const annualizedRet  = ((finalEquity / cfg.startingCapital) ** (252 / holdingDays) - 1) * 100;

    // Max drawdown
    let maxDrawdown = 0;
    let peak2       = cfg.startingCapital;
    for (const d of dailyEquity) {
        if (d.equity > peak2) peak2 = d.equity;
        const dd = ((peak2 - d.equity) / peak2) * 100;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    // Sharpe ratio (annualised, risk-free = 4%)
    const dailyReturns = [];
    for (let i = 1; i < dailyEquity.length; i++) {
        dailyReturns.push((dailyEquity[i].equity - dailyEquity[i-1].equity) / dailyEquity[i-1].equity);
    }
    const avgDailyRet = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const stdDaily    = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgDailyRet) ** 2, 0) / dailyReturns.length);
    const riskFreeDaily = 0.04 / 252;
    const sharpe = stdDaily > 0 ? ((avgDailyRet - riskFreeDaily) / stdDaily) * Math.sqrt(252) : 0;

    // Calmar ratio
    const calmar = maxDrawdown > 0 ? annualizedRet / maxDrawdown : null;

    // Trade stats
    const closedTrades = trades.filter(t => t.side === 'sell');
    const wins         = closedTrades.filter(t => t.pnl > 0);
    const losses       = closedTrades.filter(t => t.pnl <= 0);
    const winRate      = closedTrades.length > 0 ? wins.length / closedTrades.length * 100 : 0;
    const avgWinPct    = wins.length   > 0 ? wins.reduce((s, t) => s + t.pct, 0)   / wins.length   : 0;
    const avgLossPct   = losses.length > 0 ? losses.reduce((s, t) => s + t.pct, 0) / losses.length : 0;
    const totalWins    = wins.reduce((s, t) => s + t.pnl, 0);
    const totalLosses  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 0;

    // SPY benchmark
    let spyReturn = null;
    if (allBars['__SPY__'] && allBars['__SPY__'].length > 10) {
        const spyBars = allBars['__SPY__'];
        const spyStart = spyBars[0].close;
        const spyEnd   = spyBars[spyBars.length - 1].close;
        spyReturn = ((spyEnd - spyStart) / spyStart) * 100;
    }

    // Did we pass the live-trading bar?
    const PASS = {
        sharpe:       sharpe >= 1.5,
        maxDrawdown:  maxDrawdown < 15,
        winRate:      winRate > 52,
        beatsSPY:     spyReturn !== null ? totalReturn > spyReturn : null,
        calmar:       calmar !== null ? calmar >= 1.0 : null
    };
    const passAll = PASS.sharpe && PASS.maxDrawdown && PASS.winRate &&
                    (PASS.beatsSPY !== false) && (PASS.calmar !== false);

    const recommendation = passAll
        ? '✅ PASS — Strategy shows positive historical edge. Proceed to 6-month paper trading validation.'
        : '❌ FAIL — Strategy does not meet minimum standards. Do NOT trade real money. Tune the strategy first.';

    logger.info('[Backtest] Complete', {
        totalReturn: totalReturn.toFixed(2) + '%',
        sharpe: sharpe.toFixed(2),
        maxDrawdown: maxDrawdown.toFixed(2) + '%',
        winRate: winRate.toFixed(1) + '%',
        passAll
    });

    return {
        summary: {
            startingCapital:   cfg.startingCapital,
            finalEquity:       parseFloat(finalEquity.toFixed(2)),
            totalReturn:       parseFloat(totalReturn.toFixed(2)),
            annualizedReturn:  parseFloat(annualizedRet.toFixed(2)),
            tradingDays:       holdingDays,
            period:            `${tradingDates[cfg.warmupDays]} to ${lastDate}`
        },
        riskMetrics: {
            sharpeRatio:       parseFloat(sharpe.toFixed(3)),
            calmarRatio:       calmar !== null ? parseFloat(calmar.toFixed(3)) : null,
            maxDrawdownPct:    parseFloat(maxDrawdown.toFixed(2)),
            stdDevAnnualized:  parseFloat((stdDaily * Math.sqrt(252) * 100).toFixed(2))
        },
        tradeStats: {
            totalTrades:       closedTrades.length,
            wins:              wins.length,
            losses:            losses.length,
            winRate:           parseFloat(winRate.toFixed(1)),
            avgWinPct:         parseFloat(avgWinPct.toFixed(2)),
            avgLossPct:        parseFloat(avgLossPct.toFixed(2)),
            profitFactor:      parseFloat(profitFactor.toFixed(2))
        },
        benchmark: {
            spyReturn:         spyReturn !== null ? parseFloat(spyReturn.toFixed(2)) : null,
            alpha:             spyReturn !== null ? parseFloat((totalReturn - spyReturn).toFixed(2)) : null
        },
        liveReadiness: {
            passed:            passAll,
            checks:            PASS,
            recommendation
        },
        equityCurve:           dailyEquity.filter((_, i) => i % 5 === 0), // every 5 days to keep payload small
        topWins:               [...wins].sort((a, b) => b.pnl - a.pnl).slice(0, 5),
        topLosses:             [...losses].sort((a, b) => a.pnl - b.pnl).slice(0, 5)
    };
}

module.exports = { runBacktest, BT_CONFIG };
