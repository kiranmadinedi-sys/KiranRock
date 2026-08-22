const tradingService = require('./tradingService');
const marketQuoteService = require('./marketQuoteService');
const tradingAccountService = require('./tradingAccountService');
const tradesDb = require('./tradesDatabaseService');
const { savePortfolioSnapshot, getRecentSnapshots } = require('./portfolioSnapshotService');
const { buildPortfolioHistory } = require('./portfolioHistoryService');
const brokerService = require('./brokerService');
const userDb = require('./userDatabaseService');
const { getLedgerSummary } = require('./ledgerService');

// Per-user Alpaca data cache — avoids hammering Alpaca on every 30-second frontend poll.
// TTL: 20s during market hours (fresh enough for live display), 5 min outside.
const _alpacaCache = new Map(); // userId -> { positions, equity, cash, fetchedAt }

// Snapshot-guard alert dedup — an unresolved swing can recur across many consecutive
// polls during a sustained episode (e.g. 2026-07-13 had 4 occurrences ~30 min apart);
// one Telegram message per user per hour is enough to know it's happening.
const _lastSnapshotGuardAlert = new Map(); // userId -> timestamp

// Deposit history cache — Alpaca ledger activities rarely change (new deposit = rare event).
// TTL: 24h. Automatically refreshed on the next portfolio fetch after expiry.
const _depositsCache = new Map(); // userId -> { totalDeposited, totalWithdrawn, fetchedAt }
const DEPOSITS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

/**
 * Clear both per-user caches above. Must be called whenever a user's Alpaca
 * credentials change (paper<->live switch, or new keys entirely) — otherwise
 * whichever account was cached first (e.g. the old paper account's ~$100k
 * synthetic starting balance) keeps being served as this user's real deposit
 * total for up to 24h against the NEW account's real numbers, producing a
 * wildly wrong overallPL (found 2026-08-20: showed -$99,000 for a $1,000
 * account that had just been switched from paper to live). Nothing called
 * this before — wired into saveUserAlpacaCredentials/clearUserAlpacaCredentials
 * in userDatabaseService.js.
 */
function clearUserCache(userId) {
    _depositsCache.delete(userId);
    _alpacaCache.delete(userId);
}

async function _getAlpacaNetDeposits(userId) {
    const cached = _depositsCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < DEPOSITS_CACHE_TTL) return cached;

    try {
        // getLedgerSummary already uses the proven REST path (axios to /v2/account/activities)
        // that the Full Ledger section uses — guaranteed to return the correct deposit figure.
        const ledger = await getLedgerSummary(userId);
        if (ledger && ledger.totalDeposits > 0) {
            const entry = {
                totalDeposited: ledger.totalDeposits,
                totalWithdrawn: ledger.totalWithdrawals || 0,
                fetchedAt: Date.now()
            };
            _depositsCache.set(userId, entry);
            return entry;
        }
    } catch (_) { /* Alpaca unreachable or simulated broker — fall through to DB */ }
    return null; // signals caller to fall back to DB-tracked deposits
}

function _isMarketHours() {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric',
        hour12: false, weekday: 'short'
    }).formatToParts(new Date());
    const day  = parts.find(p => p.type === 'weekday').value;
    const hour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const min  = parseInt(parts.find(p => p.type === 'minute').value, 10);
    if (day === 'Sat' || day === 'Sun') return false;
    const t = hour + min / 60;
    return t >= 9.5 && t < 16;
}

/**
 * Whether a SPECIFIC asset's market is open right now — not one global flag
 * for the whole portfolio. us_equity follows NYSE hours; crypto (if this
 * platform ever holds any — it doesn't today, universe is us_equity-only)
 * trades 24/7 and must never be treated as "closed". A blanket market-hours
 * gate would silently freeze a genuinely-moving crypto position's chart.
 */
function _isAssetMarketOpen(assetClass) {
    if (assetClass === 'crypto') return true;
    return _isMarketHours();
}

async function _getAlpacaData(userId, forceRefresh = false) {
    const ttlMs  = _isMarketHours() ? 20_000 : 5 * 60_000;
    const cached = _alpacaCache.get(userId);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < ttlMs) return cached;

    const result = { positions: [], equity: null, cash: null, stopMap: {}, fetchedAt: Date.now() };
    try {
        const [alpacaPositions, alpacaAccount, openOrders] = await Promise.all([
            brokerService.getPositions(userId),
            brokerService.getAccountInfo(userId),
            brokerService.getOpenOrders(userId).catch(() => [])
        ]);
        result.positions = alpacaPositions || [];
        if (alpacaAccount?.portfolioValue > 0) result.equity = alpacaAccount.portfolioValue;
        if (alpacaAccount?.cashBalance   > 0) result.cash   = alpacaAccount.cashBalance;

        // symbol → { stopPrice, targetPrice } — the frontend's "Stop Protection" card was
        // never wired to a real value (always showed "No stop placed" regardless of the
        // actual broker state, found 2026-07-21). getOpenOrders() already includes "held"
        // orders (the status Alpaca gives the waiting side of a bracket/OCO pair), so a
        // real bracket stop-loss leg is correctly picked up here, not just standalone stops.
        for (const o of openOrders) {
            if (o.side !== 'sell') continue;
            const sym = (o.symbol || '').toUpperCase();
            if (!result.stopMap[sym]) result.stopMap[sym] = { stopPrice: null, targetPrice: null };
            if (o.type === 'stop' || o.type === 'stop_limit' || o.type === 'trailing_stop') {
                const sp = parseFloat(o.stop_price || 0);
                if (sp > 0) result.stopMap[sym].stopPrice = sp;
            } else if (o.type === 'limit') {
                const lp = parseFloat(o.limit_price || 0);
                if (lp > 0) result.stopMap[sym].targetPrice = lp;
            }
        }
    } catch (_) { /* simulated broker or creds not configured — ignore */ }

    _alpacaCache.set(userId, result);
    return result;
}

/**
 * Get complete portfolio with real-time valuations
 */
const getPortfolioSummary = async (userId) => {
    try {
        const [holdings, account, trades, firstBuyRows] = await Promise.all([
            tradingService.getHoldings(userId),
            tradingAccountService.getTradingAccount(userId),
            tradingService.getTradeHistory(userId, 1000),
            tradesDb.getFirstBuyDates(userId)
        ]);

        // Build a quick lookup map symbol -> first_bought
        const firstBoughtMap = {};
        (firstBuyRows || []).forEach(r => {
            if (r && r.symbol) firstBoughtMap[r.symbol] = r.first_bought;
        });

        // Fetch Alpaca live positions + equity (cached per-user to avoid hitting Alpaca
        // on every 30-second frontend poll — TTL 20s market hours, 5 min otherwise).
        const alpacaData    = await _getAlpacaData(userId);
        const alpacaPriceMap = {};
        const alpacaAssetClassMap = {};
        for (const p of alpacaData.positions) {
            if (p.symbol && p.currentPrice) alpacaPriceMap[p.symbol] = p.currentPrice;
            if (p.symbol) alpacaAssetClassMap[p.symbol] = p.assetClass || 'us_equity';
        }
        const alpacaEquity = alpacaData.equity;
        const alpacaCash   = alpacaData.cash;
        const stopMap      = alpacaData.stopMap || {};

        // Get current prices for all holdings
        const holdingsWithCurrentPrice = await Promise.all(
            holdings.map(async (holding) => {
                try {
                    // lookup precomputed firstBought for this symbol
                    const firstBought = firstBoughtMap[holding.symbol] || null;

                    // While this asset's own market is closed, hold the last stored price
                    // steady instead of re-pulling a "live" quote — closed-market quotes can
                    // drift a few cents between calls for reasons unrelated to real trading
                    // (settlement/source refresh), which shows up as a phantom move on the
                    // chart even though nothing actually happened. Checked per-asset (not one
                    // global flag) so a 24/7 asset like crypto — if this platform ever holds
                    // one; today's universe is us_equity-only — still gets fresh prices.
                    const assetClass = alpacaAssetClassMap[holding.symbol] || 'us_equity';
                    const hasStoredPrice = holding.currentPrice !== null && holding.currentPrice !== undefined;

                    let currentPrice;
                    if (hasStoredPrice && !_isAssetMarketOpen(assetClass)) {
                        currentPrice = holding.currentPrice;
                    } else {
                        // 1) Alpaca live position price — authoritative for live accounts, never stale
                        // 2) Yahoo Finance fallback — for symbols not currently in Alpaca positions
                        // 3) Cached holding price or cost basis
                        currentPrice = alpacaPriceMap[holding.symbol] ?? null;
                        if (currentPrice === null) {
                            try {
                                currentPrice = await marketQuoteService.getCurrentPrice(holding.symbol);
                            } catch (e) {
                                currentPrice = null;
                            }
                        }
                        if (currentPrice === null || currentPrice === undefined) {
                            currentPrice = holding.currentPrice ?? holding.averagePrice;
                        }
                    }

                    const currentValue = currentPrice * holding.quantity;
                    const costBasis = holding.averagePrice * holding.quantity;
                    const unrealizedPL = currentValue - costBasis;
                    const unrealizedPLPercent = (unrealizedPL / costBasis) * 100;
                    
                    // Compute per-symbol realized P/L using FIFO per-lot matching for exact accounting
                    let realizedPL = 0;
                    try {
                        const symbolTrades = await tradesDb.getSymbolTrades(userId, holding.symbol, 1000);
                        // Sort chronological ascending
                        symbolTrades.sort((a, b) => new Date(a.trade_date) - new Date(b.trade_date));

                        // Use precomputed first-bought map if available to avoid per-symbol scans
                        let firstBought = firstBoughtMap[holding.symbol] || null;

                        // Maintain a queue of buy lots: { qtyRemaining, price, commission }
                        const buyQueue = [];

                        for (const t of symbolTrades) {
                            const action = (t.action || t.type || '').toUpperCase();
                            const qty = parseInt(t.quantity || 0);
                            const price = parseFloat(t.price || 0);
                            const total = parseFloat(t.total || 0) || (price * qty);
                            const commission = parseFloat(t.commission || 0) || 0;

                            if (action === 'BUY') {
                                buyQueue.push({ qtyRemaining: qty, price, commission, originalQty: qty });
                            } else if (action === 'SELL') {
                                let remainingToMatch = qty;
                                let sellProceedsTotal = total;
                                // Allocate commissions proportionally between matched lots if needed
                                while (remainingToMatch > 0 && buyQueue.length > 0) {
                                    const lot = buyQueue[0];
                                    const matchQty = Math.min(remainingToMatch, lot.qtyRemaining);

                                    const cost = lot.price * matchQty;
                                    const proceeds = price * matchQty;

                                    // Pro-rate commissions: buy commission portion and sell commission portion
                                    const buyCommPortion = (lot.commission || 0) * (matchQty / (lot.originalQty || lot.qtyRemaining || matchQty));
                                    const sellCommPortion = commission * (matchQty / qty);

                                    realizedPL += (proceeds - cost - (buyCommPortion || 0) - (sellCommPortion || 0));

                                    // Decrease lot
                                    lot.qtyRemaining -= matchQty;
                                    remainingToMatch -= matchQty;

                                    if (lot.qtyRemaining === 0) buyQueue.shift();
                                }
                                // If sells exceed buys (shouldn't happen normally), compute based on average
                                if (remainingToMatch > 0) {
                                    const avgBuyPrice = holding.averagePrice || 0;
                                    realizedPL += (price - avgBuyPrice) * remainingToMatch - (commission || 0) * (remainingToMatch / qty);
                                }
                            }
                        }
                    } catch (err) {
                        console.error('Error computing realized P/L (FIFO) for', holding.symbol, err.message);
                        realizedPL = 0;
                    }

                    const stopInfo = stopMap[(holding.symbol || '').toUpperCase()] || null;

                    return {
                        ...holding,
                        currentPrice,
                        currentValue,
                        costBasis,
                        unrealizedPL,
                        unrealizedPLPercent,
                        realizedPL,
                        firstBought,
                        stopPrice: stopInfo?.stopPrice ?? null,
                        targetPrice: stopInfo?.targetPrice ?? null
                    };
                } catch (error) {
                    console.error(`Error getting price for ${holding.symbol}:`, error.message);
                    const stopInfo = stopMap[(holding.symbol || '').toUpperCase()] || null;
                    return {
                        ...holding,
                        currentPrice: holding.averagePrice,
                        currentValue: holding.averagePrice * holding.quantity,
                        costBasis: holding.averagePrice * holding.quantity,
                        unrealizedPL: 0,
                        unrealizedPLPercent: 0,
                        priceError: true,
                        firstBought: firstBoughtMap[holding.symbol] || null,
                        stopPrice: stopInfo?.stopPrice ?? null,
                        targetPrice: stopInfo?.targetPrice ?? null
                    };
                }
            })
        );
        
        // Calculate totals
        const totalCurrentValue = holdingsWithCurrentPrice.reduce((sum, h) => sum + h.currentValue, 0);
        const totalCostBasis = holdingsWithCurrentPrice.reduce((sum, h) => sum + h.costBasis, 0);
        const totalUnrealizedPL = totalCurrentValue - totalCostBasis;
        const totalUnrealizedPLPercent = totalCostBasis > 0 ? (totalUnrealizedPL / totalCostBasis) * 100 : 0;
        
        // Calculate realized P/L from closed trades
        const sellTrades = trades.filter(t => t.type === 'SELL');
        const totalRealizedPL = sellTrades.reduce((sum, t) => sum + (t.profitLoss || 0), 0);
        
        // Total portfolio value — prefer Alpaca's own live equity (exact mark-to-market)
        // WHILE at least one held asset is actually trading. If every position's market
        // is currently closed, Alpaca's own equity figure can still drift a few cents
        // between reads for reasons unrelated to real trading (the same closed-market
        // noise the per-holding freeze above guards against) — fall back to the stable,
        // freeze-aware sum instead so the chart doesn't show phantom movement with zero
        // market activity behind it. Checked per-asset, not one global flag, so a mixed
        // portfolio with any 24/7 asset (crypto — none held today) still prefers live equity.
        const anyAssetMarketOpen = holdings.some(h =>
            _isAssetMarketOpen(alpacaAssetClassMap[h.symbol] || 'us_equity')
        );
        let cashBalance = alpacaCash ?? account.balance;
        let totalPortfolioValue = (anyAssetMarketOpen && alpacaEquity != null)
            ? alpacaEquity
            : (cashBalance + totalCurrentValue);

        // Sanity guard: a transient Alpaca read (cash/equity briefly out of sync — e.g. a
        // pending order momentarily holding cash, or Alpaca's own account-side reconciliation
        // hiccups) has repeatedly produced snapshots wildly below the account's real value
        // (25+ instances found across this account's history, 2026-07-11). Comparing only
        // against the single most-recent snapshot has a poisoning problem, confirmed
        // 2026-07-13: once one bad reading gets saved, it becomes the baseline for the next
        // comparison too — so a real recovery back to the correct value can look like *it's*
        // the anomaly, and the bad value can persist for many cycles (that day, cash reading
        // sat wrong for 90 minutes across 4 separate snapshots, market hours, zero orders to
        // explain it). Instead, baseline against the MEDIAN of the last several snapshots in
        // a rolling window — a single bad save (or even a few) can't outvote enough good ones,
        // so the comparison point stays trustworthy even right after a bad save slipped through.
        // If every retry still disagrees wildly with recent history, the point is left
        // unconfirmed — skipSnapshotSave keeps it out of portfolio_snapshots entirely rather
        // than writing a "best guess" that the chart's outlier filter would only clean up an
        // hour later. The live figure returned to the caller this request is untouched either
        // way — this only affects whether the number gets written to history.
        let skipSnapshotSave = false;
        try {
            // Window tuned against the actual 2026-07-13 incident: a 1hr/5-sample window
            // degraded to majority-bad by the 2nd-3rd consecutive bad save (good history
            // aged out too quickly); 3hr/10-samples kept the median correctly anchored on
            // the true value through all 4 consecutive bad reads that day.
            const recentSnapshots = await getRecentSnapshots(userId, { limit: 10, withinMs: 3 * 60 * 60 * 1000 });
            const recentValues = recentSnapshots
                .map(s => parseFloat(s.totalPortfolioValue || 0))
                .filter(v => v > 0)
                .sort((a, b) => a - b);

            if (recentValues.length > 0) {
                const mid = Math.floor(recentValues.length / 2);
                const baselineValue = recentValues.length % 2 === 0
                    ? (recentValues[mid - 1] + recentValues[mid]) / 2
                    : recentValues[mid];

                let deviation = Math.abs(totalPortfolioValue - baselineValue) / baselineValue;
                if (deviation > 0.25) {
                    const gapDollars = totalPortfolioValue - baselineValue;
                    console.warn(`[PortfolioTracking] Suspicious value swing for user ${userId}: ${totalPortfolioValue.toFixed(2)} vs recent median ${baselineValue.toFixed(2)} (n=${recentValues.length}, ${(deviation * 100).toFixed(1)}% dev, gap=$${gapDollars.toFixed(2)})`, {
                        userId, recentValues, baselineValue, totalPortfolioValue, cashBalance, alpacaEquity, alpacaCash,
                        anyAssetMarketOpen
                    });

                    // Cross-check against Alpaca's own activity ledger — a genuine swing this
                    // large always has a matching fill/deposit/withdrawal behind it; a live
                    // "current cash" read with zero corroborating activity is strong independent
                    // evidence the READ itself is bad, not the account. Confirmed 2026-07-13
                    // twice: both incidents had zero orders or activities anywhere near them.
                    const oldestRecentAt = recentSnapshots.length > 0
                        ? recentSnapshots[recentSnapshots.length - 1].capturedAt
                        : new Date(Date.now() - 3 * 60 * 60 * 1000);
                    let corroboratingActivity = [];
                    try {
                        corroboratingActivity = await brokerService.getRecentActivity(userId, oldestRecentAt);
                    } catch (activityErr) {
                        console.warn(`[PortfolioTracking] Activity cross-check failed for user ${userId}: ${activityErr.message} — proceeding on retries alone`);
                    }

                    if (corroboratingActivity.length > 0) {
                        // Log what was actually found and whether its dollar size plausibly explains
                        // the gap — "an activity exists somewhere in the window" is not the same as
                        // "an activity this large happened." A $373 sale corroborating a $2,857 gap
                        // is a false-positive pattern (2026-07-28 incident) this line exists to catch.
                        const activityDetail = corroboratingActivity.map(a => {
                            const amount = a.net_amount != null
                                ? parseFloat(a.net_amount)
                                : (a.price != null && a.qty != null ? parseFloat(a.price) * parseFloat(a.qty) : null);
                            return { type: a.activity_type, symbol: a.symbol || null, amount, time: a.transaction_time || a.date || null };
                        });
                        const explainedMagnitude = activityDetail.reduce((sum, a) => sum + Math.abs(a.amount || 0), 0);
                        const gapMagnitude = Math.abs(gapDollars);
                        const adequatelyExplained = explainedMagnitude >= gapMagnitude * 0.75;
                        console.warn(`[PortfolioTracking] Swing corroborated by ${corroboratingActivity.length} real activity event(s) for user ${userId} — treating as a genuine move, not retrying/skipping. ${adequatelyExplained ? 'Activity size covers the gap.' : '⚠️ WEAK CORROBORATION — activity size does NOT plausibly cover the gap, may be a false-positive pass-through'}`, {
                            userId, oldestRecentAt, activityDetail, explainedMagnitude, gapMagnitude, adequatelyExplained
                        });
                    } else {
                        console.warn(`[PortfolioTracking] No corroborating activity found for user ${userId} since ${new Date(oldestRecentAt).toISOString()} — retrying with fresh Alpaca fetches`);
                        const MAX_ATTEMPTS = 3;
                        const RETRY_DELAY_MS = 2000;
                        for (let attempt = 1; attempt <= MAX_ATTEMPTS && deviation > 0.25; attempt++) {
                            if (attempt > 1) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                            const fresh = await _getAlpacaData(userId, true);
                            const retriedCashBalance = fresh.cash ?? account.balance;
                            const retriedTotalPortfolioValue = fresh.equity ?? (retriedCashBalance + totalCurrentValue);
                            const retriedDeviation = Math.abs(retriedTotalPortfolioValue - baselineValue) / baselineValue;
                            console.warn(`[PortfolioTracking] Retry ${attempt} raw Alpaca fetch for user ${userId}`, {
                                userId, attempt, rawCash: fresh.cash, rawEquity: fresh.equity, positionCount: fresh.positions?.length ?? 0,
                                retriedTotalPortfolioValue, retriedDeviation
                            });
                            if (retriedDeviation < deviation) {
                                cashBalance = retriedCashBalance;
                                totalPortfolioValue = retriedTotalPortfolioValue;
                                deviation = retriedDeviation;
                                console.warn(`[PortfolioTracking] Retry ${attempt} corrected value to ${totalPortfolioValue.toFixed(2)} for user ${userId} (${(deviation * 100).toFixed(1)}% dev remaining)`);
                            } else {
                                console.warn(`[PortfolioTracking] Retry ${attempt} did not improve for user ${userId} — ${attempt < MAX_ATTEMPTS ? 'trying again' : 'no corroborating activity and no successful retry'}`);
                            }
                        }

                        if (deviation > 0.25) {
                            skipSnapshotSave = true;
                            console.warn(`[PortfolioTracking] Unresolved, uncorroborated swing for user ${userId} after ${MAX_ATTEMPTS} attempts (${(deviation * 100).toFixed(1)}% dev vs median ${baselineValue.toFixed(2)}) — skipping snapshot save, not writing an unconfirmed value to history`);

                            const lastAlerted = _lastSnapshotGuardAlert.get(userId) || 0;
                            if (Date.now() - lastAlerted > 60 * 60 * 1000) {
                                _lastSnapshotGuardAlert.set(userId, Date.now());
                                try {
                                    const tg = require('./telegramAlertService');
                                    await tg.sendMessage(userId,
                                        `⚠️ *Portfolio Data Guard*\n\n` +
                                        `A suspicious account-value reading ($${totalPortfolioValue.toFixed(2)} vs recent median $${baselineValue.toFixed(2)}, ${(deviation * 100).toFixed(1)}% off) couldn't be confirmed after ${MAX_ATTEMPTS} retries, and no matching order/deposit/withdrawal explains it — most likely a momentary broker-side or connectivity glitch.\n\n` +
                                        `Skipped saving it to your chart history rather than showing a possibly-wrong number. Your actual funds are unaffected — this only concerns what gets displayed.`
                                    );
                                } catch (_alertErr) { /* best-effort */ }
                            }
                        }
                    }
                }
            }
        } catch (_guardErr) { /* best-effort — never block a real portfolio fetch on this check */ }

        // Net deposits — prefer Alpaca activities (source of truth for real/paper accounts).
        // Falls back to KiranRock's own DEPOSIT/WITHDRAWAL rows in the trades table when
        // Alpaca is not configured (simulated broker) or the activities call fails.
        const alpacaDeposits = await _getAlpacaNetDeposits(userId);
        const totalDeposited = alpacaDeposits?.totalDeposited ?? account.totalDeposited;
        const totalWithdrawn = alpacaDeposits?.totalWithdrawn ?? account.totalWithdrawn;
        const totalInvested  = totalDeposited - totalWithdrawn;

        // Overall return
        const overallPL = totalPortfolioValue - totalInvested;
        const overallReturn = totalInvested > 0 ? (overallPL / totalInvested) * 100 : 0;

        const portfolioSummary = {
            account: {
                cashBalance,
                totalDeposited,
                totalWithdrawn,
                depositsSource: alpacaDeposits ? 'alpaca' : 'db'
            },
            holdings: holdingsWithCurrentPrice,
            summary: {
                totalHoldingsValue: totalCurrentValue,
                totalCostBasis,
                totalUnrealizedPL,
                totalUnrealizedPLPercent,
                totalRealizedPL,
                totalPortfolioValue,
                totalInvested,
                overallPL,
                overallReturn,
                numberOfPositions: holdings.length,
                cashBalance,
                depositsSource: alpacaDeposits ? 'alpaca' : 'db'
            }
        };

        // A brand-new user has no personal Alpaca keys yet until they add them in
        // Settings — until then, getClientForUser silently falls back to the shared
        // .env paper account, whose balance has nothing to do with this user. Saving a
        // snapshot in that window pollutes their history with someone else's account
        // balance the moment they land on their first dashboard load (confirmed
        // 2026-07-15: a new user's very first snapshot showed the shared paper account's
        // $98,729.11 before their real $1,000 account was even attached).
        if (!skipSnapshotSave && !brokerService.isSimulated) {
            try {
                const creds = await userDb.getUserAlpacaCredentials(userId);
                if (creds.source === 'env') {
                    skipSnapshotSave = true;
                    console.log(`[PortfolioTracking] Skipping snapshot save for user ${userId} — no personal Alpaca credentials yet, would save the shared fallback account's balance`);
                }
            } catch (_credsErr) { /* best-effort — never block a real portfolio fetch on this check */ }
        }

        if (!skipSnapshotSave) {
            try {
                await savePortfolioSnapshot(userId, portfolioSummary.summary, { source: 'portfolio-summary' });
            } catch (snapshotError) {
                console.error('Error saving portfolio snapshot:', snapshotError.message);
            }
        }

        return portfolioSummary;
    } catch (error) {
        console.error('Error getting portfolio summary:', error);
        throw error;
    }
};

/**
 * Get performance analytics
 */
const getPerformanceAnalytics = async (userId) => {
    try {
        const trades = await tradingService.getTradeHistory(userId, 10000);
        
        if (trades.length === 0) {
            return {
                totalTrades: 0,
                winRate: 0,
                averageWin: 0,
                averageLoss: 0,
                largestWin: null,
                largestLoss: null,
                profitFactor: 0,
                bestPerformingStock: null,
                worstPerformingStock: null
            };
        }
        
        const sellTrades = trades.filter(t => t.type === 'SELL');
        
        if (sellTrades.length === 0) {
            return {
                totalTrades: trades.length,
                buyOrders: trades.filter(t => t.type === 'BUY').length,
                sellOrders: 0,
                message: 'No sell trades yet to calculate performance'
            };
        }
        
        // Win/Loss analysis
        const winningTrades = sellTrades.filter(t => t.profitLoss > 0);
        const losingTrades = sellTrades.filter(t => t.profitLoss < 0);
        
        const winRate = (winningTrades.length / sellTrades.length) * 100;
        
        const totalWins = winningTrades.reduce((sum, t) => sum + t.profitLoss, 0);
        const totalLosses = Math.abs(losingTrades.reduce((sum, t) => sum + t.profitLoss, 0));
        
        const averageWin = winningTrades.length > 0 ? totalWins / winningTrades.length : 0;
        const averageLoss = losingTrades.length > 0 ? totalLosses / losingTrades.length : 0;
        
        // Find largest win/loss
        const largestWin = winningTrades.length > 0 
            ? winningTrades.reduce((max, t) => t.profitLoss > max.profitLoss ? t : max)
            : null;
            
        const largestLoss = losingTrades.length > 0
            ? losingTrades.reduce((min, t) => t.profitLoss < min.profitLoss ? t : min)
            : null;
        
        // Profit factor
        const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? 999 : 0;
        
        // Performance by stock
        const stockPerformance = {};
        sellTrades.forEach(trade => {
            if (!stockPerformance[trade.symbol]) {
                stockPerformance[trade.symbol] = {
                    symbol: trade.symbol,
                    trades: 0,
                    totalPL: 0,
                    wins: 0,
                    losses: 0
                };
            }
            stockPerformance[trade.symbol].trades++;
            stockPerformance[trade.symbol].totalPL += trade.profitLoss;
            if (trade.profitLoss > 0) stockPerformance[trade.symbol].wins++;
            else if (trade.profitLoss < 0) stockPerformance[trade.symbol].losses++;
        });
        
        const stockPerfArray = Object.values(stockPerformance);
        const bestPerformingStock = stockPerfArray.length > 0
            ? stockPerfArray.reduce((max, s) => s.totalPL > max.totalPL ? s : max)
            : null;
            
        const worstPerformingStock = stockPerfArray.length > 0
            ? stockPerfArray.reduce((min, s) => s.totalPL < min.totalPL ? s : min)
            : null;
        
        // Trading frequency
        const firstTrade = trades[trades.length - 1];
        const lastTrade = trades[0];
        const daysBetween = (new Date(lastTrade.timestamp) - new Date(firstTrade.timestamp)) / (1000 * 60 * 60 * 24);
        const tradesPerDay = daysBetween > 0 ? trades.length / daysBetween : 0;
        
        return {
            totalTrades: trades.length,
            buyOrders: trades.filter(t => t.type === 'BUY').length,
            sellOrders: sellTrades.length,
            winningTrades: winningTrades.length,
            losingTrades: losingTrades.length,
            winRate: Math.round(winRate * 100) / 100,
            averageWin: Math.round(averageWin * 100) / 100,
            averageLoss: Math.round(averageLoss * 100) / 100,
            largestWin,
            largestLoss,
            profitFactor: Math.round(profitFactor * 100) / 100,
            totalWins,
            totalLosses,
            netProfit: totalWins - totalLosses,
            bestPerformingStock,
            worstPerformingStock,
            stockPerformance: stockPerfArray.sort((a, b) => b.totalPL - a.totalPL),
            tradingFrequency: {
                totalDays: Math.round(daysBetween),
                tradesPerDay: Math.round(tradesPerDay * 100) / 100
            }
        };
    } catch (error) {
        console.error('Error getting performance analytics:', error);
        throw error;
    }
};

/**
 * Get sector allocation from current holdings
 */
const getSectorAllocation = async (userId) => {
    try {
        const holdings = await tradingService.getHoldings(userId);
        
        if (holdings.length === 0) {
            return [];
        }
        
        // This would ideally fetch sector info from fundamentals
        // For now, we'll return a simple structure
        const sectorMap = {};
        
        for (const holding of holdings) {
            const currentPrice = await marketQuoteService.getCurrentPrice(holding.symbol).catch(() => holding.averagePrice);
            const value = currentPrice * holding.quantity;
            
            // You can enhance this by fetching actual sector from fundamentalsService
            const sector = 'Unknown'; // Placeholder
            
            if (!sectorMap[sector]) {
                sectorMap[sector] = {
                    sector,
                    value: 0,
                    stocks: []
                };
            }
            
            sectorMap[sector].value += value;
            sectorMap[sector].stocks.push(holding.symbol);
        }
        
        const sectors = Object.values(sectorMap);
        const totalValue = sectors.reduce((sum, s) => sum + s.value, 0);
        
        return sectors.map(s => ({
            ...s,
            percentage: (s.value / totalValue) * 100
        })).sort((a, b) => b.value - a.value);
        
    } catch (error) {
        console.error('Error getting sector allocation:', error);
        throw error;
    }
};

/**
 * Get risk metrics
 */
const getRiskMetrics = async (userId) => {
    try {
        const holdings = await tradingService.getHoldings(userId);
        const account = await tradingAccountService.getTradingAccount(userId);
        
        if (holdings.length === 0) {
            return {
                diversificationScore: 100,
                message: 'No holdings - fully diversified (all cash)'
            };
        }
        
        // Calculate position sizes
        const totalValue = account.balance + holdings.reduce((sum, h) => 
            sum + (h.quantity * h.averagePrice), 0
        );
        
        const positionSizes = holdings.map(h => {
            const value = h.quantity * h.averagePrice;
            return {
                symbol: h.symbol,
                value,
                percentage: (value / totalValue) * 100
            };
        });
        
        // Diversification score (100 = perfect, lower = concentrated)
        const largestPosition = Math.max(...positionSizes.map(p => p.percentage));
        const diversificationScore = Math.max(0, 100 - (largestPosition * 2));
        
        // Concentration risk
        const top3Concentration = positionSizes
            .sort((a, b) => b.percentage - a.percentage)
            .slice(0, 3)
            .reduce((sum, p) => sum + p.percentage, 0);
        
        return {
            diversificationScore: Math.round(diversificationScore),
            numberOfPositions: holdings.length,
            largestPosition: {
                symbol: positionSizes.reduce((max, p) => p.percentage > max.percentage ? p : max).symbol,
                percentage: Math.round(largestPosition * 100) / 100
            },
            top3Concentration: Math.round(top3Concentration * 100) / 100,
            cashPercentage: Math.round((account.balance / totalValue) * 10000) / 100,
            positionSizes: positionSizes.sort((a, b) => b.percentage - a.percentage)
        };
    } catch (error) {
        console.error('Error getting risk metrics:', error);
        throw error;
    }
};

/**
 * Get portfolio value history for charting
 */
const getPortfolioHistory = async (userId, range = '1D') => {
    const summary = await getPortfolioSummary(userId);
    return buildPortfolioHistory(userId, range, summary.summary);
};

module.exports = {
    getPortfolioSummary,
    getPerformanceAnalytics,
    getSectorAllocation,
    getRiskMetrics,
    getPortfolioHistory,
    clearUserCache
};
