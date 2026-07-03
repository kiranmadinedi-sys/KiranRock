'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { getApiBaseUrl } from '../config';

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

type Tab = 'trades' | 'score' | 'hold';
type SortKey = 'closedAt' | 'symbol' | 'pnlPct' | 'aiScore' | 'holdHours';
type SortDir = 'asc' | 'desc';

export default function AnalyticsPage() {
    const router = useRouter();

    const [tab, setTab] = useState<Tab>('trades');
    const [days, setDays] = useState(90);

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

    useEffect(() => {
        const token = getAuthToken();
        if (!token) { router.push('/login'); return; }
        fetchTradeLog(token);
        fetchBuckets(token);
    }, [fetchTradeLog, fetchBuckets, router]);

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
        { id: 'score',  label: 'Score Analysis' },
        { id: 'hold',   label: 'Hold Time' },
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
        </div>
    );
}
