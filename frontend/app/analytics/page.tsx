'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { getApiBaseUrl } from '../config';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Trade {
    id: number;
    symbol: string;
    score: number | null;
    confidence: number | null;
    regime: string | null;
    setupFamily: string | null;
    outcome: string | null;
    entryPrice: number | null;
    exitPrice: number | null;
    pnl: number | null;
    pnlPct: number | null;
    openedAt: string | null;
    closedAt: string | null;
    holdDays: number | null;
    sector: string | null;
    exitReason: string | null;
    winLossReason: string | null;
    atrPct: number | null;
    postExitDrift5d: number | null;
    postExitDrift10d: number | null;
}

interface AggRow {
    bucket: string;
    total: number;
    wins: number;
    winRate: number;
    avgReturn: number;
    totalPnl: number;
    avgWin?: number;
    avgLoss?: number;
    avgWinPct?: number;
    avgLossPct?: number;
    expectancyPct?: number;
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
    minScore: number;
    maxScore: number;
    avgScore: number;
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
    minHours: number;
    maxHours: number;
    avgHours: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = (n: number | null, decimals = 2) =>
    n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

const fmtPct = (n: number | null) => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;
const fmtUsd = (n: number | null) => n == null ? '—' : `${n >= 0 ? '+$' : '-$'}${Math.abs(n).toFixed(2)}`;

function pnlColor(v: number | null) {
    if (v == null) return 'text-gray-400';
    return v > 0 ? 'text-green-400' : v < 0 ? 'text-red-400' : 'text-gray-400';
}

function driftColor(v: number | null) {
    if (v == null) return 'text-gray-500';
    return v > 2 ? 'text-red-400' : v < -2 ? 'text-green-400' : 'text-gray-400';
}

function scoreColor(s: number | null) {
    if (s == null) return 'text-gray-400';
    if (s >= 95) return 'text-purple-400';
    if (s >= 90) return 'text-blue-400';
    return 'text-gray-300';
}

function regimeBadge(r: string | null) {
    if (!r) return null;
    const colors: Record<string, string> = {
        BULL_STRONG: 'bg-green-900 text-green-300',
        BULL_MILD:   'bg-emerald-900 text-emerald-300',
        NEUTRAL:     'bg-gray-700 text-gray-300',
        CHOPPY:      'bg-yellow-900 text-yellow-300',
        BEAR:        'bg-red-900 text-red-300',
        PANIC:       'bg-pink-900 text-pink-200',
    };
    return (
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${colors[r] || 'bg-gray-700 text-gray-300'}`}>
            {r.replace('_', ' ')}
        </span>
    );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
    return (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
            <p className="text-xs text-gray-400 mb-1">{label}</p>
            <p className={`text-2xl font-bold ${color || 'text-white'}`}>{value}</p>
            {sub && <p className="text-xs text-gray-500 mt-0.5">{sub}</p>}
        </div>
    );
}

function BucketTable({ title, rows, valueKey, valueLabel }: {
    title: string;
    rows: AggRow[];
    valueKey: keyof AggRow;
    valueLabel: string;
}) {
    if (!rows.length) return null;
    return (
        <div className="bg-gray-800 border border-gray-700 rounded-xl p-4">
            <h3 className="text-sm font-semibold text-gray-200 mb-3">{title}</h3>
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead>
                        <tr className="text-gray-400 border-b border-gray-700">
                            <th className="text-left pb-2 pr-3">{valueLabel}</th>
                            <th className="text-right pb-2 pr-3">Trades</th>
                            <th className="text-right pb-2 pr-3">Win %</th>
                            <th className="text-right pb-2 pr-3">Avg Return</th>
                            <th className="text-right pb-2">Net P&L</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r, i) => (
                            <tr key={i} className="border-b border-gray-700/50 hover:bg-gray-700/30">
                                <td className="py-2 pr-3 font-medium text-white">{String(r[valueKey])}</td>
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
        </div>
    );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

type Tab = 'trades' | 'score' | 'hold' | 'drift';
type SortKey = 'closedAt' | 'symbol' | 'pnlPct' | 'score' | 'holdDays';
type SortDir = 'asc' | 'desc';

export default function AnalyticsPage() {
    const router = useRouter();

    const [tab, setTab] = useState<Tab>('trades');
    const [days, setDays] = useState(90);
    const [trades, setTrades] = useState<Trade[]>([]);
    const [aggByScore, setAggByScore] = useState<AggRow[]>([]);
    const [aggByHold, setAggByHold] = useState<AggRow[]>([]);
    const [aggByExit, setAggByExit] = useState<AggRow[]>([]);
    const [aggByRegime, setAggByRegime] = useState<AggRow[]>([]);
    const [aggBySector, setAggBySector] = useState<AggRow[]>([]);
    const [scoreBuckets, setScoreBuckets] = useState<ScoreBucket[]>([]);
    const [holdBuckets, setHoldBuckets] = useState<HoldBucket[]>([]);
    const [driftSummary, setDriftSummary] = useState<{ avgDrift5d: number | null; avgDrift10d: number | null; tradesWithDriftData: number } | null>(null);
    const [loading, setLoading] = useState(false);
    const [loadingBuckets, setLoadingBuckets] = useState(false);

    // Filters
    const [filterOutcome, setFilterOutcome] = useState('');
    const [filterSector, setSectorFilter] = useState('');
    const [filterRegime, setFilterRegime] = useState('');
    const [filterExit, setFilterExit] = useState('');
    const [filterMinScore, setFilterMinScore] = useState('');
    const [filterMaxScore, setFilterMaxScore] = useState('');

    // Sort
    const [sortKey, setSortKey] = useState<SortKey>('closedAt');
    const [sortDir, setSortDir] = useState<SortDir>('desc');

    const fetchAttribution = useCallback(async (token: string) => {
        setLoading(true);
        try {
            const params = new URLSearchParams({ days: String(days) });
            const res = await fetch(`${getApiBaseUrl()}/api/performance/trade-attribution?${params}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) { handleAuthError(res.status); return; }
            const data = await res.json();
            setTrades(data.trades || []);
            setAggByScore(data.byScore || []);
            setAggByHold(data.byHold || []);
            setAggByExit(data.byExit || []);
            setAggByRegime(data.byRegime || []);
            setAggBySector(data.bySector || []);
            setDriftSummary(data.postExitSummary || null);
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

    useEffect(() => {
        const token = getAuthToken();
        if (!token) { router.push('/login'); return; }
        fetchAttribution(token);
        fetchBuckets(token);
    }, [fetchAttribution, fetchBuckets, router]);

    // Derived filter options
    const sectors  = Array.from(new Set(trades.map(t => t.sector).filter(Boolean))).sort();
    const regimes  = Array.from(new Set(trades.map(t => t.regime).filter(Boolean))).sort();
    const exits    = Array.from(new Set(trades.map(t => t.exitReason).filter(Boolean))).sort();

    // Apply filters
    const filtered = trades.filter(t => {
        if (filterOutcome) {
            if (filterOutcome === 'win' && (t.pnl == null || t.pnl <= 0)) return false;
            if (filterOutcome === 'loss' && (t.pnl == null || t.pnl >= 0)) return false;
        }
        if (filterSector  && t.sector    !== filterSector)  return false;
        if (filterRegime  && t.regime    !== filterRegime)  return false;
        if (filterExit    && t.exitReason !== filterExit)   return false;
        if (filterMinScore && (t.score == null || t.score < parseFloat(filterMinScore))) return false;
        if (filterMaxScore && (t.score == null || t.score > parseFloat(filterMaxScore))) return false;
        return true;
    });

    // Sort
    const sorted = [...filtered].sort((a, b) => {
        let av: number | string | null = null;
        let bv: number | string | null = null;
        if (sortKey === 'closedAt') { av = a.closedAt; bv = b.closedAt; }
        else if (sortKey === 'symbol') { av = a.symbol; bv = b.symbol; }
        else if (sortKey === 'pnlPct') { av = a.pnlPct; bv = b.pnlPct; }
        else if (sortKey === 'score') { av = a.score; bv = b.score; }
        else if (sortKey === 'holdDays') { av = a.holdDays; bv = b.holdDays; }
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return sortDir === 'asc' ? -1 : 1;
        if (av > bv) return sortDir === 'asc' ? 1 : -1;
        return 0;
    });

    // Summary stats from filtered set
    const totalTrades = filtered.length;
    const wins   = filtered.filter(t => t.pnl != null && t.pnl > 0).length;
    const netPnl  = filtered.reduce((s, t) => s + (t.pnl || 0), 0);
    const avgRet  = totalTrades > 0
        ? filtered.reduce((s, t) => s + (t.pnlPct || 0), 0) / totalTrades : 0;
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    function toggleSort(key: SortKey) {
        if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        else { setSortKey(key); setSortDir('desc'); }
    }

    function SortBtn({ k, label }: { k: SortKey; label: string }) {
        return (
            <button onClick={() => toggleSort(k)} className="flex items-center gap-1 hover:text-white transition-colors">
                {label}
                {sortKey === k && <span className="text-blue-400">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            </button>
        );
    }

    // ── Render ─────────────────────────────────────────────────────────────────

    const TABS: { id: Tab; label: string }[] = [
        { id: 'trades', label: 'Trade Log' },
        { id: 'score',  label: 'Score Analysis' },
        { id: 'hold',   label: 'Hold Time' },
        { id: 'drift',  label: 'Post-Exit Drift' },
    ];

    return (
        <div className="min-h-screen bg-gray-900 text-white p-4 md:p-6">
            {/* Header */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
                <div>
                    <h1 className="text-2xl font-bold text-white">Trade Review</h1>
                    <p className="text-sm text-gray-400 mt-0.5">Analyze every closed trade — filter, sort, and find patterns</p>
                </div>
                <div className="flex items-center gap-2">
                    {(['30','90','180','365'] as const).map(d => (
                        <button
                            key={d}
                            onClick={() => setDays(parseInt(d))}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                                days === parseInt(d)
                                    ? 'bg-blue-600 text-white'
                                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                            }`}
                        >{d}d</button>
                    ))}
                </div>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                <StatCard label="Filtered Trades" value={String(totalTrades)} sub={`${wins}W / ${totalTrades - wins}L`} />
                <StatCard
                    label="Win Rate"
                    value={`${winRate.toFixed(0)}%`}
                    color={winRate >= 55 ? 'text-green-400' : winRate >= 45 ? 'text-yellow-400' : 'text-red-400'}
                />
                <StatCard
                    label="Net P&L"
                    value={fmtUsd(netPnl)}
                    color={pnlColor(netPnl)}
                />
                <StatCard
                    label="Avg Return"
                    value={fmtPct(avgRet)}
                    color={pnlColor(avgRet)}
                />
            </div>

            {/* Tabs */}
            <div className="flex gap-1 mb-4 bg-gray-800 rounded-xl p-1 w-fit">
                {TABS.map(t => (
                    <button
                        key={t.id}
                        onClick={() => setTab(t.id)}
                        className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                            tab === t.id ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
                        }`}
                    >{t.label}</button>
                ))}
            </div>

            {/* ── Trade Log Tab ──────────────────────────────────────────────── */}
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

                            <select value={filterSector} onChange={e => setSectorFilter(e.target.value)}
                                className="bg-gray-700 text-sm text-gray-200 border border-gray-600 rounded-lg px-2 py-1.5">
                                <option value="">All sectors</option>
                                {sectors.map(s => <option key={s!} value={s!}>{s}</option>)}
                            </select>

                            <select value={filterRegime} onChange={e => setFilterRegime(e.target.value)}
                                className="bg-gray-700 text-sm text-gray-200 border border-gray-600 rounded-lg px-2 py-1.5">
                                <option value="">All regimes</option>
                                {regimes.map(r => <option key={r!} value={r!}>{r}</option>)}
                            </select>

                            <select value={filterExit} onChange={e => setFilterExit(e.target.value)}
                                className="bg-gray-700 text-sm text-gray-200 border border-gray-600 rounded-lg px-2 py-1.5">
                                <option value="">All exit types</option>
                                {exits.map(x => <option key={x!} value={x!}>{x}</option>)}
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
                                <button onClick={() => { setFilterOutcome(''); setSectorFilter(''); setFilterRegime(''); setFilterExit(''); setFilterMinScore(''); setFilterMaxScore(''); }}
                                    className="text-xs text-red-400 hover:text-red-300 underline">
                                    Clear all
                                </button>
                            )}

                            <span className="ml-auto text-xs text-gray-500">{sorted.length} of {trades.length} trades</span>
                        </div>
                    </div>

                    {/* Trade Table */}
                    <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                        {loading ? (
                            <div className="flex items-center justify-center h-40 text-gray-400">Loading trades...</div>
                        ) : sorted.length === 0 ? (
                            <div className="flex items-center justify-center h-40 text-gray-400">No trades match the current filters</div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                    <thead className="bg-gray-900/50">
                                        <tr className="text-gray-400">
                                            <th className="text-left px-3 py-3"><SortBtn k="closedAt" label="Date" /></th>
                                            <th className="text-left px-3 py-3"><SortBtn k="symbol" label="Symbol" /></th>
                                            <th className="text-right px-3 py-3"><SortBtn k="score" label="Score" /></th>
                                            <th className="text-left px-3 py-3">Regime</th>
                                            <th className="text-left px-3 py-3">Sector</th>
                                            <th className="text-left px-3 py-3">Exit</th>
                                            <th className="text-right px-3 py-3"><SortBtn k="pnlPct" label="Return" /></th>
                                            <th className="text-right px-3 py-3">P&L</th>
                                            <th className="text-right px-3 py-3"><SortBtn k="holdDays" label="Hold" /></th>
                                            <th className="text-right px-3 py-3">Drift 5d</th>
                                            <th className="text-right px-3 py-3">Drift 10d</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {sorted.map(t => (
                                            <tr key={t.id} className="border-t border-gray-700/50 hover:bg-gray-700/20 transition-colors">
                                                <td className="px-3 py-2.5 text-gray-400 whitespace-nowrap">
                                                    {t.closedAt ? new Date(t.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}
                                                </td>
                                                <td className="px-3 py-2.5 font-bold text-white">{t.symbol}</td>
                                                <td className={`px-3 py-2.5 text-right font-semibold ${scoreColor(t.score)}`}>
                                                    {t.score != null ? t.score.toFixed(0) : '—'}
                                                </td>
                                                <td className="px-3 py-2.5">{regimeBadge(t.regime)}</td>
                                                <td className="px-3 py-2.5 text-gray-400 max-w-[100px] truncate">{t.sector || '—'}</td>
                                                <td className="px-3 py-2.5 text-gray-300 max-w-[100px] truncate capitalize">
                                                    {t.exitReason?.replace(/_/g, ' ') || '—'}
                                                </td>
                                                <td className={`px-3 py-2.5 text-right font-semibold ${pnlColor(t.pnlPct)}`}>
                                                    {fmtPct(t.pnlPct)}
                                                </td>
                                                <td className={`px-3 py-2.5 text-right ${pnlColor(t.pnl)}`}>
                                                    {fmtUsd(t.pnl)}
                                                </td>
                                                <td className="px-3 py-2.5 text-right text-gray-400">
                                                    {t.holdDays != null ? `${t.holdDays}d` : '—'}
                                                </td>
                                                <td className={`px-3 py-2.5 text-right ${driftColor(t.postExitDrift5d)}`}>
                                                    {t.postExitDrift5d != null ? fmtPct(t.postExitDrift5d) : '—'}
                                                </td>
                                                <td className={`px-3 py-2.5 text-right ${driftColor(t.postExitDrift10d)}`}>
                                                    {t.postExitDrift10d != null ? fmtPct(t.postExitDrift10d) : '—'}
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
                        <BucketTable title="By Sector" rows={aggBySector} valueKey="bucket" valueLabel="Sector" />
                        <BucketTable title="By Regime" rows={aggByRegime} valueKey="bucket" valueLabel="Regime" />
                        <BucketTable title="By Exit Type" rows={aggByExit} valueKey="bucket" valueLabel="Exit" />
                        <BucketTable title="By Hold Period" rows={aggByHold} valueKey="bucket" valueLabel="Hold" />
                    </div>
                </div>
            )}

            {/* ── Score Analysis Tab ─────────────────────────────────────────── */}
            {tab === 'score' && (
                <div className="space-y-4">
                    <p className="text-sm text-gray-400">
                        Win rate and expectancy per AI score bucket — uses SELL records from the <code className="text-blue-400">trades</code> table.
                        Buckets are tuned to your bot's threshold range (base minBuyScore = 88).
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
                                <thead className="bg-gray-900/50">
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

                    {/* From trade-attribution */}
                    {aggByScore.length > 0 && (
                        <BucketTable title="Score Breakdown (trade_decision_journal)" rows={aggByScore} valueKey="bucket" valueLabel="Score Range" />
                    )}
                </div>
            )}

            {/* ── Hold Time Tab ──────────────────────────────────────────────── */}
            {tab === 'hold' && (
                <div className="space-y-4">
                    <p className="text-sm text-gray-400">
                        Performance broken down by how long positions were held.
                        Uses the <code className="text-blue-400">hold_hours</code> column on SELL records.
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
                                <thead className="bg-gray-900/50">
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
                        <BucketTable title="Hold Period Breakdown (trade_decision_journal)" rows={aggByHold} valueKey="bucket" valueLabel="Period" />
                    )}
                </div>
            )}

            {/* ── Post-Exit Drift Tab ────────────────────────────────────────── */}
            {tab === 'drift' && (
                <div className="space-y-4">
                    <p className="text-sm text-gray-400">
                        "Missed Winners" analysis — tracks how much the stock moved after you sold.
                        Positive drift means the stock kept rising (exits may be too early).
                        Negative drift means the stock fell (exits were well-timed).
                    </p>

                    {/* Summary cards */}
                    {driftSummary && (
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <StatCard
                                label="Avg Post-Exit Drift (5 days)"
                                value={driftSummary.avgDrift5d != null ? fmtPct(driftSummary.avgDrift5d) : 'No data'}
                                color={driftColor(driftSummary.avgDrift5d)}
                                sub={driftSummary.avgDrift5d != null && driftSummary.avgDrift5d > 2
                                    ? 'Exits may be too early'
                                    : driftSummary.avgDrift5d != null && driftSummary.avgDrift5d < -2
                                    ? 'Exit timing looks good'
                                    : 'Exit timing is neutral'}
                            />
                            <StatCard
                                label="Avg Post-Exit Drift (10 days)"
                                value={driftSummary.avgDrift10d != null ? fmtPct(driftSummary.avgDrift10d) : 'No data'}
                                color={driftColor(driftSummary.avgDrift10d)}
                                sub="10-day move after exit"
                            />
                            <StatCard
                                label="Trades with drift data"
                                value={String(driftSummary.tradesWithDriftData)}
                                sub="Need daily_bars price coverage"
                            />
                        </div>
                    )}

                    {/* Drift by exit type */}
                    {aggByExit.length > 0 && (
                        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                            <div className="px-4 py-3 border-b border-gray-700">
                                <h3 className="text-sm font-semibold text-gray-200">Post-Exit Drift by Exit Type</h3>
                                <p className="text-xs text-gray-500 mt-0.5">
                                    Positive avg drift = stock rose after this exit type (reconsider). Negative = exit was well-timed.
                                </p>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead className="bg-gray-900/50">
                                        <tr className="text-gray-400 text-xs">
                                            <th className="text-left px-4 py-3">Exit Type</th>
                                            <th className="text-right px-4 py-3">Trades</th>
                                            <th className="text-right px-4 py-3">Win Rate</th>
                                            <th className="text-right px-4 py-3">Avg Return</th>
                                            <th className="text-right px-4 py-3">Avg Drift 5d</th>
                                            <th className="text-right px-4 py-3">Avg Drift 10d</th>
                                            <th className="text-right px-4 py-3">Verdict</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {aggByExit.map((r: any, i: number) => {
                                            const drift5 = r.avgDrift5d != null ? parseFloat(r.avgDrift5d) : null;
                                            const verdict = drift5 == null ? '—'
                                                : drift5 > 3 ? '⚠️ Too early'
                                                : drift5 < -3 ? '✅ Well-timed'
                                                : '↔️ Neutral';
                                            return (
                                                <tr key={i} className="border-t border-gray-700/50 hover:bg-gray-700/20">
                                                    <td className="px-4 py-3 font-medium text-white capitalize">{String(r.bucket).replace(/_/g, ' ')}</td>
                                                    <td className="px-4 py-3 text-right text-gray-300">{r.total}</td>
                                                    <td className={`px-4 py-3 text-right ${r.winRate >= 55 ? 'text-green-400' : r.winRate >= 45 ? 'text-yellow-400' : 'text-red-400'}`}>
                                                        {r.winRate.toFixed(0)}%
                                                    </td>
                                                    <td className={`px-4 py-3 text-right ${pnlColor(r.avgReturn)}`}>{fmtPct(r.avgReturn)}</td>
                                                    <td className={`px-4 py-3 text-right ${driftColor(drift5)}`}>
                                                        {drift5 != null ? fmtPct(drift5) : '—'}
                                                    </td>
                                                    <td className={`px-4 py-3 text-right ${driftColor(r.avgDrift10d != null ? parseFloat(r.avgDrift10d) : null)}`}>
                                                        {r.avgDrift10d != null ? fmtPct(parseFloat(r.avgDrift10d)) : '—'}
                                                    </td>
                                                    <td className="px-4 py-3 text-right text-xs">{verdict}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {/* Per-trade drift table — top 20 worst "early exits" */}
                    {sorted.filter(t => t.postExitDrift5d != null && t.postExitDrift5d > 0).length > 0 && (
                        <div className="bg-gray-800 border border-gray-700 rounded-xl overflow-hidden">
                            <div className="px-4 py-3 border-b border-gray-700">
                                <h3 className="text-sm font-semibold text-gray-200">Biggest Missed Moves (sold, then stock rose)</h3>
                                <p className="text-xs text-gray-500 mt-0.5">Trades where stock rose most in the 5 days after you sold</p>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                    <thead className="bg-gray-900/50">
                                        <tr className="text-gray-400">
                                            <th className="text-left px-3 py-2">Date</th>
                                            <th className="text-left px-3 py-2">Symbol</th>
                                            <th className="text-right px-3 py-2">Exit Return</th>
                                            <th className="text-right px-3 py-2">Exit Reason</th>
                                            <th className="text-right px-3 py-2">+5d Drift</th>
                                            <th className="text-right px-3 py-2">+10d Drift</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {[...trades]
                                            .filter(t => t.postExitDrift5d != null && t.postExitDrift5d > 0)
                                            .sort((a, b) => (b.postExitDrift5d || 0) - (a.postExitDrift5d || 0))
                                            .slice(0, 20)
                                            .map(t => (
                                                <tr key={t.id} className="border-t border-gray-700/50 hover:bg-gray-700/20">
                                                    <td className="px-3 py-2 text-gray-400">{t.closedAt ? new Date(t.closedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</td>
                                                    <td className="px-3 py-2 font-bold text-white">{t.symbol}</td>
                                                    <td className={`px-3 py-2 text-right ${pnlColor(t.pnlPct)}`}>{fmtPct(t.pnlPct)}</td>
                                                    <td className="px-3 py-2 text-right text-gray-400 capitalize">{t.exitReason?.replace(/_/g, ' ') || '—'}</td>
                                                    <td className="px-3 py-2 text-right text-red-400 font-semibold">{fmtPct(t.postExitDrift5d)}</td>
                                                    <td className={`px-3 py-2 text-right ${driftColor(t.postExitDrift10d)}`}>{t.postExitDrift10d != null ? fmtPct(t.postExitDrift10d) : '—'}</td>
                                                </tr>
                                            ))
                                        }
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
