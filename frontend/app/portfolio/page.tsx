"use client";
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl } from '../config';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement,
  LineElement, Title, Tooltip, Legend
} from 'chart.js';
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend);

const DEFAULT_PORTFOLIO_SUMMARY = {
    totalHoldingsValue: 0, totalCostBasis: 0, totalUnrealizedPL: 0,
    totalUnrealizedPLPercent: 0, totalRealizedPL: 0, totalPortfolioValue: 0,
    totalInvested: 0, overallPL: 0, overallReturn: 0,
    numberOfPositions: 0, cashBalance: 0
};

const CHANGE_LABELS: Record<string, string> = {
    '1D': 'Today', '1W': 'This Week', '1M': 'This Month',
    '3M': 'Last 3 Months', 'YTD': 'Year to Date', '1Y': 'This Year'
};

const TICKER_COLORS = [
    'bg-blue-500','bg-purple-500','bg-emerald-500','bg-orange-500',
    'bg-pink-500','bg-cyan-500','bg-amber-500','bg-red-500','bg-indigo-500','bg-teal-500'
];
function tickerColor(symbol: string) {
    return TICKER_COLORS[(symbol.charCodeAt(0) - 65 + 26) % TICKER_COLORS.length];
}
function usd(v: number) {
    return '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signedUsd(v: number) {
    return (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signedPct(v: number) { return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'; }

function PortfolioPage() {
    const router = useRouter();
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [cashBalance, setCashBalance] = useState(0);
    const [holdings, setHoldings] = useState<any[]>([]);
    const [tradeSymbol, setTradeSymbol] = useState('');
    const [tradeQuantity, setTradeQuantity] = useState('');
    const [tradeType, setTradeType] = useState('buy');
    const [currentPrice, setCurrentPrice] = useState<number | null>(null);
    const [loadingPrice, setLoadingPrice] = useState(false);
    const [tradeMessage, setTradeMessage] = useState<{ type: string; text: string } | null>(null);
    const [tradeHistory, setTradeHistory] = useState<any[]>([]);
    const [performanceData, setPerformanceData] = useState<any>(null);
    const [portfolioSummary, setPortfolioSummary] = useState(DEFAULT_PORTFOLIO_SUMMARY);
    const [ledgerData, setLedgerData] = useState<any>(null);
    const [ledgerTrades, setLedgerTrades] = useState<any[]>([]);
    const [showLedgerTrades, setShowLedgerTrades] = useState(false);
    const [downloadStatus, setDownloadStatus] = useState('');
    const [sortSymbol, setSortSymbol] = useState<'asc' | 'desc' | null>(null);
    const [isLiveAccount, setIsLiveAccount] = useState(false);
    const [showDepositModal, setShowDepositModal] = useState(false);
    const [depositAmount, setDepositAmount] = useState('');
    const [showWithdrawModal, setShowWithdrawModal] = useState(false);
    const [withdrawAmount, setWithdrawAmount] = useState('');
    const [chartRange, setChartRange] = useState('1D');
    const [portfolioHistory, setPortfolioHistory] = useState<any[]>([]);
    const [portfolioChange, setPortfolioChange] = useState({ value: 0, percent: 0, label: 'Today' });
    const [activeTab, setActiveTab] = useState<'history' | 'trade' | 'settings'>('history');
    const [settingsLoading, setSettingsLoading] = useState(true);
    const [aiSettings, setAISettings] = useState({ stopLoss: 0.06, takeProfit: 0.3, minCashReserve: 0 });
    const [settingsChanged, setSettingsChanged] = useState(false);
    const [botConfig, setBotConfig] = useState({
        maxOrderNotional: 5000, minBuyScore: 70, maxOpenPositions: 8, maxGrossExposurePct: 75,
    });
    const [botConfigChanged, setBotConfigChanged] = useState(false);
    const [botConfigSaving, setBotConfigSaving] = useState(false);
    const [botConfigMsg, setBotConfigMsg] = useState<string | null>(null);
    const [resetAmount, setResetAmount] = useState('');
    const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
    const autoRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const formatDate = (iso: string) => {
        try {
            const d = new Date(iso);
            if (Number.isNaN(d.getTime())) return iso;
            return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
        } catch { return iso; }
    };

    const isPriceStale = (holding: any) => {
        try {
            if (holding.priceError) return true;
            const last = holding.lastUpdated || holding.updatedAt || null;
            if (!last) return true;
            const d = new Date(last);
            if (Number.isNaN(d.getTime())) return true;
            return Date.now() - d.getTime() > 5 * 60 * 1000;
        } catch { return true; }
    };

    const handleAuthError = () => {
        localStorage.removeItem('token');
        router.push('/login');
    };

    function isMarketHours(): boolean {
        const et = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        const d  = new Date(et);
        const day = d.getDay();
        if (day === 0 || day === 6) return false;
        const mins = d.getHours() * 60 + d.getMinutes();
        return mins >= 9 * 60 + 30 && mins < 16 * 60;
    }

    const silentRefreshPortfolio = useCallback(async () => {
        if (!token) return;
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/portfolio`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (res.status === 401) { handleAuthError(); return; }
            if (res.ok) {
                const data = await res.json();
                const summary = { ...DEFAULT_PORTFOLIO_SUMMARY, ...(data.summary || {}), cashBalance: data.summary?.cashBalance || data.account?.cashBalance || 0 };
                setPortfolioSummary(summary);
                setCashBalance(summary.cashBalance);
                setHoldings(data.holdings || []);
                if (data.isLiveAccount !== undefined) setIsLiveAccount(data.isLiveAccount);
                setLastRefreshed(new Date());
            }
        } catch { /* silent — don't disrupt the UI on network blip */ }
    }, [token]);

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        if (!storedToken) { router.push('/login'); } else { setToken(storedToken); }
    }, [router]);

    useEffect(() => {
        if (token) { loadData(); fetchAISettings(); fetchBotConfig(); }
    }, [token]);

    useEffect(() => {
        if (token) fetchPortfolioHistory(chartRange);
    }, [token, chartRange]);

    // Auto-refresh: 30 s during market hours, 5 min outside
    useEffect(() => {
        if (!token) return;
        let cancelled = false;

        const schedule = () => {
            const delay = isMarketHours() ? 30_000 : 5 * 60_000;
            autoRefreshRef.current = setTimeout(async () => {
                if (cancelled) return;
                await silentRefreshPortfolio();
                if (!cancelled) schedule();
            }, delay);
        };

        schedule();
        return () => {
            cancelled = true;
            if (autoRefreshRef.current) clearTimeout(autoRefreshRef.current);
        };
    }, [token, silentRefreshPortfolio]);

    const fetchAISettings = async () => {
        setSettingsLoading(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/ai-trading/settings`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) {
                const data = await res.json();
                setAISettings({
                    stopLoss: data.aiTradingSettings?.stopLoss ?? 0.06,
                    takeProfit: data.aiTradingSettings?.takeProfit ?? 0.3,
                    minCashReserve: data.aiTradingSettings?.minCashReserve ?? 0
                });
            }
        } catch (e) { console.error(e); } finally { setSettingsLoading(false); }
    };

    const saveAISettings = async () => {
        setSettingsLoading(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/ai-trading/settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify(aiSettings)
            });
            if (res.ok) setSettingsChanged(false);
        } catch (e) { console.error(e); } finally { setSettingsLoading(false); }
    };

    const fetchBotConfig = async () => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/enhanced-ai-trading/status`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) {
                const data = await res.json();
                const rc = data.riskConfig || {};
                setBotConfig({
                    maxOrderNotional: rc.maxOrderNotional ?? 5000,
                    minBuyScore: rc.minBuyScore ?? 70,
                    maxOpenPositions: rc.maxOpenPositions ?? 8,
                    maxGrossExposurePct: Math.round((rc.maxGrossExposurePct ?? 0.75) * 100),
                });
            }
        } catch (e) { console.error(e); }
    };

    const saveBotConfig = async () => {
        setBotConfigSaving(true); setBotConfigMsg(null);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/enhanced-ai-trading/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    maxOrderNotional: botConfig.maxOrderNotional,
                    minBuyScore: botConfig.minBuyScore,
                    maxOpenPositions: botConfig.maxOpenPositions,
                    maxGrossExposurePct: botConfig.maxGrossExposurePct / 100,
                }),
            });
            if (res.ok) { setBotConfigChanged(false); setBotConfigMsg('✓ Saved'); setTimeout(() => setBotConfigMsg(null), 3000); }
            else setBotConfigMsg('Save failed — try again');
        } catch { setBotConfigMsg('Network error'); } finally { setBotConfigSaving(false); }
    };

    const loadData = async () => {
        setLoading(true);
        try { await Promise.all([fetchPortfolio(), fetchTradeHistory(), fetchPerformance(), fetchLedger()]); }
        catch (e) { console.error(e); } finally { setLoading(false); }
    };

    const fetchLedger = async () => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/ledger`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) setLedgerData(await res.json());
        } catch (e) { console.error(e); }
    };

    const fetchLedgerTrades = async () => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/ledger/trades?limit=500`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) { const data = await res.json(); setLedgerTrades(data.trades || []); }
        } catch (e) { console.error(e); }
    };

    const downloadLedgerCSV = async () => {
        if (!token) return alert('Not authenticated');
        setDownloadStatus('Preparing…');
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/ledger/export`, { headers: { Authorization: `Bearer ${token}` } });
            if (!res.ok) throw new Error('Failed');
            const blob = await res.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a'); a.href = url;
            a.download = `ledger-${new Date().toISOString().slice(0,10)}.csv`;
            document.body.appendChild(a); a.click(); a.remove();
            window.URL.revokeObjectURL(url);
            setDownloadStatus('Downloaded'); setTimeout(() => setDownloadStatus(''), 3000);
        } catch { setDownloadStatus('Failed'); setTimeout(() => setDownloadStatus(''), 3000); }
    };

    const handleResetBalance = async () => {
        const amount = parseFloat(resetAmount);
        if (isNaN(amount) || amount < 0) { alert('Please enter a valid non-negative amount'); return; }
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/reset-balance`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ amount })
            });
            if (res.ok) { alert(`Cash balance reset to $${amount}`); setResetAmount(''); await fetchPortfolio(); }
            else { const d = await res.json(); alert(d.error || 'Reset failed'); }
        } catch { alert('Error resetting balance'); }
    };

    const handleClearAll = async () => {
        if (!window.confirm('WARNING: This will permanently reset your entire portfolio to zero!\n\nCash Balance → $0\nAll Holdings → Cleared\nTrade History → Deleted\n\nThis cannot be undone.')) return;
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/clear-all`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) { alert('Portfolio cleared. Starting fresh from $0.'); await fetchPortfolio(); }
            else { const d = await res.json(); alert(d.error || 'Failed'); }
        } catch { alert('Error clearing portfolio'); }
    };

    const fetchPortfolio = async () => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/portfolio`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.status === 401) { handleAuthError(); return; }
            if (res.ok) {
                const data = await res.json();
                const summary = { ...DEFAULT_PORTFOLIO_SUMMARY, ...(data.summary || {}), cashBalance: data.summary?.cashBalance || data.account?.cashBalance || 0 };
                setPortfolioSummary(summary); setCashBalance(summary.cashBalance); setHoldings(data.holdings || []);
                if (data.isLiveAccount !== undefined) setIsLiveAccount(data.isLiveAccount);
            }
        } catch (e) { console.error(e); }
    };

    const fetchTradeHistory = async () => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/history?limit=200`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.status === 401) { handleAuthError(); return; }
            if (res.ok) { const data = await res.json(); setTradeHistory(data.trades || []); }
        } catch (e) { console.error(e); }
    };

    const fetchPerformance = async () => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/performance`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) setPerformanceData(await res.json());
        } catch (e) { console.error(e); }
    };

    const fetchQuote = async (symbol: string) => {
        if (!symbol.trim()) return;
        setLoadingPrice(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/quote/${symbol}`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.ok) { const data = await res.json(); setCurrentPrice(data.price); }
            else { setTradeMessage({ type: 'error', text: 'Failed to fetch price' }); setCurrentPrice(null); }
        } catch { setTradeMessage({ type: 'error', text: 'Error fetching price' }); setCurrentPrice(null); }
        finally { setLoadingPrice(false); }
    };

    const handleTrade = async (e: React.FormEvent) => {
        e.preventDefault(); setTradeMessage(null);
        if (!tradeSymbol || !tradeQuantity || !currentPrice) {
            setTradeMessage({ type: 'error', text: 'Fill all fields and fetch current price first' }); return;
        }
        const quantity = parseInt(tradeQuantity, 10);
        if (isNaN(quantity) || quantity <= 0) { setTradeMessage({ type: 'error', text: 'Quantity must be a positive number' }); return; }
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/${tradeType === 'buy' ? 'buy' : 'sell'}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ symbol: tradeSymbol.toUpperCase(), quantity })
            });
            const data = await res.json();
            if (res.ok) {
                setTradeMessage({ type: 'success', text: `Successfully ${tradeType === 'buy' ? 'bought' : 'sold'} ${quantity} shares of ${tradeSymbol.toUpperCase()} at $${data.price?.toFixed(2) || currentPrice?.toFixed(2)}` });
                setTradeSymbol(''); setTradeQuantity(''); setCurrentPrice(null); await loadData();
            } else setTradeMessage({ type: 'error', text: data.error || 'Trade failed' });
        } catch { setTradeMessage({ type: 'error', text: 'Error executing trade' }); }
    };

    const handleDeposit = async () => {
        const amount = parseFloat(depositAmount);
        if (isNaN(amount) || amount <= 0) { alert('Enter a valid amount'); return; }
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/deposit`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ amount })
            });
            if (res.ok) { alert(`Deposited $${amount.toFixed(2)}`); setDepositAmount(''); setShowDepositModal(false); await fetchPortfolio(); }
            else { const d = await res.json(); alert(d.error || 'Deposit failed'); }
        } catch { alert('Error processing deposit'); }
    };

    const handleWithdraw = async () => {
        const amount = parseFloat(withdrawAmount);
        if (isNaN(amount) || amount <= 0) { alert('Enter a valid amount'); return; }
        if (amount > cashBalance) { alert('Withdrawal amount exceeds cash balance'); return; }
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/withdraw`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ amount })
            });
            if (res.ok) { alert(`Withdrew $${amount.toFixed(2)}`); setWithdrawAmount(''); setShowWithdrawModal(false); await fetchPortfolio(); }
            else { const d = await res.json(); alert(d.error || 'Withdrawal failed'); }
        } catch { alert('Error processing withdrawal'); }
    };

    const formatHistoryLabel = (timestamp: string, range: string) => {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return String(timestamp);
        if (range === '1D') return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        if (range === '1W' || range === '1M') return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return date.toLocaleDateString([], { month: 'short', year: '2-digit' });
    };

    const fetchPortfolioHistory = async (range: string) => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/portfolio-history?range=${range}`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.status === 401) { handleAuthError(); return; }
            if (!res.ok) throw new Error('Failed');
            const payload = await res.json();
            const history = Array.isArray(payload) ? payload : (payload.history || []);
            const normalized = history.map((p: any) => ({ time: formatHistoryLabel(p.time, range), value: Number(p.value) || 0 })).filter((p: any) => Number.isFinite(p.value));
            setPortfolioHistory(normalized);
            if (typeof payload?.changeValue === 'number') {
                setPortfolioChange({ value: payload.changeValue, percent: payload.changePercent, label: CHANGE_LABELS[range] || 'Change' });
            } else if (normalized.length >= 2) {
                const open = normalized[0].value, last = normalized[normalized.length - 1].value;
                setPortfolioChange({ value: last - open, percent: open > 0 ? ((last - open) / open) * 100 : 0, label: CHANGE_LABELS[range] || 'Change' });
            } else setPortfolioChange({ value: 0, percent: 0, label: CHANGE_LABELS[range] || 'Change' });
        } catch { setPortfolioHistory([]); setPortfolioChange({ value: 0, percent: 0, label: CHANGE_LABELS[range] || 'Change' }); }
    };

    // ── Derived values ──────────────────────────────────────────────────────────
    const totalPortfolioValue = portfolioSummary.totalPortfolioValue || (cashBalance + holdings.reduce((s, h) => s + (h.currentValue || 0), 0));
    const totalHoldingsValue  = portfolioSummary.totalHoldingsValue  || holdings.reduce((s, h) => s + (h.currentValue || 0), 0);
    const totalUnrealizedPL   = portfolioSummary.totalUnrealizedPL   || holdings.reduce((s, h) => s + (h.unrealizedPL || 0), 0);
    const totalRealizedPL     = portfolioSummary.totalRealizedPL     || 0;
    const overallPL           = portfolioSummary.overallPL           || 0;
    const overallReturn       = portfolioSummary.overallReturn        || 0;
    const positionCount       = portfolioSummary.numberOfPositions    || holdings.length;

    const chartUp = portfolioChange.value >= 0;
    const chartColor = chartUp ? 'rgba(34,197,94,1)' : 'rgba(239,68,68,1)';
    const chartFill  = chartUp ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)';
    const openValue  = portfolioHistory.length > 0 ? portfolioHistory[0].value : null;
    const lastIdx    = portfolioHistory.length - 1;

    const chartData = {
        labels: portfolioHistory.map(p => p.time),
        datasets: [
            {
                label: 'Portfolio Value',
                data: portfolioHistory.map(p => p.value),
                borderColor: chartColor,
                backgroundColor: chartFill,
                fill: true, tension: 0.3,
                pointRadius: portfolioHistory.map((_, i) => i === lastIdx ? 4 : 0),
                pointBackgroundColor: chartColor,
                pointBorderColor: chartColor,
                borderWidth: 2,
            },
            // Dotted reference baseline at period open
            ...(openValue !== null ? [{
                label: 'Baseline',
                data: portfolioHistory.map(() => openValue),
                borderColor: 'rgba(150,150,150,0.35)',
                borderDash: [5, 5] as number[],
                backgroundColor: 'transparent',
                fill: false, tension: 0, pointRadius: 0, borderWidth: 1,
            }] : []),
        ],
    };
    const chartOptions = {
        responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            tooltip: {
                mode: 'index' as const, intersect: false,
                filter: (item: any) => item.datasetIndex === 0,
                callbacks: { label: (ctx: any) => ` $${ctx.parsed.y.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` }
            }
        },
        scales: { x: { display: false }, y: { display: false } },
        interaction: { mode: 'index' as const, intersect: false },
    };

    // ── Holdings list — shared between sidebar (desktop) and inline (mobile) ──
    const holdingsPanel = (
        <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--color-text-secondary)] px-4 lg:px-6 pt-6 pb-2">
                Stocks {positionCount > 0 && <span className="ml-1 text-[var(--color-accent)]">({positionCount})</span>}
            </p>
            {holdings.length === 0 ? (
                <div className="px-4 lg:px-6 py-8 text-center">
                    <div className="text-3xl mb-2">📈</div>
                    <p className="text-sm text-[var(--color-text-secondary)]">No positions yet</p>
                    <button onClick={() => setShowDepositModal(true)}
                        className="mt-3 px-5 py-2 rounded-full bg-[var(--color-accent)] text-white text-sm font-bold hover:opacity-90 transition-opacity">
                        Deposit Funds
                    </button>
                </div>
            ) : (
                <div>
                    {holdings.map(h => {
                        const plPct = h.unrealizedPLPercent || 0;
                        const plVal = h.unrealizedPL || 0;
                        const stale = isPriceStale(h);

                        // Trailing stop display
                        const stopPrice    = h.stopPrice   != null ? h.stopPrice   : null;
                        const targetPrice  = h.targetPrice != null ? h.targetPrice : null;
                        const stopLocked   = h.stopLocked  === true;
                        const entryPrice   = h.averagePrice || 0;
                        const stopGainPct  = stopPrice != null && entryPrice > 0
                            ? ((stopPrice - entryPrice) / entryPrice) * 100
                            : null;
                        // colour: green = locked in profit, amber = at break-even, red = below entry
                        const stopColor = stopGainPct == null
                            ? 'text-[var(--color-text-secondary)]'
                            : stopGainPct > 0.05
                                ? 'text-green-400'
                                : stopGainPct >= -0.05
                                    ? 'text-amber-400'
                                    : 'text-red-400';

                        return (
                            <div key={h.symbol} className="px-4 lg:px-6 py-3.5 border-b border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-default">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="flex items-center gap-3 min-w-0">
                                        <div className={`w-9 h-9 rounded-full ${tickerColor(h.symbol)} flex items-center justify-center text-white font-bold text-xs flex-shrink-0`}>
                                            {h.symbol.slice(0, 2)}
                                        </div>
                                        <div className="min-w-0">
                                            <div className="font-bold text-[var(--color-text-primary)] text-sm leading-tight">{h.symbol}</div>
                                            <div className="text-xs text-[var(--color-text-secondary)] truncate">
                                                {h.quantity} shares @ {usd(entryPrice)}
                                                {stale && <span className="text-yellow-500 ml-1" title="Price may be stale">⚠</span>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="text-right flex-shrink-0">
                                        <div className="font-bold text-[var(--color-text-primary)] tabular-nums text-sm">{usd(h.currentValue || 0)}</div>
                                        <div className={`text-xs font-semibold tabular-nums ${plVal >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                            {signedPct(plPct)}
                                        </div>
                                    </div>
                                </div>

                                {/* Stop / Target row */}
                                {(stopPrice != null || targetPrice != null) && (
                                    <div className="mt-1.5 ml-12 flex items-center gap-3 text-[11px]">
                                        {stopPrice != null && (
                                            <span className={`flex items-center gap-1 ${stopColor}`}>
                                                <span>{stopLocked ? '🔒' : '🛑'}</span>
                                                <span className="font-semibold">Stop {usd(stopPrice)}</span>
                                                {stopGainPct != null && (
                                                    <span className="opacity-75">
                                                        ({stopGainPct >= 0 ? '+' : ''}{stopGainPct.toFixed(1)}%)
                                                    </span>
                                                )}
                                            </span>
                                        )}
                                        {targetPrice != null && (
                                            <span className="flex items-center gap-1 text-blue-400">
                                                <span>🎯</span>
                                                <span className="font-semibold">Target {usd(targetPrice)}</span>
                                            </span>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                    {/* Summary footer */}
                    <div className="px-4 lg:px-6 py-3 bg-[var(--color-bg-tertiary)]">
                        <div className="flex justify-between items-center text-xs">
                            <span className="text-[var(--color-text-secondary)]">Invested</span>
                            <span className="font-bold text-[var(--color-text-primary)] tabular-nums">{usd(totalHoldingsValue)}</span>
                        </div>
                        <div className="flex justify-between items-center text-xs mt-1">
                            <span className="text-[var(--color-text-secondary)]">Unrealized P/L</span>
                            <span className={`font-bold tabular-nums ${totalUnrealizedPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>{signedUsd(totalUnrealizedPL)}</span>
                        </div>
                        <div className="flex justify-between items-center text-xs mt-1">
                            <span className="text-[var(--color-text-secondary)]">Realized P/L</span>
                            <span className={`font-bold tabular-nums ${totalRealizedPL >= 0 ? 'text-green-500' : 'text-red-500'}`}>{signedUsd(totalRealizedPL)}</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );

    // ── Render ──────────────────────────────────────────────────────────────────
    return (
        <div className="min-h-screen bg-[var(--color-bg-primary)]">
        <div className="max-w-7xl mx-auto lg:flex lg:items-start">

            {/* ═══════════════════════════════════════════════════════════════════
                LEFT COLUMN — chart + stats + tabs
            ═══════════════════════════════════════════════════════════════════ */}
            <div className="flex-1 min-w-0 lg:border-r lg:border-[var(--color-border)]">

                {/* ── Hero ── */}
                <div className="px-4 lg:px-10 pt-8">
                    <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--color-text-secondary)] mb-2">Investing</p>

                    <div className="text-5xl font-bold text-[var(--color-text-primary)] tabular-nums leading-none">
                        {usd(totalPortfolioValue)}
                    </div>

                    <div className={`mt-2 flex items-center gap-1.5 text-sm font-semibold ${chartUp ? 'text-green-500' : 'text-red-500'}`}>
                        <span className="text-base leading-none">{chartUp ? '▲' : '▼'}</span>
                        <span>{signedUsd(portfolioChange.value)}</span>
                        <span className="opacity-80">({signedPct(portfolioChange.percent)})</span>
                        <span className="text-[var(--color-text-secondary)] font-normal text-xs ml-1">{portfolioChange.label}</span>
                    </div>

                    {/* Live refresh indicator */}
                    <div className="mt-2 flex items-center gap-1.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${isMarketHours() ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
                        <span className="text-[11px] text-[var(--color-text-secondary)]">
                            {isMarketHours() ? 'Live · updates every 30s' : 'Market closed · updates every 5m'}
                            {lastRefreshed && (
                                <span className="ml-1 opacity-60">
                                    · {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                            )}
                        </span>
                    </div>
                </div>

                {/* ── Chart — edge-to-edge on mobile ── */}
                <div className="relative h-52 sm:h-64 lg:h-72 mt-6 -mx-0">
                    <Line data={chartData} options={chartOptions} />
                </div>

                {/* ── Period selector — Robinhood tab style ── */}
                <div className="flex items-center gap-0 overflow-x-auto scrollbar-hide border-b border-[var(--color-border)] px-4 lg:px-10">
                    {/* LIVE dot */}
                    <button onClick={() => setChartRange('1D')}
                        className={`flex items-center gap-1.5 px-3 py-3 text-xs font-bold whitespace-nowrap relative transition-colors ${chartRange === '1D' ? 'text-green-500' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
                        <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                            {chartRange === '1D' && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />}
                            <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${chartRange === '1D' ? 'bg-green-500' : 'bg-[var(--color-text-secondary)]'}`} />
                        </span>
                        LIVE
                        {chartRange === '1D' && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-green-500" />}
                    </button>
                    {['1D','1W','1M','3M','YTD','1Y'].map(r => (
                        <button key={r} onClick={() => setChartRange(r)}
                            className={`px-3 py-3 text-xs font-bold whitespace-nowrap relative transition-colors ${chartRange === r && r !== '1D' ? 'text-[var(--color-text-primary)]' : chartRange !== r ? 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]' : 'text-[var(--color-text-primary)]'}`}>
                            {r}
                            {chartRange === r && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--color-accent)]" />}
                        </button>
                    ))}
                </div>

                {/* ── Buying power row ── */}
                <div className="flex items-center justify-between px-4 lg:px-10 py-4 border-b border-[var(--color-border)]">
                    <div>
                        <span className="text-sm font-semibold text-[var(--color-text-primary)]">Buying power</span>
                        <span className="text-[var(--color-text-secondary)] text-xs ml-2">Cash available</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <span className="font-bold text-[var(--color-text-primary)] tabular-nums">{usd(cashBalance)}</span>
                        <button onClick={() => setShowDepositModal(true)}
                            className="px-4 py-1.5 rounded-full bg-[var(--color-accent)] text-white text-xs font-bold hover:opacity-90 transition-opacity">
                            Deposit
                        </button>
                        <button onClick={() => setShowWithdrawModal(true)}
                            className="px-4 py-1.5 rounded-full border border-[var(--color-border)] text-[var(--color-text-primary)] text-xs font-bold hover:bg-[var(--color-bg-tertiary)] transition-colors">
                            Withdraw
                        </button>
                    </div>
                </div>

                {/* ── 4 stat cells (compact inline row) ── */}
                <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-[var(--color-border)]">
                    {[
                        { label: 'Portfolio', value: usd(totalPortfolioValue), sub: signedPct(overallReturn) + ' total', subColor: overallReturn >= 0 ? 'text-green-500' : 'text-red-500' },
                        { label: 'Cash', value: usd(cashBalance), sub: 'Available', subColor: 'text-[var(--color-text-secondary)]' },
                        { label: 'Invested', value: usd(totalHoldingsValue), sub: `${positionCount} position${positionCount !== 1 ? 's' : ''}`, subColor: 'text-[var(--color-text-secondary)]' },
                        { label: 'Total P/L', value: signedUsd(overallPL), sub: `Unrealized: ${signedUsd(totalUnrealizedPL)}`, subColor: totalUnrealizedPL >= 0 ? 'text-green-500' : 'text-red-500' },
                    ].map((stat, i) => (
                        <div key={stat.label} className={`px-4 lg:px-10 py-4 ${i < 3 ? 'border-r border-[var(--color-border)]' : ''} ${i >= 2 ? 'border-t sm:border-t-0 border-[var(--color-border)]' : ''}`}>
                            <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1">{stat.label}</div>
                            <div className={`text-base font-bold tabular-nums ${stat.label === 'Total P/L' ? (overallPL >= 0 ? 'text-green-500' : 'text-red-500') : 'text-[var(--color-text-primary)]'}`}>{stat.value}</div>
                            <div className={`text-[11px] font-semibold mt-0.5 ${stat.subColor}`}>{stat.sub}</div>
                        </div>
                    ))}
                </div>

                {/* ── Mobile holdings (hidden on lg+) ── */}
                <div className="lg:hidden border-b border-[var(--color-border)]">
                    {holdingsPanel}
                </div>

                {/* ── Tabs: History | Trade | Settings ── */}
                <div className="flex border-b border-[var(--color-border)] overflow-x-auto scrollbar-hide px-4 lg:px-10">
                    {(['history','trade','settings'] as const).map(tab => (
                        <button key={tab} onClick={() => setActiveTab(tab)}
                            className={`px-4 py-3.5 text-sm font-semibold whitespace-nowrap relative transition-colors ${activeTab === tab ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
                            {tab.charAt(0).toUpperCase() + tab.slice(1)}
                            {activeTab === tab && <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--color-accent)]" />}
                        </button>
                    ))}
                </div>

                {/* ── Tab content ── */}
                <div className="px-4 lg:px-10 py-6 pb-24">

                {/* ═══ HISTORY ════════════════════════════════════════════════ */}
                {activeTab === 'history' && (
                    <div>
                        <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
                            <div>
                                <h2 className="text-xl font-bold text-[var(--color-text-primary)]">Transaction History</h2>
                                <p className="text-sm text-[var(--color-text-secondary)]">{tradeHistory.length} transactions</p>
                            </div>
                            {ledgerData && (
                                <div className="flex gap-2 flex-wrap">
                                    <button onClick={async () => { await fetchLedgerTrades(); setShowLedgerTrades(s => !s); }}
                                        className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] transition-colors">
                                        {showLedgerTrades ? 'Hide Ledger' : 'Full Ledger'}
                                    </button>
                                    <button onClick={downloadLedgerCSV}
                                        className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-white text-sm font-semibold hover:opacity-90 transition-opacity">
                                        Export CSV
                                    </button>
                                    {downloadStatus && <span className="text-xs text-[var(--color-text-secondary)] self-center">{downloadStatus}</span>}
                                </div>
                            )}
                        </div>

                        {/* Ledger summary pills */}
                        {ledgerData && (
                            <div className="flex gap-2 flex-wrap mb-5">
                                {[
                                    { label: 'Deposits', value: ledgerData.totalDeposits, color: 'text-blue-500' },
                                    { label: 'Withdrawals', value: ledgerData.totalWithdrawals, color: 'text-orange-500' },
                                    { label: 'Buys', value: ledgerData.totalBuys, color: 'text-green-500' },
                                    { label: 'Sells', value: ledgerData.totalSells, color: 'text-red-500' },
                                    { label: 'Commissions', value: ledgerData.totalCommission, color: 'text-[var(--color-text-secondary)]' },
                                ].map(item => (
                                    <div key={item.label} className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl px-4 py-2 flex items-center gap-2">
                                        <span className="text-xs text-[var(--color-text-secondary)]">{item.label}</span>
                                        <span className={`text-sm font-bold ${item.color}`}>${item.value.toFixed(2)}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {tradeHistory.length === 0 ? (
                            <div className="text-center py-16 text-[var(--color-text-secondary)]">No transactions yet.</div>
                        ) : (
                            <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                                <div className="overflow-x-auto">
                                    <table className="min-w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
                                                {['Date','Type'].map(h => (
                                                    <th key={h} className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] text-left">{h}</th>
                                                ))}
                                                <th
                                                    className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-left cursor-pointer select-none group"
                                                    onClick={() => setSortSymbol(s => s === 'asc' ? 'desc' : s === 'desc' ? null : 'asc')}
                                                >
                                                    <span className={sortSymbol ? 'text-purple-500' : 'text-[var(--color-text-secondary)] group-hover:text-purple-400'}>
                                                        Symbol {sortSymbol === 'asc' ? '▲' : sortSymbol === 'desc' ? '▼' : '⇅'}
                                                    </span>
                                                </th>
                                                {['Qty','Price','Amount','P/L'].map(h => (
                                                    <th key={h} className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] text-right">{h}</th>
                                                ))}
                                                {['Score','By'].map(h => (
                                                    <th key={h} className="px-4 py-3 text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] text-left">{h}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-[var(--color-border)]">
                                            {(sortSymbol
                                                ? [...tradeHistory].sort((a, b) => {
                                                    const sa = (a.symbol ?? '').toUpperCase();
                                                    const sb = (b.symbol ?? '').toUpperCase();
                                                    return sortSymbol === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
                                                  })
                                                : tradeHistory
                                            ).map(trade => {
                                                const badge = trade.type === 'BUY' ? 'bg-green-500/15 text-green-600' : trade.type === 'SELL' ? 'bg-red-500/15 text-red-600' : trade.type === 'DEPOSIT' ? 'bg-blue-500/15 text-blue-600' : trade.type === 'WITHDRAWAL' ? 'bg-amber-500/15 text-amber-600' : 'bg-gray-500/15 text-[var(--color-text-secondary)]';
                                                const isCash = trade.type === 'DEPOSIT' || trade.type === 'WITHDRAWAL';
                                                const amount = trade.total ?? ((trade.price ?? 0) * (trade.quantity ?? 0));
                                                const hasPnl = trade.pnl != null;
                                                return (
                                                    <tr key={trade.id} className="hover:bg-[var(--color-bg-tertiary)] transition-colors">
                                                        <td className="px-4 py-3 whitespace-nowrap text-xs text-[var(--color-text-secondary)]">{new Date(trade.timestamp).toLocaleString()}</td>
                                                        <td className="px-4 py-3 whitespace-nowrap"><span className={`px-2.5 py-0.5 text-xs font-bold rounded-full ${badge}`}>{trade.type}</span></td>
                                                        <td className="px-4 py-3 whitespace-nowrap font-bold text-[var(--color-text-primary)]">{isCash ? '—' : trade.symbol}</td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-right text-[var(--color-text-secondary)]">{isCash ? '—' : trade.quantity}</td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-right text-[var(--color-text-secondary)]">{isCash ? '—' : `$${(trade.price ?? 0).toFixed(2)}`}</td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-right font-semibold text-[var(--color-text-primary)]">${(amount ?? 0).toFixed(2)}</td>
                                                        <td className={`px-4 py-3 whitespace-nowrap text-right font-semibold ${hasPnl ? (trade.pnl >= 0 ? 'text-green-500' : 'text-red-500') : 'text-[var(--color-text-secondary)]'}`}>
                                                            {hasPnl ? `${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}` : '—'}
                                                        </td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-center">
                                                            {trade.aiScore != null ? <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${trade.aiScore >= 80 ? 'bg-green-500/15 text-green-600' : trade.aiScore >= 60 ? 'bg-yellow-500/15 text-yellow-600' : 'bg-gray-500/15 text-[var(--color-text-secondary)]'}`}>{trade.aiScore}</span> : '—'}
                                                        </td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-xs text-[var(--color-text-secondary)]">{trade.executedBy || '—'}</td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}

                        {showLedgerTrades && ledgerTrades.length > 0 && (
                            <div className="mt-4 bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
                                <div className="px-5 py-3 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
                                    <h4 className="font-bold text-[var(--color-text-primary)]">Full Ledger</h4>
                                </div>
                                <div className="overflow-x-auto">
                                    <table className="min-w-full text-xs">
                                        <thead><tr className="border-b border-[var(--color-border)]">{['Date','Type','Symbol','Qty','Price','Total','Comm','By','Notes'].map(h => <th key={h} className="px-3 py-2 text-left font-bold text-[var(--color-text-secondary)]">{h}</th>)}</tr></thead>
                                        <tbody className="divide-y divide-[var(--color-border)]">
                                            {ledgerTrades.map(t => (
                                                <tr key={t.id} className="hover:bg-[var(--color-bg-tertiary)]">
                                                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">{new Date(t.trade_date).toLocaleString()}</td>
                                                    <td className="px-3 py-2 font-medium text-[var(--color-text-primary)]">{t.action}</td>
                                                    <td className="px-3 py-2 font-bold text-[var(--color-text-primary)]">{t.symbol}</td>
                                                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">{t.quantity || ''}</td>
                                                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">${(t.price||0).toFixed(2)}</td>
                                                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">${(t.total||0).toFixed(2)}</td>
                                                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">${(t.commission||0).toFixed(2)}</td>
                                                    <td className="px-3 py-2 text-[var(--color-text-secondary)]">{t.executed_by}</td>
                                                    <td className="px-3 py-2 text-[var(--color-text-secondary)] max-w-xs truncate">{t.notes||''}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* ═══ TRADE ══════════════════════════════════════════════════ */}
                {activeTab === 'trade' && (
                    <div className="max-w-md mx-auto">
                        <h2 className="text-xl font-bold text-[var(--color-text-primary)] mb-6">Place Order</h2>
                        {tradeMessage && (
                            <div className={`mb-4 p-4 rounded-xl text-sm font-medium border ${tradeMessage.type === 'success' ? 'bg-green-500/10 border-green-500 text-green-600' : 'bg-red-500/10 border-red-500 text-red-600'}`}>
                                {tradeMessage.text}
                            </div>
                        )}
                        <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-6">
                            <div className="flex bg-[var(--color-bg-tertiary)] rounded-xl p-1 mb-6">
                                <button onClick={() => setTradeType('buy')} className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition-colors ${tradeType === 'buy' ? 'bg-green-500 text-white shadow-sm' : 'text-[var(--color-text-secondary)]'}`}>Buy</button>
                                <button onClick={() => setTradeType('sell')} className={`flex-1 py-2.5 rounded-lg text-sm font-bold transition-colors ${tradeType === 'sell' ? 'bg-red-500 text-white shadow-sm' : 'text-[var(--color-text-secondary)]'}`}>Sell</button>
                            </div>
                            <form onSubmit={handleTrade} className="space-y-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Symbol</label>
                                    <div className="flex gap-2">
                                        <input type="text" value={tradeSymbol} onChange={e => setTradeSymbol(e.target.value.toUpperCase())} placeholder="e.g., AAPL"
                                            className="flex-1 px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-mono font-bold focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]" />
                                        <button type="button" onClick={() => fetchQuote(tradeSymbol)} disabled={loadingPrice || !tradeSymbol}
                                            className="px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-sm font-semibold text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] disabled:opacity-40 transition-colors">
                                            {loadingPrice ? '…' : 'Quote'}
                                        </button>
                                    </div>
                                </div>
                                {currentPrice !== null && (
                                    <div className="px-4 py-3 bg-[var(--color-bg-tertiary)] rounded-xl flex justify-between items-center">
                                        <span className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">Current Price</span>
                                        <span className="text-lg font-bold tabular-nums text-[var(--color-text-primary)]">${currentPrice.toFixed(2)}</span>
                                    </div>
                                )}
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Shares</label>
                                    <input type="number" value={tradeQuantity} onChange={e => setTradeQuantity(e.target.value)} placeholder="0" min="1"
                                        className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] text-lg font-bold tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]" />
                                </div>
                                {currentPrice !== null && tradeQuantity && (
                                    <div className="px-4 py-3 bg-[var(--color-bg-tertiary)] rounded-xl flex justify-between items-center">
                                        <span className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">{tradeType === 'buy' ? 'Estimated Cost' : 'Estimated Proceeds'}</span>
                                        <span className="text-lg font-bold tabular-nums text-[var(--color-text-primary)]">${(currentPrice * parseInt(tradeQuantity, 10)).toFixed(2)}</span>
                                    </div>
                                )}
                                <button type="submit" className={`w-full py-3.5 rounded-xl text-white font-bold text-base hover:opacity-90 transition-opacity ${tradeType === 'buy' ? 'bg-green-500' : 'bg-red-500'}`}>
                                    {tradeType === 'buy' ? `Buy ${tradeSymbol || 'Stock'}` : `Sell ${tradeSymbol || 'Stock'}`}
                                </button>
                            </form>
                        </div>

                        {holdings.length > 0 && (
                            <div className="mt-6">
                                <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-3">Quick Sell from Holdings</h3>
                                <div className="space-y-2">
                                    {holdings.map(h => (
                                        <button key={h.symbol} onClick={() => { setTradeSymbol(h.symbol); setTradeType('sell'); fetchQuote(h.symbol); }}
                                            className="w-full flex items-center justify-between px-4 py-3 bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl hover:shadow-sm transition-shadow">
                                            <div className="flex items-center gap-3">
                                                <div className={`w-8 h-8 rounded-full ${tickerColor(h.symbol)} flex items-center justify-center text-white font-bold text-xs`}>{h.symbol.slice(0,2)}</div>
                                                <div className="text-left">
                                                    <div className="font-bold text-[var(--color-text-primary)] text-sm">{h.symbol}</div>
                                                    <div className="text-xs text-[var(--color-text-secondary)]">{h.quantity} shares · {usd(h.currentValue||0)}</div>
                                                </div>
                                            </div>
                                            <span className="text-xs text-[var(--color-accent)] font-bold">Select →</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {/* ═══ SETTINGS ═══════════════════════════════════════════════ */}
                {activeTab === 'settings' && (
                    <div className="space-y-6">
                        {/* AI Risk Settings */}
                        <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-6">
                            <h2 className="text-lg font-bold text-[var(--color-text-primary)] mb-1">AI Risk Settings</h2>
                            <p className="text-sm text-[var(--color-text-secondary)] mb-5">Stop-loss, take-profit, and cash reserve thresholds for AI trades.</p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Stop-Loss (%)</label>
                                    <input type="number" min={1} max={20} step={0.5} value={Math.abs(aiSettings.stopLoss * 100)}
                                        onChange={e => { setAISettings(s => ({ ...s, stopLoss: -Math.abs(Number(e.target.value)/100) })); setSettingsChanged(true); }}
                                        className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                                        disabled={settingsLoading} />
                                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">Exit position at this loss</p>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Take-Profit (%)</label>
                                    <input type="number" min={5} max={100} step={1} value={Math.abs(aiSettings.takeProfit * 100)}
                                        onChange={e => { setAISettings(s => ({ ...s, takeProfit: Math.abs(Number(e.target.value)/100) })); setSettingsChanged(true); }}
                                        className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                                        disabled={settingsLoading} />
                                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">Lock in gains at this level</p>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Cash Reserve (%)</label>
                                    <input type="number" min={0} max={50} step={1} value={Math.abs(aiSettings.minCashReserve * 100)}
                                        onChange={e => { setAISettings(s => ({ ...s, minCashReserve: Math.abs(Number(e.target.value)/100) })); setSettingsChanged(true); }}
                                        className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
                                        disabled={settingsLoading} />
                                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">Keep this % uninvested</p>
                                </div>
                            </div>
                            <button onClick={saveAISettings} disabled={settingsLoading || !settingsChanged}
                                className="mt-5 px-6 py-2.5 rounded-xl bg-[var(--color-accent)] text-white font-bold hover:opacity-90 transition-opacity disabled:opacity-40">
                                {settingsLoading ? 'Saving…' : 'Save AI Settings'}
                            </button>
                        </div>

                        {/* Bot Position Sizing */}
                        <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-6">
                            <div className="flex items-center justify-between mb-1">
                                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">Bot Position Sizing</h2>
                                <span className="text-xs bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] px-3 py-1 rounded-lg font-medium">Saved per account</span>
                            </div>
                            <p className="text-sm text-[var(--color-text-secondary)] mb-5">Controls how much the AI bot invests per trade and which signals it acts on.</p>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Max Order ($)</label>
                                    <input type="number" min={500} max={100000} step={500} value={botConfig.maxOrderNotional}
                                        onChange={e => { setBotConfig(c => ({ ...c, maxOrderNotional: Number(e.target.value) })); setBotConfigChanged(true); }}
                                        className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]" />
                                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">Hard $ cap per single trade</p>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Min Buy Score</label>
                                    <input type="number" min={50} max={95} step={1} value={botConfig.minBuyScore}
                                        onChange={e => { setBotConfig(c => ({ ...c, minBuyScore: Number(e.target.value) })); setBotConfigChanged(true); }}
                                        className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]" />
                                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">AI score needed to buy</p>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Max Positions</label>
                                    <input type="number" min={1} max={20} step={1} value={botConfig.maxOpenPositions}
                                        onChange={e => { setBotConfig(c => ({ ...c, maxOpenPositions: Number(e.target.value) })); setBotConfigChanged(true); }}
                                        className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]" />
                                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">Max stocks held at once</p>
                                </div>
                                <div>
                                    <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Max Invested (%)</label>
                                    <input type="number" min={10} max={100} step={5} value={botConfig.maxGrossExposurePct}
                                        onChange={e => { setBotConfig(c => ({ ...c, maxGrossExposurePct: Number(e.target.value) })); setBotConfigChanged(true); }}
                                        className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] font-semibold focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]" />
                                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">Cash reserve = 100 − this</p>
                                </div>
                            </div>
                            <div className="flex items-center gap-4 mt-5">
                                <button onClick={saveBotConfig} disabled={botConfigSaving || !botConfigChanged}
                                    className="px-6 py-2.5 rounded-xl bg-[var(--color-accent)] text-white font-bold hover:opacity-90 transition-opacity disabled:opacity-40">
                                    {botConfigSaving ? 'Saving…' : 'Save Bot Config'}
                                </button>
                                {botConfigMsg && <span className={`text-sm font-semibold ${botConfigMsg.startsWith('✓') ? 'text-green-500' : 'text-red-500'}`}>{botConfigMsg}</span>}
                            </div>
                            <p className="mt-3 text-xs text-[var(--color-text-secondary)]">Changes take effect on the next bot cycle (every 5 min during market hours).</p>
                        </div>

                        {/* Danger Zone */}
                        <div className="bg-[var(--color-card)] border border-red-500/30 rounded-2xl p-6">
                            <h2 className="text-lg font-bold text-red-500 mb-1">Danger Zone</h2>
                            {isLiveAccount ? (
                                <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl p-4 mt-3">
                                    <span className="text-amber-400 text-lg mt-0.5">⚠</span>
                                    <div>
                                        <p className="text-sm font-semibold text-amber-400 mb-1">Live Alpaca account — these controls are disabled</p>
                                        <p className="text-xs text-[var(--color-text-secondary)]">Cash balance is controlled by Alpaca and synced automatically each bot cycle. To close positions, use your Alpaca dashboard directly — the reconciliation service will sync the DB within minutes.</p>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <p className="text-sm text-[var(--color-text-secondary)] mb-5">These actions modify your account balance and cannot be undone.</p>
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                        <div className="bg-[var(--color-bg-tertiary)] rounded-xl p-4">
                                            <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Reset Cash Balance</label>
                                            <div className="flex gap-2">
                                                <input type="number" min="0" step="0.01" value={resetAmount} onChange={e => setResetAmount(e.target.value)} placeholder="Amount ($)"
                                                    className="flex-1 px-3 py-2.5 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]" />
                                                <button onClick={handleResetBalance} className="px-4 py-2.5 rounded-xl bg-blue-500 text-white text-sm font-bold hover:opacity-90 transition-opacity">Reset</button>
                                            </div>
                                            <p className="text-xs text-[var(--color-text-secondary)] mt-2">Sets cash to exact amount. Holdings are kept.</p>
                                        </div>
                                        <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
                                            <div className="text-xs font-bold text-red-500 uppercase tracking-wider mb-2">Clear Entire Portfolio</div>
                                            <p className="text-xs text-[var(--color-text-secondary)] mb-3">Permanently resets cash, holdings, and all trade history to zero.</p>
                                            <button onClick={handleClearAll} className="w-full py-2.5 rounded-xl bg-red-500 text-white text-sm font-bold hover:opacity-90 transition-opacity">
                                                Clear All Portfolio
                                            </button>
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>{/* ── closes left column flex-1 ── */}

        {/* RIGHT SIDEBAR — desktop only */}
        <div className="hidden lg:block w-80 xl:w-96 border-l border-[var(--color-border)] sticky top-0 h-screen overflow-y-auto">
            {holdingsPanel}
        </div>

        </div>{/* ── closes max-w-7xl two-col container ── */}

            {/* ── Deposit Modal ── */}
            {showDepositModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-6 w-full max-w-sm shadow-2xl">
                        <h3 className="text-xl font-bold text-[var(--color-text-primary)] mb-5">Deposit Funds</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Amount ($)</label>
                                <input type="number" value={depositAmount} onChange={e => setDepositAmount(e.target.value)} placeholder="0.00" min="0" step="0.01" autoFocus
                                    className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] text-2xl font-bold tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]" />
                            </div>
                            <div className="flex gap-3">
                                <button onClick={handleDeposit} className="flex-1 py-3 rounded-xl bg-green-500 text-white font-bold hover:opacity-90 transition-opacity">Deposit</button>
                                <button onClick={() => { setShowDepositModal(false); setDepositAmount(''); }} className="flex-1 py-3 rounded-xl border border-[var(--color-border)] text-[var(--color-text-primary)] font-bold hover:bg-[var(--color-bg-tertiary)] transition-colors">Cancel</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Withdraw Modal ── */}
            {showWithdrawModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-6 w-full max-w-sm shadow-2xl">
                        <h3 className="text-xl font-bold text-[var(--color-text-primary)] mb-1">Withdraw Funds</h3>
                        <p className="text-sm text-[var(--color-text-secondary)] mb-5">Available: {usd(cashBalance)}</p>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Amount ($)</label>
                                <input type="number" value={withdrawAmount} onChange={e => setWithdrawAmount(e.target.value)} placeholder="0.00" min="0" step="0.01" autoFocus
                                    className="w-full px-4 py-3 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] text-2xl font-bold tabular-nums focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]" />
                            </div>
                            <div className="flex gap-3">
                                <button onClick={handleWithdraw} className="flex-1 py-3 rounded-xl bg-red-500 text-white font-bold hover:opacity-90 transition-opacity">Withdraw</button>
                                <button onClick={() => { setShowWithdrawModal(false); setWithdrawAmount(''); }} className="flex-1 py-3 rounded-xl border border-[var(--color-border)] text-[var(--color-text-primary)] font-bold hover:bg-[var(--color-bg-tertiary)] transition-colors">Cancel</button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default PortfolioPage;
