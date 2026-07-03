'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { getApiBaseUrl } from '../config';
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, PointElement, LineElement,
    Filler, Tooltip, Legend,
} from 'chart.js';
import { Line } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend);

// ── Types ─────────────────────────────────────────────────────────────────────

interface Trade {
    id: number;
    symbol: string;
    quantity: number;
    exitPrice: number | null;
    entryPrice: number | null;
    closedAt: string | null;
    openedAt: string | null;
    pnl: number | null;
    pnlPct: number | null;
    holdHours: number | null;
    slippagePct: number | null;
    aiScore: number | null;
    sector: string | null;
    regime: string | null;
    exitType: string | null;
    executedBy: string | null;
    outcome: string | null;
}

interface AggRow {
    bucket: string;
    total: number;
    wins: number;
    winRate: number;
    avgReturn: number;
    totalPnl: number;
}

interface ScoreBucket {
    bucket: string;
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    avgReturn: number;
    totalPnl: number;
    avgPnl: number;
    avgWinPct: number;
    avgLossPct: number;
    expectancy: number;
}

interface HoldBucket {
    bucket: string;
    total: number;
    wins: number;
    losses: number;
    winRate: number;
    avgReturn: number;
    totalPnl: number;
    avgPnl: number;
    avgWinPct: number;
    avgLossPct: number;
    expectancy: number;
    avgHours: number;
}

interface EquityPoint {
    date: string;
    dailyPnl: number;
    cumulativePnl: number;
    drawdown: number;
    trades: number;
    wins: number;
    losses: number;
    bestTrade: number;
    worstTrade: number;
    symbols: string;
}

interface EquityData {
    days: number;
    totalTrades: number;
    finalPnl: number;
    peakPnl: number;
    maxDrawdown: number;
    points: EquityPoint[];
}

interface HealthMetric {
    key: string;
    label: string;
    desc: string;
    current: number | null;
    target: string;
    unit: string;
    status: 'green' | 'yellow' | 'red' | 'na';
    note?: string;
}

interface HealthData {
    days: number;
    total: number;
    metrics: HealthMetric[];
    summary: { passing: number; warning: number; failing: number; na: number };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmtPct = (n: number | null) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtUsd = (n: number | null) => n == null ? '—' : `${n >= 0 ? '+$' : '-$'}${Math.abs(n).toFixed(2)}`;

function pnlColor(v: number | null) {
    if (v == null) return 'text-gray-400';
    return v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400';
}

function scoreColor(s: number | null) {
    if (s == null) return 'text-gray-400';
    if (s >= 95) return 'text-purple-400 font-bold';
    if (s >= 90) return 'text-blue-400';
    return 'text-gray-300';
}

function regimeBadge(r: string | null) {
    if (!r) return <span className="text-gray-500">—</span>;
    const colors: Record<string, string> = {
        BULL_STRONG: 'bg-green-900 text-green-300',
        BULL_MILD:   'bg-emerald-900 text-emerald-300',
        BULL:        'bg-green-900 text-green-300',
        NEUTRAL:     'bg-gray-700 text-gray-300',
        CHOPPY:      'bg-yellow-900 text-yellow-300',
        BEAR:        'bg-red-900 text-red-300',
        PANIC:       'bg-pink-900 text-pink-200',
    };
    return (
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[r] || 'bg-gray-700 text-gray-300'}`}>
            {r.replace(/_/g, ' ')}
        </span>
    );
}

function exitBadge(t: string | null) {
    if (!t) return <span className="text-gray-500">—</span>;
    const colors: Record<string, string> = {
        trailing_stop:      'text-orange-400',
        stop_loss:          'text-red-400',
        partial_take_profit:'text-blue-400',
        take_profit:        'text-green-400',
        time_exit:          'text-yellow-400',
        manual:             'text-gray-400',
        bot:                'text-gray-300',
    };
    return <span className={colors[t] || 'text-gray-300'}>{t.replace(/_/g, ' ')}</span>;
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
    return (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
            <p className="text-xs text-gray-400 mb-1">{label}</p>
            <p className={`text-2xl font-bold ${color || 'text-white'}`}>{value}</p>
            {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
        </div>
    );
}

function AggTable({ title, rows }: { title: string; rows: AggRow[] }) {
    if (!rows.length) return null;
    return (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-200 mb-3">{title}</h3>
            <table className="w-full text-xs">
                <thead>
                    <tr className="text-gray-400 border-b border-gray-700">
                        <th className="text-left pb-2 pr-3">Bucket</th>
                        <th className="text-right pb-2 pr-3">Trades</th>
                        <th className="text-right pb-2 pr-3">Win %</th>
                        <th className="text-right pb-2 pr-3">Avg Return</th>
                        <th className="text-right pb-2">Net P&L</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={i} className="border-b border-gray-700/40 hover:bg-gray-700/30">
                            <td className="py-2 pr-3 font-medium text-white capitalize">{r.bucket.replace(/_/g, ' ')}</td>
                            <td className="text-right pr-3 text-gray-300">{r.total}</td>
                            <td className={`text-right pr-3 font-medium ${r.winRate >= 55 ? 'text-green-400' : r.winRate >= 45 ? 'text-yellow-400' : 'text-red-400'}`}>
                                {r.winRate.toFixed(0)}%
                            </td>
                            <td className={`text-right pr-3 ${pnlColor(r.avgReturn)}`}>{fmtPct(r.avgReturn)}</td>
                            <td className={`text-right ${pnlColor(r.totalPnl)}`}>{fmtUsd(r.totalPnl)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'trades' | 'score' | 'hold' | 'health' | 'equity';
type SortKey = 'closedAt' | 'symbol' | 'pnlPct' | 'aiScore' | 'holdHours';
type SortDir = 'asc' | 'desc';

export default function AnalyticsPage() {
    const router = useRouter();

    const [tab, setTab] = useState<Tab>('trades');
    const [days, setDays] = useState(90);

    // Plain-English summary state
    const [summary, setSummary]           = useState<string>('');
    const [summaryLoading, setSummaryLoading] = useState(false);
    const [summaryStats, setSummaryStats] = useState<Record<string, any> | null>(null);
    const [summaryDays, setSummaryDays]   = useState<number | null>(null); // which period the summary was generated for

    // Trade log state
    const [trades, setTrades]     = useState<Trade[]>([]);
    const [aggByExit, setAggByExit]     = useState<AggRow[]>([]);
    const [aggBySector, setAggBySector] = useState<AggRow[]>([]);
    const [aggByRegime, setAggByRegime] = useState<AggRow[]>([]);
    const [aggByHold, setAggByHold]     = useState<AggRow[]>([]);
    const [filterOptions, setFilterOptions] = useState<{ sectors: string[]; regimes: string[]; exitTypes: string[] }>({ sectors: [], regimes: [], exitTypes: [] });
    const [loading, setLoading] = useState(false);

    // Bucket analytics state
    const [scoreBuckets, setScoreBuckets] = useState<ScoreBucket[]>([]);
    const [holdBuckets, setHoldBuckets]   = useState<HoldBucket[]>([]);
    const [loadingBuckets, setLoadingBuckets] = useState(false);

    // Strategy health state
    const [health, setHealth]           = useState<HealthData | null>(null);
    const [loadingHealth, setLoadingHealth] = useState(false);

    // Equity curve state
    const [equity, setEquity]           = useState<EquityData | null>(null);
    const [loadingEquity, setLoadingEquity] = useState(false);

    // Filters
    const [filterOutcome,  setFilterOutcome]  = useState('');
    const [filterSector,   setFilterSector]   = useState('');
    const [filterRegime,   setFilterRegime]   = useState('');
    const [filterExit,     setFilterExit]     = useState('');
    const [filterMinScore, setFilterMinScore] = useState('');
    const [filterMaxScore, setFilterMaxScore] = useState('');

    // Sort
    const [sortKey, setSortKey] = useState<SortKey>('closedAt');
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    const fetchTradeLog = useCallback(async (token: string) => {
        setLoading(true);
        try {
            const res = await fetch(
                `${getApiBaseUrl()}/api/performance/trade-log?days=${days}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (!res.ok) { handleAuthError(res.status); return; }
            const data = await res.json();
            setTrades(data.trades || []);
            setAggByExit(data.byExit || []);
            setAggBySector(data.bySector || []);
            setAggByRegime(data.byRegime || []);
            setAggByHold(data.byHold || []);
            setFilterOptions({
                sectors:   data.filters?.sectors   || [],
                regimes:   data.filters?.regimes   || [],
                exitTypes: data.filters?.exitTypes || [],
            });
        } finally {
            setLoading(false);
        }
    }, [days]);

    const fetchBuckets = useCallback(async (token: string) => {
        setLoadingBuckets(true);
        try {
            const [sRes, hRes] = await Promise.all([
                fetch(`${getApiBaseUrl()}/api/performance/score-analysis?days=${days}`, { headers: { Authorization: `Bearer ${token}` } }),
                fetch(`${getApiBaseUrl()}/api/performance/hold-time-analysis?days=${days}`, { headers: { Authorization: `Bearer ${token}` } }),
            ]);
            if (sRes.ok) { const d = await sRes.json(); setScoreBuckets(d.buckets || []); }
            if (hRes.ok) { const d = await hRes.json(); setHoldBuckets(d.buckets || []); }
        } finally {
            setLoadingBuckets(false);
        }
    }, [days]);

    const fetchHealth = useCallback(async (token: string) => {
        setLoadingHealth(true);
        try {
            const res = await fetch(
                `${getApiBaseUrl()}/api/performance/strategy-health?days=${days}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (res.ok) { const d = await res.json(); setHealth(d); }
        } finally {
            setLoadingHealth(false);
        }
    }, [days]);

    const fetchEquity = useCallback(async (token: string) => {
        setLoadingEquity(true);
        try {
            const res = await fetch(
                `${getApiBaseUrl()}/api/performance/equity-curve?days=${days}`,
                { headers: { Authorization: `Bearer ${token}` } }
            );
            if (res.ok) { const d = await res.json(); setEquity(d); }
        } finally {
            setLoadingEquity(false);
        }
    }, [days]);

    const fetchSummary = useCallback(async () => {
        const token = getAuthToken();
        if (!token) return;
        setSummaryLoading(true);
        setSummary('');
        setSummaryStats(null);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/performance/plain-summary`, {
                method:  'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body:    JSON.stringify({ days }),
            });
            if (!res.ok) return;
            const data = await res.json();
            setSummary(data.summary || '');
            setSummaryStats(data.stats || null);
            setSummaryDays(days);
        } finally {
            setSummaryLoading(false);
        }
    }, [days]);

    // Clear stale summary when period changes
    useEffect(() => {
        if (summaryDays !== null && summaryDays !== days) {
            setSummary('');
            setSummaryStats(null);
            setSummaryDays(null);
        }
    }, [days, summaryDays]);

    useEffect(() => {
        const token = getAuthToken();
        if (!token) { router.push('/login'); return; }
        fetchTradeLog(token);
        fetchBuckets(token);
        fetchHealth(token);
        fetchEquity(token);
    }, [fetchTradeLog, fetchBuckets, fetchHealth, fetchEquity, router]);

    // Client-side filters
    const filtered = trades.filter(t => {
        if (filterOutcome === 'win'  && (t.pnl == null || t.pnl <= 0)) return false;
        if (filterOutcome === 'loss' && (t.pnl == null || t.pnl >= 0)) return false;
        if (filterSector && t.sector   !== filterSector)  return false;
        if (filterRegime && t.regime   !== filterRegime)  return false;
        if (filterExit   && t.exitType !== filterExit)    return false;
        if (filterMinScore && (t.aiScore == null || t.aiScore < parseFloat(filterMinScore))) return false;
        if (filterMaxScore && (t.aiScore == null || t.aiScore > parseFloat(filterMaxScore))) return false;
        return true;
    });

    // Sort
    const sorted = [...filtered].sort((a, b) => {
        let av: number | string | null = null;
        let bv: number | string | null = null;
        if (sortKey === 'closedAt')  { av = a.closedAt; bv = b.closedAt; }
        if (sortKey === 'symbol')    { av = a.symbol;   bv = b.symbol; }
        if (sortKey === 'pnlPct')    { av = a.pnlPct;   bv = b.pnlPct; }
        if (sortKey === 'aiScore')   { av = a.aiScore;  bv = b.aiScore; }
        if (sortKey === 'holdHours') { av = a.holdHours; bv = b.holdHours; }
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return sortDir === 'asc' ? -1 : 1;
        if (av > bv) return sortDir === 'asc' ? 1  : -1;
        return 0;
    });

    // Summary stats
    const wins   = filtered.filter(t => t.pnl != null && t.pnl > 0).length;
    const netPnl = filtered.reduce((s, t) => s + (t.pnl || 0), 0);
    const avgRet = filtered.length > 0
        ? filtered.reduce((s, t) => s + (t.pnlPct || 0), 0) / filtered.length : 0;
    const winRate = filtered.length > 0 ? (wins / filtered.length) * 100 : 0;

    function toggleSort(key: SortKey) {
        if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        else { setSortKey(key); setSortDir('desc'); }
    }

    function SortBtn({ k, label }: { k: SortKey; label: string }) {
        return (
            <button onClick={() => toggleSort(k)} className="flex items-center gap-1 hover:text-white transition-colors whitespace-nowrap">
                {label}
                {sortKey === k && <span className="text-blue-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            </button>
        );
    }

    const TABS: { id: Tab; label: string }[] = [
        { id: 'trades', label: 'Trade Log' },
        { id: 'equity', label: 'Equity Curve' },
        { id: 'score',  label: 'Score Analysis' },
        { id: 'hold',   label: 'Hold Time' },
        { id: 'health', label: 'Strategy Health' },
    ];

    return (
        <div className="min-h-screen bg-gray-900 text-white p-4 md:p-6">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
                <div>
                    <h1 className="text-2xl font-bold">Trade Review</h1>
                    <p className="text-sm text-gray-400 mt-0.5">All executed trades — filter, sort, and find patterns</p>
                </div>
                <div className="flex items-center gap-2">
                    {(['30','90','180','365'] as const).map(d => (
                        <button key={d} onClick={() => setDays(parseInt(d))}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                                days === parseInt(d) ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                            }`}>{d}d</button>
                    ))}
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <StatCard label="Filtered Trades" value={String(filtered.length)}
                    sub={`${wins}W / ${filtered.length - wins}L`} />
                <StatCard label="Win Rate" value={`${winRate.toFixed(0)}%`}
                    color={winRate >= 55 ? 'text-green-400' : winRate >= 45 ? 'text-yellow-400' : 'text-red-400'} />
                <StatCard label="Net P&L" value={fmtUsd(netPnl)} color={pnlColor(netPnl)} />
                <StatCard label="Avg Return" value={fmtPct(avgRet)} color={pnlColor(avgRet)} />
            </div>

            {/* ── Plain-English Summary Panel ────────────────────────────── */}
            <div className="mb-6">
                {/* Button row */}
                <div className="flex items-center gap-3 mb-3">
                    <button
                        onClick={fetchSummary}
                        disabled={summaryLoading}
                        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all shadow-lg ${
                            summaryLoading
                                ? 'bg-purple-800 text-purple-300 cursor-not-allowed'
                                : 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white'
                        }`}
                    >
                        <span className="text-base">{summaryLoading ? '⏳' : '✨'}</span>
                        {summaryLoading
                            ? 'Generating summary…'
                            : summary
                                ? `Refresh summary (${days}d)`
                                : `Explain my ${days}-day performance in plain English`}
                    </button>
                    {summary && !summaryLoading && (
                        <span className="text-xs text-gray-500">
                            Generated for last {summaryDays} days
                            {summaryDays !== days && <span className="text-yellow-400 ml-1">— period changed, click to refresh</span>}
                        </span>
                    )}
                </div>

                {/* Summary card */}
                {(summary || summaryLoading) && (
                    <div className="bg-gradient-to-br from-gray-800 to-gray-800/80 border border-purple-700/50 rounded-2xl p-5 relative overflow-hidden">
                        {/* decorative glow */}
                        <div className="absolute top-0 left-0 w-40 h-40 bg-purple-600/10 rounded-full -translate-x-10 -translate-y-10 pointer-events-none" />

                        <div className="flex items-start gap-3 mb-3">
                            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple-500 to-indigo-500 flex items-center justify-center text-white text-sm flex-shrink-0 mt-0.5">
                                ✨
                            </div>
                            <div>
                                <p className="text-sm font-semibold text-purple-300">Plain-English Summary</p>
                                <p className="text-xs text-gray-500">
                                    {summaryStats ? `${summaryStats.totalTrades} closed trades · last ${summaryDays ?? days} days` : 'Analysing…'}
                                </p>
                            </div>
                        </div>

                        {summaryLoading ? (
                            <div className="space-y-2.5 pl-11">
                                {[80,95,70,85,60].map((w,i) => (
                                    <div key={i} className={`h-3.5 bg-gray-700 rounded animate-pulse`} style={{ width: `${w}%` }} />
                                ))}
                            </div>
                        ) : (
                            <div className="pl-11">
                                <p className="text-gray-200 text-sm leading-relaxed whitespace-pre-wrap">{summary}</p>

                                {/* Stat pills */}
                                {summaryStats && summaryStats.totalTrades > 0 && (
                                    <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-gray-700/50">
                                        <span className="px-2.5 py-1 rounded-full bg-gray-700 text-xs text-gray-300">
                                            {summaryStats.winners}W / {summaryStats.losers}L
                                        </span>
                                        <span className={`px-2.5 py-1 rounded-full bg-gray-700 text-xs font-medium ${summaryStats.winRatePct >= 55 ? 'text-green-400' : summaryStats.winRatePct >= 45 ? 'text-yellow-400' : 'text-red-400'}`}>
                                            {summaryStats.winRatePct}% win rate
                                        </span>
                                        <span className={`px-2.5 py-1 rounded-full bg-gray-700 text-xs font-medium ${summaryStats.netPnlUsd >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                            {summaryStats.netPnlUsd >= 0 ? '+' : ''}{summaryStats.netPnlUsd?.toFixed(2)} net P&L
                                        </span>
                                        <span className="px-2.5 py-1 rounded-full bg-gray-700 text-xs text-gray-300">
                                            Profit factor {summaryStats.profitFactor}
                                        </span>
                                        {summaryStats.bestSymbol && (
                                            <span className="px-2.5 py-1 rounded-full bg-green-900/60 text-xs text-green-300">
                                                Best: {summaryStats.bestSymbol} (+${summaryStats.bestTradePnl?.toFixed(2)})
                                            </span>
                                        )}
                                        {summaryStats.worstSymbol && (
                                            <span className="px-2.5 py-1 rounded-full bg-red-900/60 text-xs text-red-300">
                                                Worst: {summaryStats.worstSymbol} (${summaryStats.worstTradePnl?.toFixed(2)})
                                            </span>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                )}
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mb-4 bg-gray-800 rounded-xl p-1 w-fit">
                {TABS.map(t => (
                    <button key={t.id} onClick={() => setTab(t.id)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            tab === t.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                        }`}>{t.label}</button>
                ))}
            </div>

            {/* ── Trade Log ──────────────────────────────────────────────────── */}
            {tab === 'trades' && (
                <div className="space-y-4">
                    {/* Filters */}
                    <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
                        <div className="flex flex-wrap items-center gap-3">
                            <span className="text-xs text-gray-400 font-medium">Filters:</span>

                            <select value={filterOutcome} onChange={e => setFilterOutcome(e.target.value)}
                                className="bg-gray-700 text-sm text-gray-200 border border-gray-600 rounded-lg px-2 py-1.5">
                                <option value="">All outcomes</option>
                                <option value="win">Winners only</option>
                                <option value="loss">Losers only</option>
                            </select>

                            <select value={filterSector} onChange={e => setFilterSector(e.target.value)}
                                className="bg-gray-700 text-sm text-gray-200 border border-gray-600 rounded-lg px-2 py-1.5">
                                <option value="">All sectors</option>
                                {filterOptions.sectors.map(s => <option key={s} value={s}>{s}</option>)}
                            </select>

                            <select value={filterRegime} onChange={e => setFilterRegime(e.target.value)}
                                className="bg-gray-700 text-sm text-gray-200 border border-gray-600 rounded-lg px-2 py-1.5">
                                <option value="">All regimes</option>
                                {filterOptions.regimes.map(r => <option key={r} value={r}>{r}</option>)}
                            </select>

                            <select value={filterExit} onChange={e => setFilterExit(e.target.value)}
                                className="bg-gray-700 text-sm text-gray-200 border border-gray-600 rounded-lg px-2 py-1.5">
                                <option value="">All exit types</option>
                                {filterOptions.exitTypes.map(x => <option key={x} value={x}>{x.replace(/_/g,' ')}</option>)}
                            </select>

                            <div className="flex items-center gap-1.5">
                                <span className="text-xs text-gray-400">Score:</span>
                                <input type="number" placeholder="min" value={filterMinScore}
                                    onChange={e => setFilterMinScore(e.target.value)}
                                    className="w-16 bg-gray-700 text-sm text-gray-200 border border-gray-600 rounded-lg px-2 py-1.5" />
                                <span className="text-gray-500">–</span>
                                <input type="number" placeholder="max" value={filterMaxScore}
                                    onChange={e => setFilterMaxScore(e.target.value)}
                                    className="w-16 bg-gray-700 text-sm text-gray-200 border border-gray-600 rounded-lg px-2 py-1.5" />
                            </div>

                            {(filterOutcome || filterSector || filterRegime || filterExit || filterMinScore || filterMaxScore) && (
                                <button onClick={() => { setFilterOutcome(''); setFilterSector(''); setFilterRegime(''); setFilterExit(''); setFilterMinScore(''); setFilterMaxScore(''); }}
                                    className="text-xs text-red-400 hover:text-red-300 underline">Clear all</button>
                            )}
                            <span className="ml-auto text-xs text-gray-500">{sorted.length} of {trades.length} trades</span>
                        </div>
                    </div>

                    {/* Table */}
                    <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                        {loading ? (
                            <div className="flex items-center justify-center h-40 text-gray-400">Loading trades...</div>
                        ) : sorted.length === 0 ? (
                            <div className="flex items-center justify-center h-40 text-gray-400">No trades match the current filters</div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                    <thead className="bg-gray-900/60 sticky top-0">
                                        <tr className="text-gray-400">
                                            <th className="text-left px-3 py-3"><SortBtn k="closedAt" label="Date" /></th>
                                            <th className="text-left px-3 py-3"><SortBtn k="symbol" label="Symbol" /></th>
                                            <th className="text-right px-3 py-3"><SortBtn k="aiScore" label="Score" /></th>
                                            <th className="text-left px-3 py-3">Regime</th>
                                            <th className="text-left px-3 py-3">Sector</th>
                                            <th className="text-left px-3 py-3">Exit</th>
                                            <th className="text-right px-3 py-3">Entry</th>
                                            <th className="text-right px-3 py-3">Exit $</th>
                                            <th className="text-right px-3 py-3"><SortBtn k="pnlPct" label="Return" /></th>
                                            <th className="text-right px-3 py-3">P&L</th>
                                            <th className="text-right px-3 py-3"><SortBtn k="holdHours" label="Hold" /></th>
                                            <th className="text-right px-3 py-3">Slippage</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {sorted.map(t => (
                                            <tr key={t.id} className="border-t border-gray-700/40 hover:bg-gray-700/20 transition-colors">
                                                <td className="px-3 py-2.5 text-gray-400 whitespace-nowrap">
                                                    {t.closedAt ? new Date(t.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                                                </td>
                                                <td className="px-3 py-2.5 font-bold text-white">{t.symbol}</td>
                                                <td className={`px-3 py-2.5 text-right ${scoreColor(t.aiScore)}`}>
                                                    {t.aiScore != null ? t.aiScore.toFixed(0) : '—'}
                                                </td>
                                                <td className="px-3 py-2.5">{regimeBadge(t.regime)}</td>
                                                <td className="px-3 py-2.5 text-gray-400 max-w-[100px] truncate">{t.sector || '—'}</td>
                                                <td className="px-3 py-2.5">{exitBadge(t.exitType)}</td>
                                                <td className="px-3 py-2.5 text-right text-gray-400">
                                                    {t.entryPrice != null ? `$${t.entryPrice.toFixed(2)}` : '—'}
                                                </td>
                                                <td className="px-3 py-2.5 text-right text-gray-400">
                                                    {t.exitPrice != null ? `$${t.exitPrice.toFixed(2)}` : '—'}
                                                </td>
                                                <td className={`px-3 py-2.5 text-right font-semibold ${pnlColor(t.pnlPct)}`}>
                                                    {fmtPct(t.pnlPct)}
                                                </td>
                                                <td className={`px-3 py-2.5 text-right ${pnlColor(t.pnl)}`}>
                                                    {fmtUsd(t.pnl)}
                                                </td>
                                                <td className="px-3 py-2.5 text-right text-gray-400">
                                                    {t.holdHours != null ? `${t.holdHours.toFixed(0)}h` : '—'}
                                                </td>
                                                <td className="px-3 py-2.5 text-right text-gray-500">
                                                    {t.slippagePct != null ? fmtPct(t.slippagePct) : '—'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    {/* Breakdown tables */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <AggTable title="By Sector"     rows={aggBySector} />
                        <AggTable title="By Regime"     rows={aggByRegime} />
                        <AggTable title="By Exit Type"  rows={aggByExit} />
                        <AggTable title="By Hold Period" rows={aggByHold} />
                    </div>
                </div>
            )}

            {/* ── Score Analysis ─────────────────────────────────────────────── */}
            {tab === 'score' && (
                <div className="space-y-4">
                    <p className="text-sm text-gray-400">
                        Win rate and expectancy per AI score bucket from the <code className="text-blue-400">trades</code> table.
                        Buckets tuned to your bot's range (base minBuyScore = 88).
                    </p>
                    {loadingBuckets ? (
                        <div className="flex items-center justify-center h-32 text-gray-400">Loading...</div>
                    ) : scoreBuckets.length === 0 ? (
                        <div className="bg-gray-800 border border-gray-700 rounded-xl p-8 text-center text-gray-400">
                            No score data yet — needs SELL records with ai_score populated.
                        </div>
                    ) : (
                        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                            <table className="w-full text-sm">
                                <thead className="bg-gray-900/60">
                                    <tr className="text-gray-400 text-xs">
                                        <th className="text-left px-4 py-3">Score Range</th>
                                        <th className="text-right px-4 py-3">Trades</th>
                                        <th className="text-right px-4 py-3">W / L</th>
                                        <th className="text-right px-4 py-3">Win Rate</th>
                                        <th className="text-right px-4 py-3">Avg Return</th>
                                        <th className="text-right px-4 py-3">Avg Win</th>
                                        <th className="text-right px-4 py-3">Avg Loss</th>
                                        <th className="text-right px-4 py-3">Expectancy</th>
                                        <th className="text-right px-4 py-3">Net P&L</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {scoreBuckets.map((b, i) => (
                                        <tr key={i} className="border-t border-gray-700/50 hover:bg-gray-700/20">
                                            <td className="px-4 py-3 font-bold text-white">{b.bucket}</td>
                                            <td className="px-4 py-3 text-right text-gray-300">{b.total}</td>
                                            <td className="px-4 py-3 text-right">
                                                <span className="text-green-400">{b.wins}</span>
                                                <span className="text-gray-500"> / </span>
                                                <span className="text-red-400">{b.losses}</span>
                                            </td>
                                            <td className={`px-4 py-3 text-right font-semibold ${b.winRate >= 55 ? 'text-green-400' : b.winRate >= 45 ? 'text-yellow-400' : 'text-red-400'}`}>
                                                {b.winRate.toFixed(0)}%
                                            </td>
                                            <td className={`px-4 py-3 text-right ${pnlColor(b.avgReturn)}`}>{fmtPct(b.avgReturn)}</td>
                                            <td className="px-4 py-3 text-right text-green-400">{fmtPct(b.avgWinPct)}</td>
                                            <td className="px-4 py-3 text-right text-red-400">{fmtPct(b.avgLossPct)}</td>
                                            <td className={`px-4 py-3 text-right font-semibold ${pnlColor(b.expectancy)}`}>{fmtPct(b.expectancy)}</td>
                                            <td className={`px-4 py-3 text-right ${pnlColor(b.totalPnl)}`}>{fmtUsd(b.totalPnl)}</td>
                                        </tr>
                                    ))}
                                </tbody>
            </table>
                        </div>
                    )}
                </div>
            )}

            {/* ── Hold Time ──────────────────────────────────────────────────── */}
            {tab === 'hold' && (
                <div className="space-y-4">
                    <p className="text-sm text-gray-400">
                        Performance by hold duration using <code className="text-blue-400">hold_hours</code> on SELL records.
                    </p>
                    {loadingBuckets ? (
                        <div className="flex items-center justify-center h-32 text-gray-400">Loading...</div>
                    ) : holdBuckets.length === 0 ? (
                        <div className="bg-gray-800 border border-gray-700 rounded-xl p-8 text-center text-gray-400">
                            No hold-time data yet — needs SELL records with hold_hours populated.
                        </div>
                    ) : (
                        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                            <table className="w-full text-sm">
                                <thead className="bg-gray-900/60">
                                    <tr className="text-gray-400 text-xs">
                                        <th className="text-left px-4 py-3">Hold Period</th>
                                        <th className="text-right px-4 py-3">Trades</th>
                                        <th className="text-right px-4 py-3">W / L</th>
                                        <th className="text-right px-4 py-3">Win Rate</th>
                                        <th className="text-right px-4 py-3">Avg Return</th>
                                        <th className="text-right px-4 py-3">Avg Win</th>
                                        <th className="text-right px-4 py-3">Avg Loss</th>
                                        <th className="text-right px-4 py-3">Expectancy</th>
                                        <th className="text-right px-4 py-3">Avg Hours</th>
                                        <th className="text-right px-4 py-3">Net P&L</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {holdBuckets.map((b, i) => (
                                        <tr key={i} className="border-t border-gray-700/50 hover:bg-gray-700/20">
                                            <td className="px-4 py-3 font-bold text-white">{b.bucket}</td>
                                            <td className="px-4 py-3 text-right text-gray-300">{b.total}</td>
                                            <td className="px-4 py-3 text-right">
                                                <span className="text-green-400">{b.wins}</span>
                                                <span className="text-gray-500"> / </span>
                                                <span className="text-red-400">{b.losses}</span>
                                            </td>
                                            <td className={`px-4 py-3 text-right font-semibold ${b.winRate >= 55 ? 'text-green-400' : b.winRate >= 45 ? 'text-yellow-400' : 'text-red-400'}`}>
                                                {b.winRate.toFixed(0)}%
                                            </td>
                                            <td className={`px-4 py-3 text-right ${pnlColor(b.avgReturn)}`}>{fmtPct(b.avgReturn)}</td>
                                            <td className="px-4 py-3 text-right text-green-400">{fmtPct(b.avgWinPct)}</td>
                                            <td className="px-4 py-3 text-right text-red-400">{fmtPct(b.avgLossPct)}</td>
                                            <td className={`px-4 py-3 text-right font-semibold ${pnlColor(b.expectancy)}`}>{fmtPct(b.expectancy)}</td>
                                            <td className="px-4 py-3 text-right text-gray-400">{b.avgHours.toFixed(0)}h</td>
                                            <td className={`px-4 py-3 text-right ${pnlColor(b.totalPnl)}`}>{fmtUsd(b.totalPnl)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}

                    {aggByHold.length > 0 && (
                        <AggTable title="Hold Period (live breakdown from trade log)" rows={aggByHold} />
                    )}
                </div>
            )}

            {/* ── Equity Curve ────────────────────────────────────────────────── */}
            {tab === 'equity' && (
                <div className="space-y-4">
                    {loadingEquity ? (
                        <div className="flex items-center justify-center h-48 text-gray-400">Loading equity curve...</div>
                    ) : !equity || equity.points.length === 0 ? (
                        <div className="bg-gray-800 border border-gray-700 rounded-xl p-8 text-center text-gray-400">
                            No closed trade data yet for this period.
                        </div>
                    ) : (
                        <>
                            {/* Summary cards */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                <StatCard label="Final P&L"     value={fmtUsd(equity.finalPnl)}    color={pnlColor(equity.finalPnl)} />
                                <StatCard label="Peak P&L"      value={fmtUsd(equity.peakPnl)}     color="text-blue-400" />
                                <StatCard label="Max Drawdown"  value={fmtUsd(equity.maxDrawdown)} color={equity.maxDrawdown < -100 ? 'text-red-400' : 'text-yellow-400'}
                                    sub="from peak to trough" />
                                <StatCard label="Trading Days"  value={String(equity.points.length)} sub={`${equity.totalTrades} total trades`} />
                            </div>

                            {/* Cumulative P&L line chart */}
                            <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
                                <h3 className="text-sm font-semibold text-gray-200 mb-4">Cumulative P&L Over Time</h3>
                                <Line
                                    data={{
                                        labels: equity.points.map(p => {
                                            const d = new Date(p.date);
                                            return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                                        }),
                                        datasets: [
                                            {
                                                label: 'Cumulative P&L ($)',
                                                data: equity.points.map(p => p.cumulativePnl),
                                                borderColor: equity.finalPnl >= 0 ? '#4ade80' : '#f87171',
                                                backgroundColor: equity.finalPnl >= 0 ? 'rgba(74,222,128,0.08)' : 'rgba(248,113,113,0.08)',
                                                fill: true,
                                                tension: 0.3,
                                                pointRadius: equity.points.length > 40 ? 2 : 4,
                                                pointHoverRadius: 6,
                                            },
                                            {
                                                label: 'Drawdown ($)',
                                                data: equity.points.map(p => p.drawdown),
                                                borderColor: 'rgba(248,113,113,0.6)',
                                                backgroundColor: 'rgba(248,113,113,0.05)',
                                                fill: true,
                                                tension: 0.3,
                                                pointRadius: 0,
                                                borderDash: [4, 4],
                                            },
                                        ],
                                    }}
                                    options={{
                                        responsive: true,
                                        interaction: { mode: 'index', intersect: false },
                                        plugins: {
                                            legend: { labels: { color: '#9ca3af', font: { size: 11 } } },
                                            tooltip: {
                                                backgroundColor: '#1f2937',
                                                borderColor: '#374151',
                                                borderWidth: 1,
                                                titleColor: '#f9fafb',
                                                bodyColor: '#d1d5db',
                                                callbacks: {
                                                    afterBody: (items) => {
                                                        const idx = items[0]?.dataIndex;
                                                        if (idx == null) return [];
                                                        const p = equity.points[idx];
                                                        return [
                                                            `Daily P&L: ${p.dailyPnl >= 0 ? '+' : ''}$${p.dailyPnl.toFixed(2)}`,
                                                            `Trades: ${p.trades} (${p.wins}W/${p.losses}L)`,
                                                            p.symbols ? `Symbols: ${p.symbols}` : '',
                                                        ].filter(Boolean);
                                                    },
                                                },
                                            },
                                        },
                                        scales: {
                                            x: { ticks: { color: '#6b7280', maxRotation: 45 }, grid: { color: 'rgba(255,255,255,0.04)' } },
                                            y: {
                                                ticks: { color: '#6b7280', callback: (v) => `$${Number(v).toFixed(0)}` },
                                                grid: { color: 'rgba(255,255,255,0.04)' },
                                            },
                                        },
                                    }}
                                />
                            </div>

                            {/* Daily P&L bar summary */}
                            <div className="bg-gray-800 border border-gray-700 rounded-xl p-5">
                                <h3 className="text-sm font-semibold text-gray-200 mb-3">Daily Breakdown</h3>
                                <div className="overflow-x-auto">
                                    <table className="w-full text-xs">
                                        <thead>
                                            <tr className="text-gray-400 border-b border-gray-700">
                                                <th className="text-left pb-2 pr-3">Date</th>
                                                <th className="text-right pb-2 pr-3">Trades</th>
                                                <th className="text-right pb-2 pr-3">W/L</th>
                                                <th className="text-right pb-2 pr-3">Daily P&L</th>
                                                <th className="text-right pb-2 pr-3">Cumulative</th>
                                                <th className="text-left pb-2">Symbols</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {equity.points.map((p, i) => (
                                                <tr key={i} className="border-b border-gray-700/30 hover:bg-gray-700/20">
                                                    <td className="py-1.5 pr-3 text-gray-400">
                                                        {new Date(p.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                                    </td>
                                                    <td className="text-right pr-3 text-gray-300">{p.trades}</td>
                                                    <td className="text-right pr-3">
                                                        <span className="text-green-400">{p.wins}</span>
                                                        <span className="text-gray-600">/</span>
                                                        <span className="text-red-400">{p.losses}</span>
                                                    </td>
                                                    <td className={`text-right pr-3 font-medium ${pnlColor(p.dailyPnl)}`}>
                                                        {fmtUsd(p.dailyPnl)}
                                                    </td>
                                                    <td className={`text-right pr-3 ${pnlColor(p.cumulativePnl)}`}>
                                                        {fmtUsd(p.cumulativePnl)}
                                                    </td>
                                                    <td className="text-gray-500 max-w-[160px] truncate">{p.symbols}</td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            </div>
                        </>
                    )}
                </div>
            )}

            {/* ── Strategy Health Monitor ──────────────────────────────────────── */}
            {tab === 'health' && (
                <div className="space-y-4">
                    <p className="text-sm text-gray-400">
                        9 key metrics vs targets — green = on track, yellow = watch, red = action needed.
                        Based on the last <strong className="text-white">{days} days</strong> of closed trades.
                    </p>

                    {loadingHealth ? (
                        <div className="flex items-center justify-center h-40 text-gray-400">Computing metrics...</div>
                    ) : !health ? (
                        <div className="bg-gray-800 border border-gray-700 rounded-xl p-8 text-center text-gray-400">
                            Could not load strategy health data.
                        </div>
                    ) : (
                        <>
                            {/* Scorecard header */}
                            <div className="grid grid-cols-3 gap-3 md:grid-cols-3">
                                <div className="bg-green-900/40 border border-green-700/50 rounded-xl p-4 text-center">
                                    <p className="text-3xl font-bold text-green-400">{health.summary.passing}</p>
                                    <p className="text-xs text-green-300 mt-1">On Target</p>
                                </div>
                                <div className="bg-yellow-900/40 border border-yellow-700/50 rounded-xl p-4 text-center">
                                    <p className="text-3xl font-bold text-yellow-400">{health.summary.warning}</p>
                                    <p className="text-xs text-yellow-300 mt-1">Watch</p>
                                </div>
                                <div className="bg-red-900/40 border border-red-700/50 rounded-xl p-4 text-center">
                                    <p className="text-3xl font-bold text-red-400">{health.summary.failing}</p>
                                    <p className="text-xs text-red-300 mt-1">Action Needed</p>
                                </div>
                            </div>

                            {/* Metrics table */}
                            <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                                <table className="w-full text-sm">
                                    <thead className="bg-gray-900/60">
                                        <tr className="text-gray-400 text-xs">
                                            <th className="text-left px-4 py-3 w-8"></th>
                                            <th className="text-left px-4 py-3">Metric</th>
                                            <th className="text-right px-4 py-3">Current</th>
                                            <th className="text-right px-4 py-3">Target</th>
                                            <th className="text-left px-4 py-3 hidden md:table-cell">Description</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {health.metrics.map((m) => {
                                            const dot = m.status === 'green'  ? 'bg-green-400'
                                                : m.status === 'yellow' ? 'bg-yellow-400'
                                                : m.status === 'red'    ? 'bg-red-400'
                                                : 'bg-gray-600';
                                            const valColor = m.status === 'green'  ? 'text-green-400 font-semibold'
                                                : m.status === 'yellow' ? 'text-yellow-400 font-semibold'
                                                : m.status === 'red'    ? 'text-red-400 font-semibold'
                                                : 'text-gray-500';
                                            const fmt = (v: number) => {
                                                if (m.unit === '%')      return `${v}%`;
                                                if (m.unit === 'x')      return `${v}x`;
                                                if (m.unit === 'h')      return `${v}h`;
                                                if (m.unit === 'trades') return `${v} trades`;
                                                return String(v);
                                            };
                                            const displayVal = m.current == null
                                                ? <span className="text-gray-600 text-xs italic">No data yet</span>
                                                : <span className={valColor}>{fmt(m.current)}</span>;
                                            return (
                                                <tr key={m.key} className="border-t border-gray-700/40 hover:bg-gray-700/20">
                                                    <td className="px-4 py-3">
                                                        <span className={`inline-block w-2.5 h-2.5 rounded-full ${dot}`} />
                                                    </td>
                                                    <td className="px-4 py-3">
                                                        <span className="font-medium text-white">{m.label}</span>
                                                        {m.note && m.status === 'na' && (
                                                            <p className="text-[10px] text-gray-600 mt-0.5">{m.note}</p>
                                                        )}
                                                    </td>
                                                    <td className="px-4 py-3 text-right">{displayVal}</td>
                                                    <td className="px-4 py-3 text-right text-gray-400 text-xs">{m.target}</td>
                                                    <td className="px-4 py-3 text-gray-500 text-xs hidden md:table-cell max-w-xs">{m.desc}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>

                            {health.total < 20 && (
                                <div className="bg-yellow-900/30 border border-yellow-700/40 rounded-xl p-4 text-sm text-yellow-300">
                                    ⚠ Only {health.total} closed trades in the last {days} days — metrics will stabilise with more data.
                                    ChatGPT recommends 100+ trades for reliable signal.
                                </div>
                            )}
                        </>
                    )}
                </div>
            )}
        </div>
    );
}
