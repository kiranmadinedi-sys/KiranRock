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
    const [_loading, setLoading] = useState(false);
    const [initialLoading, setInitialLoading] = useState(true);
    const [cashBalance, setCashBalance] = useState(0);
    const [holdings, setHoldings] = useState<any[]>([]);
    const [tradeSymbol, setTradeSymbol] = useState('');
    const [tradeQuantity, setTradeQuantity] = useState('');
    const [tradeType, setTradeType] = useState('buy');
    const [currentPrice, setCurrentPrice] = useState<number | null>(null);
    const [loadingPrice, setLoadingPrice] = useState(false);
    const [tradeMessage, setTradeMessage] = useState<{ type: string; text: string } | null>(null);
    const [tradeHistory, setTradeHistory] = useState<any[]>([]);
    const [_performanceData, setPerformanceData] = useState<any>(null);
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
    // Chart scrubbing — touch/drag over the chart to see the value at that point in time
    const [scrubIndex, setScrubIndex] = useState<number | null>(null);
    const scrubXRef = useRef<number | null>(null);
    // Position detail sheet
    const [selectedPosition, setSelectedPosition] = useState<any | null>(null);
    const [showPositionSheet, setShowPositionSheet] = useState(false);
    // What the price badge shows — cycles on tap when sheet is closed
    type DisplayMode = 'price' | 'pct_change' | 'equity' | 'total_return' | 'total_pct';
    const [displayMode, setDisplayMode] = useState<DisplayMode>('price');
    const [_showDisplayPicker, _setShowDisplayPicker] = useState(false);

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

    // Auto-refresh every 30 s — summary + the active chart range, so the line itself
    // moves in near-real-time instead of only the hero number (2026-07-08 request).
    useEffect(() => {
        if (!token) return;
        let cancelled = false;

        const schedule = () => {
            const delay = 30_000;
            autoRefreshRef.current = setTimeout(async () => {
                if (cancelled) return;
                await Promise.all([silentRefreshPortfolio(), fetchPortfolioHistory(chartRange)]);
                if (!cancelled) schedule();
            }, delay);
        };

        schedule();
        return () => {
            cancelled = true;
            if (autoRefreshRef.current) clearTimeout(autoRefreshRef.current);
        };
    }, [token, silentRefreshPortfolio, chartRange]);

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
        catch (e) { console.error(e); } finally { setLoading(false); setInitialLoading(false); }
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
        // "1D" is now a calendar day anchored to midnight ET (portfolioHistoryService.js),
        // so the label needs to render in ET too — the viewer's own local timezone can be
        // off by an hour (CDT vs EDT) or more (other US zones), making a point that's
        // genuinely midnight ET show as "11:00 PM" or similar (found 2026-07-21).
        if (range === '1D') return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
        // 1W/1M/3M are now all bucketed every 30 min (2026-07-11) — date-only would show
        // the same label for every point on the same day, with no way to tell them apart
        // while scrubbing.
        if (range === '1W' || range === '1M' || range === '3M') {
            return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
        }
        // 1Y is bucketed weekly (was monthly) — needs the day, not just month+year, or
        // every week within the same month would show an identical label.
        if (range === '1Y') return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
        return date.toLocaleDateString([], { month: 'short', year: '2-digit' });
    };

    const fetchPortfolioHistory = async (range: string) => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/trading/portfolio-history?range=${range}`, { headers: { Authorization: `Bearer ${token}` } });
            if (res.status === 401) { handleAuthError(); return; }
            if (!res.ok) throw new Error('Failed');
            const payload = await res.json();
            const history = Array.isArray(payload) ? payload : (payload.history || []);
            const normalized = history.map((p: any) => ({ time: formatHistoryLabel(p.time, range), value: Number(p.value) || 0, depositsSince: Number(p.depositsSince) || 0 })).filter((p: any) => Number.isFinite(p.value));
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
    const totalInvested       = portfolioSummary.totalInvested        || 0;
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

    // Chart.js auto-fits the y-axis tightly to the data's own min/max with no floor, so a
    // genuinely tiny move (e.g. ~0.5% overnight drift) fills the whole chart height and
    // looks like a dramatic spike/crash — the data is accurate, only the scale is
    // misleading (found 2026-07-21). Enforce a minimum visible range (1.5% of the average
    // value) so small real moves render small; larger real moves still use the full
    // height on their own since min/max here only widen a range that's already narrower
    // than the floor, never shrink one that's wider.
    const chartValues = portfolioHistory.map(p => p.value).filter((v: number) => typeof v === 'number' && !Number.isNaN(v));
    let yMin: number | undefined;
    let yMax: number | undefined;
    if (chartValues.length > 0) {
        const dataMin = Math.min(...chartValues, openValue ?? Infinity);
        const dataMax = Math.max(...chartValues, openValue ?? -Infinity);
        const avg = (dataMin + dataMax) / 2 || 1;
        const MIN_VISIBLE_RANGE_PCT = 0.015;
        const floorRange = avg * MIN_VISIBLE_RANGE_PCT;
        const actualRange = dataMax - dataMin;
        const pad = actualRange < floorRange ? (floorRange - actualRange) / 2 : actualRange * 0.05;
        yMin = dataMin - pad;
        yMax = dataMax + pad;
    }

    const chartOptions = {
        responsive: true, maintainAspectRatio: false,
        plugins: {
            legend: { display: false },
            // The floating Chart.js tooltip box is replaced by the hero number updating
            // live as the user scrubs (Robinhood-style) — see onHover below.
            tooltip: { enabled: false },
        },
        scales: { x: { display: false }, y: { display: false, min: yMin, max: yMax } },
        interaction: { mode: 'index' as const, intersect: false },
        onHover: (_event: any, elements: any[]) => {
            if (elements && elements.length > 0) {
                scrubXRef.current = elements[0].element.x;
                setScrubIndex(elements[0].index);
            } else {
                scrubXRef.current = null;
                setScrubIndex(null);
            }
        },
    };

    // Thin dashed crosshair at the scrubbed point — Chart.js has no built-in equivalent,
    // and pulling in the annotation plugin for one line isn't worth the bundle weight.
    const scrubLinePlugin = {
        id: 'scrubLine',
        afterDraw: (chart: any) => {
            const x = scrubXRef.current;
            const { ctx, chartArea } = chart;
            if (x == null || !chartArea) return;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(x, chartArea.top);
            ctx.lineTo(x, chartArea.bottom);
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(148,163,184,0.7)';
            ctx.setLineDash([4, 4]);
            ctx.stroke();
            ctx.restore();
        },
    };

    const resetScrub = () => { scrubXRef.current = null; setScrubIndex(null); };
    const scrubbedPoint = scrubIndex != null ? portfolioHistory[scrubIndex] : null;

    // ── Mini sparkline SVG — Robinhood style (deterministic noise + trend) ──
    const MiniSparkline = ({ symbol, plPct }: { symbol: string; plPct: number }) => {
        const isUp = plPct >= 0;
        const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
        const W = 80, H = 32, pts = 14;
        const rand = (i: number) => ((seed * 9301 + i * 49297 + 233) % 1000) / 1000;
        const points: [number, number][] = Array.from({ length: pts }, (_, i) => {
            const t = i / (pts - 1);
            // More organic noise with local variation
            const noise = (rand(i) - 0.5) * 0.4 + (rand(i * 3 + 7) - 0.5) * 0.15;
            const trend = isUp ? t * 0.55 : -t * 0.55;
            const y = 0.5 - trend + noise;
            return [Math.round(t * (W - 2) + 1), Math.round(Math.max(0.05, Math.min(0.95, y)) * H)];
        });
        // Smooth curve using quadratic bezier midpoints
        let d = `M${points[0][0]},${points[0][1]}`;
        for (let i = 1; i < points.length - 1; i++) {
            const mx = (points[i][0] + points[i+1][0]) / 2;
            const my = (points[i][1] + points[i+1][1]) / 2;
            d += ` Q${points[i][0]},${points[i][1]} ${mx},${my}`;
        }
        d += ` L${points[pts-1][0]},${points[pts-1][1]}`;
        // Dotted midline (Robinhood shows a subtle dotted reference line)
        const color = isUp ? '#00c805' : '#ff5000';
        return (
            <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="flex-shrink-0">
                <line x1="1" y1={H/2} x2={W-1} y2={H/2} stroke={color} strokeWidth="0.8" strokeDasharray="2,3" opacity="0.25" />
                <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        );
    };

    // ── Display mode badge label per holding ──────────────────────────────────
    const getBadgeValue = (h: any, mode: DisplayMode): string => {
        const plPct  = h.unrealizedPLPercent || 0;
        const plVal  = h.unrealizedPL || 0;
        const qty    = parseFloat(h.quantity) || 0;
        const cur    = qty > 0 && h.currentValue ? h.currentValue / qty : 0;
        const equity = h.currentValue || 0;
        switch (mode) {
            case 'price':      return `$${cur.toFixed(2)}`;
            case 'pct_change': return `${plPct >= 0 ? '+' : ''}${plPct.toFixed(2)}%`;
            case 'equity':     return `$${equity.toFixed(2)}`;
            case 'total_return': return `${plVal >= 0 ? '+$' : '-$'}${Math.abs(plVal).toFixed(2)}`;
            case 'total_pct':    return `${plPct >= 0 ? '+' : ''}${plPct.toFixed(2)}%`;
        }
    };

    // ── Position compact row (Robinhood list style) ───────────────────────────
    const PositionRow = ({ h }: { h: any }) => {
        const plPct = h.unrealizedPLPercent || 0;
        const plVal = h.unrealizedPL || 0;
        const isUp  = plVal >= 0;
        const qty   = parseFloat(h.quantity) || 0;
        const stale = isPriceStale(h);

        const badgeLabel = getBadgeValue(h, displayMode);
        const badgeColor = isUp ? '#00c805' : '#ff5000'; // Robinhood green / orange-red

        return (
            <div className="flex items-center gap-3 px-4 py-4 border-b border-white/[0.06] active:bg-white/[0.04] transition-colors">
                {/* Symbol + shares — no avatar, just text like Robinhood */}
                <div className="min-w-0 w-28 flex-shrink-0">
                    <div className="font-bold text-[var(--color-text-primary)] text-base leading-tight tracking-wide">
                        {h.symbol}
                    </div>
                    <div className="text-[13px] text-[var(--color-text-secondary)] mt-0.5 truncate">
                        {qty % 1 !== 0 ? qty.toFixed(4) : qty} shares
                        {stale && <span className="ml-1.5 text-[10px] text-amber-500 opacity-70">·stale</span>}
                    </div>
                </div>

                {/* Mini sparkline — flex-1 so it fills available space */}
                <div className="flex-1 flex items-center justify-center">
                    <MiniSparkline symbol={h.symbol} plPct={plPct} />
                </div>

                {/* Price badge — Robinhood style: border only, NO fill, colored text */}
                <button
                    onClick={() => { setSelectedPosition(h); setShowPositionSheet(true); }}
                    style={{ borderColor: badgeColor, color: badgeColor }}
                    className="flex-shrink-0 w-[104px] text-center px-3 py-2.5 rounded-2xl border-[1.5px] bg-transparent font-bold text-[15px] tabular-nums transition-opacity active:opacity-70"
                >
                    {badgeLabel}
                </button>
            </div>
        );
    };

    // ── Position detail bottom sheet ──────────────────────────────────────────
    const PositionDetailSheet = () => {
        const h = selectedPosition;
        if (!h) return null;

        const plPct      = h.unrealizedPLPercent || 0;
        const plVal      = h.unrealizedPL || 0;
        const entryPrice = h.averagePrice || 0;
        const qty        = parseFloat(h.quantity) || 0;
        const curPrice   = qty > 0 && h.currentValue ? h.currentValue / qty : entryPrice;
        const stopPrice  = h.stopPrice  != null ? parseFloat(h.stopPrice)  : null;
        const targetPrice= h.targetPrice!= null ? parseFloat(h.targetPrice): null;
        const stopLocked = h.stopLocked === true;
        const isFrac     = qty !== Math.floor(qty);
        const isUp       = plVal >= 0;

        const stopVsEntry = stopPrice != null && entryPrice > 0
            ? ((stopPrice - entryPrice) / entryPrice) * 100 : null;
        const stopIcon = stopLocked ? '🔒' : isFrac ? '📅' : '🛑';
        const stopBadgeColor = stopVsEntry == null ? 'text-gray-400'
            : stopVsEntry > 0.5 ? 'text-emerald-400'
            : stopVsEntry > -1  ? 'text-amber-400'
            :                     'text-red-400';
        const stopBgColor = stopVsEntry == null ? 'bg-gray-800'
            : stopVsEntry > 0.5 ? 'bg-emerald-900/50 border border-emerald-700/40'
            : stopVsEntry > -1  ? 'bg-amber-900/50 border border-amber-700/40'
            :                     'bg-red-900/50 border border-red-700/40';

        // Risk bar
        const lo = Math.min(stopPrice ?? curPrice * 0.85, curPrice * 0.85);
        const hi = Math.max(targetPrice ?? curPrice * 1.20, curPrice * 1.15);
        const range = hi - lo || 1;
        const barStop   = stopPrice   != null ? Math.max(0, Math.min(100, ((stopPrice   - lo) / range) * 100)) : 0;
        const barEntry  =                       Math.max(0, Math.min(100, ((entryPrice  - lo) / range) * 100));
        const barCur    =                       Math.max(0, Math.min(100, ((curPrice    - lo) / range) * 100));
        const barTarget = targetPrice != null ? Math.max(0, Math.min(100, ((targetPrice - lo) / range) * 100)) : 95;

        const DISPLAY_OPTIONS: { key: DisplayMode; label: string; value: string }[] = [
            { key: 'price',        label: 'Last price',           value: getBadgeValue(h, 'price') },
            { key: 'pct_change',   label: 'Percent change',       value: getBadgeValue(h, 'pct_change') },
            { key: 'equity',       label: 'Your equity',          value: getBadgeValue(h, 'equity') },
            { key: 'total_return', label: 'Total return',         value: getBadgeValue(h, 'total_return') },
            { key: 'total_pct',    label: 'Total percent change', value: getBadgeValue(h, 'total_pct') },
        ];

        return (
            <>
                {/* Backdrop */}
                <div className="fixed inset-0 bg-black/70 z-40 backdrop-blur-sm"
                    onClick={() => setShowPositionSheet(false)} />

                {/* Sheet */}
                <div className="fixed inset-x-0 bottom-0 z-50 max-w-lg mx-auto">
                    <div className="bg-[#111] rounded-t-3xl border-t border-white/10 overflow-hidden max-h-[90vh] overflow-y-auto">

                        {/* Drag handle */}
                        <div className="flex justify-center pt-3 pb-1">
                            <div className="w-10 h-1 rounded-full bg-gray-600" />
                        </div>

                        {/* Header */}
                        <div className="flex items-center justify-between px-5 pt-2 pb-4">
                            <div className="flex items-center gap-3">
                                <div className={`w-11 h-11 rounded-xl ${tickerColor(h.symbol)} flex items-center justify-center text-white font-black text-sm shadow`}>
                                    {h.symbol.slice(0, 2)}
                                </div>
                                <div>
                                    <div className="text-white font-black text-lg">{h.symbol}</div>
                                    <div className="text-gray-400 text-xs">{qty % 1 !== 0 ? qty.toFixed(4) : qty} shares</div>
                                </div>
                            </div>
                            <button onClick={() => setShowPositionSheet(false)} className="w-8 h-8 flex items-center justify-center rounded-full bg-white/10 text-gray-400 hover:bg-white/20">✕</button>
                        </div>

                        {/* Price + P&L hero */}
                        <div className="px-5 pb-4 border-b border-white/[0.08]">
                            <div className="text-3xl font-black text-white tabular-nums">${curPrice.toFixed(2)}</div>
                            <div className={`mt-1 flex items-center gap-2 ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                                <span className="text-sm font-bold">{isUp ? '▲' : '▼'} {signedUsd(plVal)}</span>
                                <span className="text-sm">({signedPct(plPct)})</span>
                                <span className="text-xs text-gray-500">total return</span>
                            </div>
                        </div>

                        {/* Key stats grid */}
                        <div className="grid grid-cols-2 gap-px bg-white/[0.05] border-b border-white/[0.08]">
                            {[
                                { label: 'Entry Price',   value: `$${entryPrice.toFixed(2)}` },
                                { label: 'Market Value',  value: `$${(h.currentValue || 0).toFixed(2)}` },
                                { label: 'Cost Basis',    value: `$${(entryPrice * qty).toFixed(2)}` },
                                { label: 'Shares',        value: qty % 1 !== 0 ? qty.toFixed(4) : String(qty) },
                            ].map(stat => (
                                <div key={stat.label} className="bg-[#111] px-5 py-3">
                                    <div className="text-[10px] text-gray-500 uppercase tracking-wider mb-0.5">{stat.label}</div>
                                    <div className="text-sm font-bold text-white tabular-nums">{stat.value}</div>
                                </div>
                            ))}
                        </div>

                        {/* Risk bar */}
                        <div className="px-5 py-4 border-b border-white/[0.08]">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3">Position Range</div>
                            <div className="relative h-2 bg-gray-800 rounded-full mb-4">
                                {/* Filled zone: stop → current */}
                                <div
                                    className={`absolute h-full rounded-full ${isUp ? 'bg-gradient-to-r from-amber-600 to-emerald-500' : 'bg-gradient-to-r from-red-800 to-red-500'}`}
                                    style={{ left: `${barStop}%`, width: `${Math.max(1, barCur - barStop)}%` }}
                                />
                                {/* Target zone: current → target (light) */}
                                {targetPrice != null && (
                                    <div className="absolute h-full rounded-full bg-blue-900/50"
                                        style={{ left: `${barCur}%`, width: `${Math.max(0, barTarget - barCur)}%` }} />
                                )}
                                {/* Markers */}
                                {stopPrice != null && <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-red-500 border-2 border-red-400 shadow-lg shadow-red-500/40" style={{ left: `calc(${barStop}% - 6px)` }} />}
                                <div className="absolute top-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-gray-400 border border-gray-300" style={{ left: `calc(${barEntry}% - 4px)` }} />
                                <div className={`absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full border-2 shadow-lg ${isUp ? 'bg-emerald-400 border-emerald-300 shadow-emerald-500/40' : 'bg-red-400 border-red-300 shadow-red-500/40'}`} style={{ left: `calc(${barCur}% - 8px)` }} />
                                {targetPrice != null && <div className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-blue-500 border-2 border-blue-400 shadow-lg shadow-blue-500/40" style={{ left: `calc(${Math.min(barTarget, 97)}% - 6px)` }} />}
                            </div>
                            {/* Labels */}
                            <div className="flex justify-between text-[10px]">
                                {stopPrice != null ? (
                                    <div className="text-red-400">
                                        <div className="font-bold">Stop</div>
                                        <div>${stopPrice.toFixed(2)}</div>
                                    </div>
                                ) : <div />}
                                <div className="text-gray-400 text-center">
                                    <div className="font-bold">Entry</div>
                                    <div>${entryPrice.toFixed(2)}</div>
                                </div>
                                <div className={`text-center font-bold ${isUp ? 'text-emerald-400' : 'text-red-400'}`}>
                                    <div>Now</div>
                                    <div>${curPrice.toFixed(2)}</div>
                                </div>
                                {targetPrice != null ? (
                                    <div className="text-blue-400 text-right">
                                        <div className="font-bold">Target</div>
                                        <div>${targetPrice.toFixed(2)}</div>
                                    </div>
                                ) : <div />}
                            </div>
                        </div>

                        {/* Trailing stop section */}
                        <div className="px-5 py-4 border-b border-white/[0.08]">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3">Stop Protection</div>
                            {stopPrice == null ? (
                                <div className="flex items-center gap-2 p-3 rounded-xl bg-red-900/30 border border-red-700/40">
                                    <span className="text-red-400 text-lg">⚠️</span>
                                    <div>
                                        <div className="text-red-400 font-bold text-sm">No stop placed</div>
                                        <div className="text-xs text-gray-500">Monitor will auto-place on next cycle</div>
                                    </div>
                                </div>
                            ) : (
                                <div className={`p-3 rounded-xl ${stopBgColor}`}>
                                    <div className="flex items-center justify-between mb-2">
                                        <div className="flex items-center gap-2">
                                            <span className="text-base">{stopIcon}</span>
                                            <span className={`font-black text-base ${stopBadgeColor}`}>${stopPrice.toFixed(2)}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className={`text-xs font-bold px-2 py-0.5 rounded-md ${isFrac ? 'bg-amber-900/60 text-amber-400' : 'bg-indigo-900/60 text-indigo-400'}`}>
                                                {isFrac ? '📅 DAY' : '🔄 GTC'}
                                            </span>
                                            {stopLocked && (
                                                <span className="text-xs font-bold px-2 py-0.5 rounded-md bg-emerald-900/60 text-emerald-400">
                                                    🔒 Profit locked
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="grid grid-cols-3 gap-2 text-center">
                                        <div>
                                            <div className="text-[10px] text-gray-500">Stop type</div>
                                            <div className={`text-xs font-bold ${stopBadgeColor}`}>{isFrac ? 'Fixed DAY' : plPct > 5 ? 'Trailing GTC' : 'Fixed GTC'}</div>
                                        </div>
                                        <div>
                                            <div className="text-[10px] text-gray-500">vs Entry</div>
                                            <div className={`text-xs font-bold ${stopBadgeColor}`}>
                                                {stopVsEntry != null ? `${stopVsEntry >= 0 ? '+' : ''}${stopVsEntry.toFixed(1)}%` : '—'}
                                            </div>
                                        </div>
                                        <div>
                                            <div className="text-[10px] text-gray-500">Downside</div>
                                            <div className="text-xs font-bold text-gray-300">
                                                {curPrice > 0 ? `-${(((curPrice - stopPrice) / curPrice) * 100).toFixed(1)}%` : '—'}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
                            {/* Target row */}
                            {targetPrice != null && (
                                <div className="mt-2 flex items-center justify-between p-3 rounded-xl bg-blue-900/30 border border-blue-700/40">
                                    <div className="flex items-center gap-2">
                                        <span>🎯</span>
                                        <div>
                                            <div className="text-[10px] text-gray-500">Target price</div>
                                            <div className="text-sm font-bold text-blue-400">${targetPrice.toFixed(2)}</div>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <div className="text-[10px] text-gray-500">Potential gain</div>
                                        <div className="text-sm font-bold text-blue-400">
                                            +{(((targetPrice - entryPrice) / entryPrice) * 100).toFixed(1)}%
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Display data picker (like Robinhood's badge toggle) */}
                        <div className="px-5 py-4 border-b border-white/[0.08]">
                            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-2">Display data</div>
                            {DISPLAY_OPTIONS.map(opt => (
                                <button key={opt.key} onClick={() => setDisplayMode(opt.key)}
                                    className="w-full flex items-center justify-between py-3 border-b border-white/[0.05] last:border-0 hover:bg-white/[0.04] transition-colors">
                                    <span className="text-white text-sm">{opt.label}</span>
                                    <div className="flex items-center gap-3">
                                        <span className="text-gray-400 text-sm tabular-nums">{opt.value}</span>
                                        {displayMode === opt.key && <span className="text-emerald-400 text-lg">✓</span>}
                                    </div>
                                </button>
                            ))}
                        </div>

                        {/* Bottom spacer for home indicator */}
                        <div className="h-8" />
                    </div>
                </div>
            </>
        );
    };

    // ── Loading skeleton — shown only on first load, never on silent refresh ──
    const Shimmer = ({ className }: { className: string }) => (
        <div className={`animate-pulse rounded-lg bg-[var(--color-bg-tertiary)] ${className}`} />
    );
    const PortfolioSkeleton = () => (
        <div className="lg:flex lg:items-start w-full">
            <div className="flex-1 min-w-0 lg:border-r lg:border-[var(--color-border)]">
                <div className="px-4 lg:px-10 pt-8">
                    <Shimmer className="h-3 w-20 mb-3" />
                    <Shimmer className="h-11 w-56 mb-3" />
                    <Shimmer className="h-4 w-40" />
                </div>
                <div className="px-4 lg:px-10 mt-6">
                    <Shimmer className="h-52 sm:h-64 lg:h-72 w-full rounded-2xl" />
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 border-y border-[var(--color-border)] mt-6">
                    {Array.from({ length: 6 }).map((_, i) => (
                        <div key={i} className="px-3 lg:px-6 py-3.5">
                            <Shimmer className="h-2.5 w-16 mb-2" />
                            <Shimmer className="h-4 w-20 mb-1.5" />
                            <Shimmer className="h-2.5 w-24" />
                        </div>
                    ))}
                </div>
                <div className="lg:hidden px-4 py-5 space-y-4">
                    {Array.from({ length: 3 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-3">
                            <Shimmer className="h-9 w-24" />
                            <Shimmer className="h-8 flex-1" />
                            <Shimmer className="h-9 w-24 rounded-2xl" />
                        </div>
                    ))}
                </div>
            </div>
            <div className="hidden lg:block w-80 xl:w-96 px-4 py-5 space-y-4">
                {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3">
                        <Shimmer className="h-9 w-24" />
                        <Shimmer className="h-8 flex-1" />
                        <Shimmer className="h-9 w-24 rounded-2xl" />
                    </div>
                ))}
            </div>
        </div>
    );

    // ── Holdings panel ────────────────────────────────────────────────────────
    const holdingsPanel = (
        <div className="pb-2">
            {/* Header — Robinhood style: "STOCKS & ETFS (n)" left, "Price ⇄" right */}
            <div className="flex items-center justify-between px-4 pt-5 pb-1">
                <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-[var(--color-text-secondary)]">
                    Stocks &amp; ETFs{positionCount > 0 ? ` (${positionCount})` : ''}
                </span>
                {holdings.length > 0 && (
                    <button
                        onClick={() => {
                            const modes: DisplayMode[] = ['price','pct_change','equity','total_return','total_pct'];
                            const idx = modes.indexOf(displayMode);
                            setDisplayMode(modes[(idx + 1) % modes.length]);
                        }}
                        className="flex items-center gap-1 text-[13px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
                    >
                        <span>{displayMode === 'price' ? 'Price' : displayMode === 'pct_change' ? '% Change' : displayMode === 'equity' ? 'Equity' : displayMode === 'total_return' ? 'Return $' : 'Return %'}</span>
                        <span className="opacity-50">⇄</span>
                    </button>
                )}
            </div>

            {holdings.length === 0 ? (
                <div className="mx-3 py-12 text-center rounded-2xl border border-white/[0.06] bg-gray-900/50">
                    <div className="text-4xl mb-3">📈</div>
                    <p className="text-sm font-semibold text-gray-400">No positions yet</p>
                    <p className="text-xs text-gray-600 mt-1 mb-4">Deposit funds to start trading</p>
                    <button onClick={() => setShowDepositModal(true)}
                        className="px-6 py-2.5 rounded-full bg-[var(--color-accent)] text-white text-sm font-bold hover:opacity-90 transition-opacity">
                        Deposit Funds
                    </button>
                </div>
            ) : (
                <>
                    {holdings.map(h => <PositionRow key={h.symbol} h={h} />)}

                    {/* Summary footer card */}
                    <div className="mx-4 mt-2 mb-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-4 py-3">
                        <div className="grid grid-cols-3 gap-3">
                            {[
                                { label: 'Market Value', value: usd(totalHoldingsValue), color: 'text-[var(--color-text-primary)]' },
                                { label: 'Unrealized P/L', value: signedUsd(totalUnrealizedPL), color: totalUnrealizedPL >= 0 ? 'text-green-600' : 'text-red-500' },
                                { label: 'Realized P/L', value: signedUsd(totalRealizedPL), color: totalRealizedPL >= 0 ? 'text-green-600' : 'text-red-500' },
                            ].map(s => (
                                <div key={s.label} className="text-center">
                                    <div className="text-[10px] text-[var(--color-text-secondary)] mb-0.5">{s.label}</div>
                                    <div className={`text-xs font-bold tabular-nums ${s.color}`}>{s.value}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                </>
            )}
        </div>
    );

    // ── Render ──────────────────────────────────────────────────────────────────
    if (initialLoading) {
        return (
            <div className="min-h-screen bg-[var(--color-bg-primary)] safe-bottom">
                <div className="max-w-7xl mx-auto">
                    <PortfolioSkeleton />
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[var(--color-bg-primary)] safe-bottom">

        {/* Position detail bottom sheet */}
        {showPositionSheet && <PositionDetailSheet />}

        <div className="max-w-7xl mx-auto lg:flex lg:items-start">

            {/* ═══════════════════════════════════════════════════════════════════
                LEFT COLUMN — chart + stats + tabs
            ═══════════════════════════════════════════════════════════════════ */}
            <div className="flex-1 min-w-0 lg:border-r lg:border-[var(--color-border)]">

                {/* ── Hero ── */}
                <div className="px-4 lg:px-10 pt-8">
                    <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--color-text-secondary)] mb-2">Investing</p>

                    <div className="text-5xl font-bold text-[var(--color-text-primary)] tabular-nums leading-none">
                        {usd(scrubbedPoint ? scrubbedPoint.value : totalPortfolioValue)}
                    </div>

                    {(() => {
                        // While scrubbing, show the change from the touched point to now — using
                        // depositsSince (deposits/withdrawals between that point and now, computed
                        // server-side per-point) to net out cash flow, same as the backend's own
                        // changeValue. A naive value-only diff here reproduced the exact "+990%"
                        // deposit-as-profit bug client-side (found 2026-07-09); this mirrors the
                        // backend's all-time-anchor safeguard for points that predate the account's
                        // real funding (e.g. a stale seed snapshot before the first real deposit).
                        if (scrubbedPoint) {
                            const totalDepositedAllTime = totalInvested;
                            const depositsSince = scrubbedPoint.depositsSince || 0;
                            const scrubChangeValue = (totalDepositedAllTime > 0 && depositsSince >= totalDepositedAllTime - 0.01)
                                ? totalPortfolioValue - totalDepositedAllTime
                                : (totalPortfolioValue - scrubbedPoint.value) - depositsSince;
                            const scrubChangePct = totalDepositedAllTime > 0 ? (scrubChangeValue / totalDepositedAllTime) * 100 : 0;
                            const isPos = scrubChangeValue >= 0;
                            return (
                                <div className={`mt-2 flex items-center gap-1.5 text-sm font-semibold ${isPos ? 'text-green-500' : 'text-red-500'}`}>
                                    <span className="text-base leading-none">{isPos ? '▲' : '▼'}</span>
                                    <span>{signedUsd(scrubChangeValue)}</span>
                                    <span className="opacity-80">({signedPct(scrubChangePct)})</span>
                                    <span className="text-[var(--color-text-secondary)] font-normal text-xs ml-1">{scrubbedPoint.time}</span>
                                </div>
                            );
                        }

                        // "Today" is ambiguous when the market's closed (it'd span back to last
                        // close, maybe days over a weekend) — show Unrealized P&L instead for that
                        // one case. But 1W/1M/3M/YTD/1Y are well-defined date ranges regardless of
                        // whether the market happens to be open right now — always show the real
                        // period change for those, or switching periods would look like nothing
                        // changes (2026-07-08 report: selecting 1W kept showing a static $0.00).
                        const showUnrealized = !isMarketHours() && chartRange === '1D';
                        const displayVal     = showUnrealized ? totalUnrealizedPL : portfolioChange.value;
                        const displayPct     = showUnrealized
                            ? (totalHoldingsValue > 0 ? (totalUnrealizedPL / (totalHoldingsValue - totalUnrealizedPL)) * 100 : 0)
                            : portfolioChange.percent;
                        const displayLabel   = showUnrealized ? 'Unrealized' : portfolioChange.label;
                        const isPos          = displayVal >= 0;
                        return (
                            <div className={`mt-2 flex items-center gap-1.5 text-sm font-semibold ${isPos ? 'text-green-500' : 'text-red-500'}`}>
                                <span className="text-base leading-none">{isPos ? '▲' : '▼'}</span>
                                <span>{signedUsd(displayVal)}</span>
                                <span className="opacity-80">({signedPct(displayPct)})</span>
                                <span className="text-[var(--color-text-secondary)] font-normal text-xs ml-1">{displayLabel}</span>
                            </div>
                        );
                    })()}

                    {/* Live refresh indicator */}
                    <div className="mt-2 flex items-center gap-1.5">
                        <span className={`inline-block w-1.5 h-1.5 rounded-full ${isMarketHours() ? 'bg-green-400 animate-pulse' : 'bg-gray-500'}`} />
                        <span className="text-[11px] text-[var(--color-text-secondary)]">
                            {isMarketHours() ? 'Live · updates every 30 sec' : 'Market closed · updates every 30 sec'}
                            {lastRefreshed && (
                                <span className="ml-1 opacity-60">
                                    · {lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                </span>
                            )}
                        </span>
                    </div>
                </div>

                {/* ── Chart — edge-to-edge on mobile ── */}
                <div className="relative h-52 sm:h-64 lg:h-72 mt-6 -mx-0"
                    onMouseLeave={resetScrub} onTouchEnd={resetScrub} onTouchCancel={resetScrub}>
                    <Line data={chartData} options={chartOptions} plugins={[scrubLinePlugin]} />
                </div>

                {/* ── Period selector — filled pill on the active range so selection is
                     unmistakable at a glance (a thin underline was too subtle in light mode,
                     per 2026-07-08 feedback) ── */}
                <div className="flex items-center gap-1.5 overflow-x-auto scrollbar-hide border-b border-[var(--color-border)] px-4 lg:px-10 py-2.5">
                    {/* LIVE dot */}
                    <button onClick={() => setChartRange('1D')}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${
                            chartRange === '1D'
                                ? 'bg-green-500 text-white shadow-sm'
                                : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                        }`}>
                        <span className="relative flex h-1.5 w-1.5 flex-shrink-0">
                            {chartRange === '1D' && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75" />}
                            <span className={`relative inline-flex rounded-full h-1.5 w-1.5 ${chartRange === '1D' ? 'bg-white' : 'bg-[var(--color-text-secondary)]'}`} />
                        </span>
                        LIVE
                    </button>
                    {['1D','1W','1M','3M','YTD','1Y'].map(r => (
                        <button key={r} onClick={() => setChartRange(r)}
                            className={`px-3 py-1.5 rounded-full text-xs font-bold whitespace-nowrap transition-colors ${
                                chartRange === r
                                    ? 'bg-[var(--color-accent)] text-white shadow-sm'
                                    : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                            }`}>
                            {r}
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

                {/* ── Stats grid — 6 cells, 2×3 on phones / 3×2 from sm: up, plain-English labels ── */}
                <div className="grid grid-cols-2 sm:grid-cols-3 divide-x divide-y divide-[var(--color-border)] border-b border-[var(--color-border)]">
                    {[
                        {
                            label: 'Portfolio Value',
                            tooltip: 'Cash + all open positions at current market price',
                            value: usd(totalPortfolioValue),
                            valueColor: 'text-[var(--color-text-primary)]',
                            sub: `Cash ${ usd(cashBalance) } + Positions ${ usd(totalHoldingsValue) }`,
                            subColor: 'text-[var(--color-text-secondary)]',
                        },
                        {
                            label: 'Cash Available',
                            tooltip: 'Cash ready to invest — not tied up in positions',
                            value: usd(cashBalance),
                            valueColor: 'text-[var(--color-text-primary)]',
                            sub: 'Ready to invest',
                            subColor: 'text-[var(--color-text-secondary)]',
                        },
                        {
                            label: 'Open Positions',
                            tooltip: 'Current market value of all stocks you hold right now',
                            value: usd(totalHoldingsValue),
                            valueColor: 'text-[var(--color-text-primary)]',
                            sub: `${positionCount} stocks held`,
                            subColor: 'text-[var(--color-text-secondary)]',
                        },
                        {
                            label: 'Account Return',
                            tooltip: `Portfolio value (${usd(totalPortfolioValue)}) minus net deposits (${usd(totalInvested)}). Only accurate if all deposits were made via KiranRock — Alpaca-direct deposits are not tracked here.`,
                            value: signedUsd(overallPL),
                            valueColor: overallPL >= 0 ? 'text-green-500' : 'text-red-500',
                            sub: `vs ${usd(totalInvested)} deposited`,
                            subColor: 'text-[var(--color-text-secondary)]',
                        },
                        {
                            label: 'Realized P/L',
                            tooltip: 'Profit/loss from trades you already closed — this is locked in and does not change',
                            value: signedUsd(totalRealizedPL),
                            valueColor: totalRealizedPL >= 0 ? 'text-green-500' : 'text-red-500',
                            sub: 'Closed trades · locked in',
                            subColor: 'text-[var(--color-text-secondary)]',
                        },
                        {
                            label: 'Unrealized P/L',
                            tooltip: 'Current gain/loss on open positions — changes every minute with market price',
                            value: signedUsd(totalUnrealizedPL),
                            valueColor: totalUnrealizedPL >= 0 ? 'text-green-500' : 'text-red-500',
                            sub: 'Open positions · live',
                            subColor: 'text-[var(--color-text-secondary)]',
                        },
                    ].map((stat) => (
                        <div key={stat.label} title={stat.tooltip} className="px-3 lg:px-6 py-3.5 cursor-help">
                            <div className="text-[9px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 leading-tight">{stat.label}</div>
                            <div className={`text-sm font-bold tabular-nums ${stat.valueColor} truncate`}>{stat.value}</div>
                            <div className={`text-[10px] mt-0.5 leading-tight ${stat.subColor} truncate`}>{stat.sub}</div>
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

                        {/* Ledger summary — mobile-friendly grid */}
                        {ledgerData && (
                            <div className="mb-5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] overflow-hidden">
                                <div className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
                                    <span className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)]">Account Activity Summary</span>
                                    {ledgerData.source === 'alpaca' && (
                                        <span className="text-[10px] font-semibold text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-full">Live from Alpaca</span>
                                    )}
                                    {ledgerData.source === 'db_fallback' && (
                                        <span className="text-[10px] font-semibold text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded-full">Local DB</span>
                                    )}
                                </div>
                                <div className="grid grid-cols-3 divide-x divide-y divide-[var(--color-border)]">
                                    {[
                                        { icon: '💰', label: 'Deposited', value: ledgerData.totalDeposits, valueColor: 'text-blue-500', hint: 'Cash added to account' },
                                        { icon: '📤', label: 'Withdrawn', value: ledgerData.totalWithdrawals, valueColor: 'text-orange-500', hint: 'Cash taken out' },
                                        { icon: '📈', label: 'Dividends', value: ledgerData.totalDividends || 0, valueColor: 'text-purple-500', hint: 'Dividends received' },
                                        { icon: '🛒', label: 'Total Bought', value: ledgerData.totalBuys, valueColor: 'text-green-600', hint: 'Value of all buy orders' },
                                        { icon: '💵', label: 'Total Sold', value: ledgerData.totalSells, valueColor: 'text-red-500', hint: 'Value of all sell orders' },
                                        { icon: '🏦', label: 'Commissions', value: ledgerData.totalCommission, valueColor: 'text-[var(--color-text-secondary)]', hint: 'Fees paid' },
                                    ].map(item => (
                                        <div key={item.label} className="px-3 py-3.5 flex flex-col gap-1" title={item.hint}>
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-sm">{item.icon}</span>
                                                <span className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-wide leading-tight">{item.label}</span>
                                            </div>
                                            <div className={`text-sm font-bold tabular-nums ${item.valueColor}`}>
                                                ${item.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                {/* Net flow row */}
                                <div className="px-4 py-2.5 bg-[var(--color-bg-tertiary)] border-t border-[var(--color-border)] flex items-center justify-between">
                                    <span className="text-xs text-[var(--color-text-secondary)]">Net cash flow (Deposits − Withdrawals)</span>
                                    <span className={`text-sm font-bold tabular-nums ${(ledgerData.totalDeposits - ledgerData.totalWithdrawals) >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                                        ${(ledgerData.totalDeposits - ledgerData.totalWithdrawals).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                    </span>
                                </div>
                            </div>
                        )}

                        {tradeHistory.length === 0 ? (
                            <div className="text-center py-16 text-[var(--color-text-secondary)]">No transactions yet.</div>
                        ) : (() => {
                            const sortedHistory = sortSymbol
                                ? [...tradeHistory].sort((a, b) => {
                                    const sa = (a.symbol ?? '').toUpperCase();
                                    const sb = (b.symbol ?? '').toUpperCase();
                                    return sortSymbol === 'asc' ? sa.localeCompare(sb) : sb.localeCompare(sa);
                                  })
                                : tradeHistory;
                            return (
                            <>
                            {/* ═══ Mobile: card list — a scrolling 8-column table doesn't read as a real app ═══ */}
                            <div className="lg:hidden space-y-2">
                                {sortedHistory.map(trade => {
                                    const badge = trade.type === 'BUY' ? 'bg-green-500/15 text-green-600' : trade.type === 'SELL' ? 'bg-red-500/15 text-red-600' : trade.type === 'DEPOSIT' ? 'bg-blue-500/15 text-blue-600' : trade.type === 'WITHDRAWAL' ? 'bg-amber-500/15 text-amber-600' : 'bg-gray-500/15 text-[var(--color-text-secondary)]';
                                    const isCash = trade.type === 'DEPOSIT' || trade.type === 'WITHDRAWAL';
                                    const amount = trade.total ?? ((trade.price ?? 0) * (trade.quantity ?? 0));
                                    const hasPnl      = trade.pnl != null;
                                    const hasUnrealized = !hasPnl && trade.unrealizedPL != null;
                                    const plValue     = hasPnl ? trade.pnl : (hasUnrealized ? trade.unrealizedPL : null);
                                    const plPct       = hasPnl ? trade.pnlPercent : (hasUnrealized ? trade.unrealizedPLPercent : null);
                                    const plColor     = plValue == null ? 'text-[var(--color-text-secondary)]'
                                        : plValue >= 0 ? 'text-green-500' : 'text-red-500';
                                    return (
                                        <div key={trade.id} className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl px-4 py-3 active:bg-[var(--color-bg-tertiary)] transition-colors">
                                            <div className="flex items-center justify-between mb-1.5">
                                                <div className="flex items-center gap-2 min-w-0">
                                                    <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full flex-shrink-0 ${badge}`}>{trade.type}</span>
                                                    {!isCash && <span className="font-bold text-[var(--color-text-primary)] truncate">{trade.symbol}</span>}
                                                    {trade.aiScore != null && (
                                                        <span className={`px-1.5 py-0.5 text-[10px] font-bold rounded-full flex-shrink-0 ${trade.aiScore >= 80 ? 'bg-green-500/15 text-green-600' : trade.aiScore >= 60 ? 'bg-yellow-500/15 text-yellow-600' : 'bg-gray-500/15 text-[var(--color-text-secondary)]'}`}>{trade.aiScore}</span>
                                                    )}
                                                </div>
                                                <span className="text-[11px] text-[var(--color-text-secondary)] flex-shrink-0 ml-2">{new Date(trade.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                                            </div>
                                            <div className="flex items-center justify-between">
                                                <span className="text-xs text-[var(--color-text-secondary)]">
                                                    {isCash ? new Date(trade.timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : `${trade.quantity} sh @ $${(trade.price ?? 0).toFixed(2)}`}
                                                </span>
                                                <div className="text-right">
                                                    <span className="font-semibold text-[var(--color-text-primary)] text-sm tabular-nums">${(amount ?? 0).toFixed(2)}</span>
                                                    {plValue != null && (
                                                        <span className={`ml-2 text-xs font-semibold tabular-nums ${plColor}`}>
                                                            {plValue >= 0 ? '+' : '-'}${Math.abs(plValue).toFixed(2)}
                                                            {plPct != null && ` (${plPct >= 0 ? '+' : ''}${plPct.toFixed(1)}%)`}
                                                            {hasUnrealized && <span className="ml-1 text-[9px] uppercase text-amber-600">unrl</span>}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>

                            {/* ═══ Desktop: full table ═══ */}
                            <div className="hidden lg:block bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl overflow-hidden">
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
                                            {sortedHistory.map(trade => {
                                                const badge = trade.type === 'BUY' ? 'bg-green-500/15 text-green-600' : trade.type === 'SELL' ? 'bg-red-500/15 text-red-600' : trade.type === 'DEPOSIT' ? 'bg-blue-500/15 text-blue-600' : trade.type === 'WITHDRAWAL' ? 'bg-amber-500/15 text-amber-600' : 'bg-gray-500/15 text-[var(--color-text-secondary)]';
                                                const isCash = trade.type === 'DEPOSIT' || trade.type === 'WITHDRAWAL';
                                                const amount = trade.total ?? ((trade.price ?? 0) * (trade.quantity ?? 0));
                                                const hasPnl      = trade.pnl != null;
                                                const hasUnrealized = !hasPnl && trade.unrealizedPL != null;
                                                const plValue     = hasPnl ? trade.pnl : (hasUnrealized ? trade.unrealizedPL : null);
                                                const plPct       = hasPnl ? trade.pnlPercent : (hasUnrealized ? trade.unrealizedPLPercent : null);
                                                const plColor     = plValue == null ? 'text-[var(--color-text-secondary)]'
                                                    : plValue >= 0 ? 'text-green-500' : 'text-red-500';
                                                return (
                                                    <tr key={trade.id} className="hover:bg-[var(--color-bg-tertiary)] transition-colors">
                                                        <td className="px-4 py-3 whitespace-nowrap text-xs text-[var(--color-text-secondary)]">{new Date(trade.timestamp).toLocaleString()}</td>
                                                        <td className="px-4 py-3 whitespace-nowrap"><span className={`px-2.5 py-0.5 text-xs font-bold rounded-full ${badge}`}>{trade.type}</span></td>
                                                        <td className="px-4 py-3 whitespace-nowrap font-bold text-[var(--color-text-primary)]">{isCash ? '—' : trade.symbol}</td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-right text-[var(--color-text-secondary)]">{isCash ? '—' : trade.quantity}</td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-right text-[var(--color-text-secondary)]">{isCash ? '—' : `$${(trade.price ?? 0).toFixed(2)}`}</td>
                                                        <td className="px-4 py-3 whitespace-nowrap text-right font-semibold text-[var(--color-text-primary)]">${(amount ?? 0).toFixed(2)}</td>
                                                        <td className={`px-4 py-3 whitespace-nowrap text-right font-semibold ${plColor}`}>
                                                            {plValue == null ? '—' : (
                                                                <span className="inline-flex flex-col items-end gap-0.5">
                                                                    <span>
                                                                        {plValue >= 0 ? '+' : '-'}${Math.abs(plValue).toFixed(2)}
                                                                        {plPct != null && (
                                                                            <span className="ml-1 text-xs opacity-75">
                                                                                ({plPct >= 0 ? '+' : ''}{plPct.toFixed(1)}%)
                                                                            </span>
                                                                        )}
                                                                    </span>
                                                                    {hasUnrealized && (
                                                                        <span className="px-1 py-px text-[9px] font-semibold uppercase tracking-wide rounded bg-amber-500/15 text-amber-600">
                                                                            unrealized
                                                                        </span>
                                                                    )}
                                                                </span>
                                                            )}
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
                            </>
                            );
                        })()}

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

                        <div className="mt-6">
                            <h3 className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-3">Quick Sell from Holdings</h3>
                            {holdings.length === 0 ? (
                                <div className="py-8 text-center rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-bg-tertiary)]/40">
                                    <p className="text-sm font-semibold text-[var(--color-text-secondary)]">No positions to sell</p>
                                    <p className="text-xs text-[var(--color-text-secondary)] opacity-70 mt-1">Buy a stock above and it'll show up here</p>
                                </div>
                            ) : (
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
                            )}
                        </div>
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
