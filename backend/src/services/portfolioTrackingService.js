const tradingService = require('./tradingService');
const marketQuoteService = require('./marketQuoteService');
const tradingAccountService = require('./tradingAccountService');
const tradesDb = require('./tradesDatabaseService');
const { savePortfolioSnapshot, getLatestSnapshot } = require('./portfolioSnapshotService');
const { buildPortfolioHistory } = require('./portfolioHistoryService');
const brokerService = require('./brokerService');
const { getLedgerSummary } = require('./ledgerService');

// Per-user Alpaca data cache — avoids hammering Alpaca on every 30-second frontend poll.
// TTL: 20s during market hours (fresh enough for live display), 5 min outside.
const _alpacaCache = new Map(); // userId -> { positions, equity, cash, fetchedAt }

// Deposit history cache — Alpaca ledger activities rarely change (new deposit = rare event).
// TTL: 24h. Automatically refreshed on the next portfolio fetch after expiry.
const _depositsCache = new Map(); // userId -> { totalDeposited, totalWithdrawn, fetchedAt }
const DEPOSITS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24h

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

async function _getAlpacaData(userId, forceRefresh = false) {
    const ttlMs  = _isMarketHours() ? 20_000 : 5 * 60_000;
    const cached = _alpacaCache.get(userId);
    if (!forceRefresh && cached && Date.now() - cached.fetchedAt < ttlMs) return cached;

    const result = { positions: [], equity: null, cash: null, fetchedAt: Date.now() };
    try {
        const [alpacaPositions, alpacaAccount] = await Promise.all([
            brokerService.getPositions(userId),
            brokerService.getAccountInfo(userId)
        ]);
        result.positions = alpacaPositions || [];
        if (alpacaAccount?.portfolioValue > 0) result.equity = alpacaAccount.portfolioValue;
        if (alpacaAccount?.cashBalance   > 0) result.cash   = alpacaAccount.cashBalance;
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
        for (const p of alpacaData.positions) {
            if (p.symbol && p.currentPrice) alpacaPriceMap[p.symbol] = p.currentPrice;
        }
        const alpacaEquity = alpacaData.equity;
        const alpacaCash   = alpacaData.cash;

        // Get current prices for all holdings
        const holdingsWithCurrentPrice = await Promise.all(
            holdings.map(async (holding) => {
                try {
                    // lookup precomputed firstBought for this symbol
                    const firstBought = firstBoughtMap[holding.symbol] || null;

                    // 1) Alpaca live position price — authoritative for live accounts, never stale
                    // 2) Yahoo Finance fallback — for symbols not currently in Alpaca positions
                    // 3) Cached holding price or cost basis
                    let currentPrice = alpacaPriceMap[holding.symbol] ?? null;
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

                    return {
                        ...holding,
                        currentPrice,
                        currentValue,
                        costBasis,
                        unrealizedPL,
                        unrealizedPLPercent,
                        realizedPL,
                        firstBought
                    };
                } catch (error) {
                    console.error(`Error getting price for ${holding.symbol}:`, error.message);
                    return {
                        ...holding,
                        currentPrice: holding.averagePrice,
                        currentValue: holding.averagePrice * holding.quantity,
                        costBasis: holding.averagePrice * holding.quantity,
                        unrealizedPL: 0,
                        unrealizedPLPercent: 0,
                        priceError: true,
                        firstBought: firstBoughtMap[holding.symbol] || null
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
        
        // Total portfolio value — prefer Alpaca equity for live accounts (exact mark-to-market)
        let cashBalance = alpacaCash ?? account.balance;
        let totalPortfolioValue = alpacaEquity ?? (cashBalance + totalCurrentValue);

        // Sanity guard: a transient Alpaca read (cash/equity briefly out of sync — e.g. a
        // pending order momentarily holding cash, or Alpaca's own account-side reconciliation
        // hiccups, seen 2026-07-13 with zero orders anywhere near the bad read) has repeatedly
        // produced snapshots wildly below the account's real value (25+ instances found across
        // this account's history, 2026-07-11), which then sat permanently in portfolio_snapshots
        // until filtered out downstream at chart-render time. Catch it here instead, before
        // it's ever saved: compare against the last known-good snapshot, and if the deviation
        // is implausible for real trading in this account, force fresh (uncached) Alpaca
        // re-fetches — up to 3 attempts, spaced out, since a single immediate retry can still
        // land inside the same few-second-wide bad-read window (confirmed 2026-07-13: one retry
        // wasn't enough to clear a blip). Best-effort only — never blocks a real portfolio fetch
        // if the check itself fails, and only overrides when a retry actually looks better.
        try {
            const lastSnapshot = await getLatestSnapshot(userId);
            const lastValue = lastSnapshot ? parseFloat(lastSnapshot.totalPortfolioValue || 0) : null;
            const lastAgeMs = lastSnapshot ? Date.now() - new Date(lastSnapshot.capturedAt).getTime() : Infinity;
            // Only compare against a recent baseline — across a real multi-hour/day gap a
            // large swing may be entirely legitimate, not a glitch.
            if (lastValue > 0 && lastAgeMs < 60 * 60 * 1000) {
                let deviation = Math.abs(totalPortfolioValue - lastValue) / lastValue;
                if (deviation > 0.25) {
                    console.warn(`[PortfolioTracking] Suspicious value swing for user ${userId}: ${totalPortfolioValue.toFixed(2)} vs last known ${lastValue.toFixed(2)} (${(deviation * 100).toFixed(1)}% dev) — retrying with fresh Alpaca fetches`);
                    const MAX_ATTEMPTS = 3;
                    const RETRY_DELAY_MS = 2000;
                    for (let attempt = 1; attempt <= MAX_ATTEMPTS && deviation > 0.25; attempt++) {
                        if (attempt > 1) await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
                        const fresh = await _getAlpacaData(userId, true);
                        const retriedCashBalance = fresh.cash ?? account.balance;
                        const retriedTotalPortfolioValue = fresh.equity ?? (retriedCashBalance + totalCurrentValue);
                        const retriedDeviation = Math.abs(retriedTotalPortfolioValue - lastValue) / lastValue;
                        if (retriedDeviation < deviation) {
                            cashBalance = retriedCashBalance;
                            totalPortfolioValue = retriedTotalPortfolioValue;
                            deviation = retriedDeviation;
                            console.warn(`[PortfolioTracking] Retry ${attempt} corrected value to ${totalPortfolioValue.toFixed(2)} for user ${userId} (${(deviation * 100).toFixed(1)}% dev remaining)`);
                        } else {
                            console.warn(`[PortfolioTracking] Retry ${attempt} did not improve for user ${userId} — ${attempt < MAX_ATTEMPTS ? 'trying again' : 'keeping last value (may be a real move)'}`);
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

        try {
            await savePortfolioSnapshot(userId, portfolioSummary.summary, { source: 'portfolio-summary' });
        } catch (snapshotError) {
            console.error('Error saving portfolio snapshot:', snapshotError.message);
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
    getPortfolioHistory
};
