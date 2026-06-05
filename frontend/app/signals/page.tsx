'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { getApiBaseUrl } from '../config';

interface Ticker {
    symbol: string;
    aiScore: number;
    recommendation: 'STRONG BUY' | 'BUY';
    sector: string;
    setupFamily: string;
    passedPrescreen: boolean;
    scanDate: string;
}

interface Summary {
    total: number;
    strongBuy: number;
    buy: number;
    topScore: number | null;
    avgScore: number | null;
}

interface SignalsData {
    scanDate: string | null;
    regime: string | null;
    summary: Summary;
    tickers: Ticker[];
}

interface DateEntry {
    date: string;
    strongBuy: number;
    buy: number;
}

const SETUP_LABELS: Record<string, { label: string; emoji: string; order: number }> = {
    breakout_leader:     { label: 'Breakout Leaders',     emoji: '🚀', order: 1 },
    quality_continuation:{ label: 'Quality Continuation', emoji: '💎', order: 2 },
    oversold_reversal:   { label: 'Oversold Reversal',    emoji: '🔄', order: 3 },
};

function scoreColor(score: number) {
    if (score >= 90) return 'text-emerald-600 dark:text-emerald-400';
    if (score >= 80) return 'text-green-600 dark:text-green-400';
    if (score >= 70) return 'text-yellow-600 dark:text-yellow-400';
    return 'text-gray-600 dark:text-gray-400';
}

function scoreBg(score: number) {
    if (score >= 90) return 'bg-emerald-100 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-700';
    if (score >= 80) return 'bg-green-100 dark:bg-green-900/30 border-green-200 dark:border-green-700';
    if (score >= 70) return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-700';
    return 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700';
}

function regimeColor(regime: string | null) {
    if (!regime) return 'text-gray-500';
    if (regime.includes('BULL')) return 'text-green-600';
    if (regime.includes('BEAR')) return 'text-red-600';
    return 'text-yellow-600';
}

function formatDate(dateStr: string | null) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export default function SignalsPage() {
    const router = useRouter();
    const [data, setData] = useState<SignalsData | null>(null);
    const [dates, setDates] = useState<DateEntry[]>([]);
    const [selectedDate, setSelectedDate] = useState<string>('');
    const [filter, setFilter] = useState<'ALL' | 'STRONG BUY' | 'BUY'>('ALL');
    const [loading, setLoading] = useState(true);
    const [copied, setCopied] = useState(false);

    const token = typeof window !== 'undefined' ? getAuthToken() : null;
    const base  = getApiBaseUrl();
    const hdrs  = { Authorization: `Bearer ${token}` };

    // Load available dates
    useEffect(() => {
        if (!token) { router.push('/login'); return; }
        fetch(`${base}/api/daily-signals/dates`, { headers: hdrs })
            .then(r => { if (r.status === 401) { handleAuthError(401); } return r.ok ? r.json() : []; })
            .then(setDates)
            .catch(() => {});
    }, [token]);

    // Load signals for selected date (or latest)
    const load = useCallback(async (date?: string) => {
        if (!token) return;
        setLoading(true);
        try {
            const url = date
                ? `${base}/api/daily-signals?date=${date}`
                : `${base}/api/daily-signals`;
            const r = await fetch(url, { headers: hdrs });
            if (r.status === 401) { handleAuthError(401); return; }
            if (r.ok) setData(await r.json());
        } catch { /* no-op */ } finally {
            setLoading(false);
        }
    }, [token]);

    useEffect(() => { load(selectedDate || undefined); }, [load, selectedDate]);

    // Copy tickers to clipboard
    const copyTickers = () => {
        if (!data) return;
        const visible = filtered(data.tickers);
        const text = visible.map(t => t.symbol).join(', ');
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const filtered = (tickers: Ticker[]) =>
        filter === 'ALL' ? tickers : tickers.filter(t => t.recommendation === filter);

    // Group by setup family
    const grouped = (tickers: Ticker[]) => {
        const groups: Record<string, Ticker[]> = {};
        for (const t of tickers) {
            const key = t.setupFamily || 'other';
            (groups[key] = groups[key] || []).push(t);
        }
        return Object.entries(groups).sort(([a], [b]) => {
            const oa = SETUP_LABELS[a]?.order ?? 99;
            const ob = SETUP_LABELS[b]?.order ?? 99;
            return oa - ob;
        });
    };

    const visibleTickers = data ? filtered(data.tickers) : [];

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
            <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">

                {/* Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                            ⭐ Daily Signals
                        </h1>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                            PANTHEON overnight scan — pre-market stock picks
                        </p>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                        {/* Date picker */}
                        <select
                            value={selectedDate}
                            onChange={e => setSelectedDate(e.target.value)}
                            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                        >
                            <option value="">Latest</option>
                            {dates.map(d => (
                                <option key={d.date} value={d.date}>
                                    {new Date(d.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — {d.strongBuy} strong
                                </option>
                            ))}
                        </select>
                        {/* Copy button */}
                        <button
                            onClick={copyTickers}
                            disabled={!visibleTickers.length}
                            className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white transition-colors"
                        >
                            {copied ? '✓ Copied!' : '📋 Copy Tickers'}
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center h-48">
                        <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
                    </div>
                ) : !data || !data.scanDate ? (
                    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center">
                        <div className="text-4xl mb-3">🔭</div>
                        <p className="text-gray-500 dark:text-gray-400">No scan data available yet. The nightly scan runs after market close (~5 PM ET).</p>
                    </div>
                ) : (
                    <>
                        {/* Scan date + regime */}
                        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div>
                                <div className="text-xs text-gray-500 uppercase tracking-wide font-semibold">Scan Date</div>
                                <div className="text-base font-semibold text-gray-900 dark:text-white mt-0.5">
                                    {formatDate(data.scanDate)}
                                </div>
                            </div>
                            {data.regime && (
                                <div className="text-right">
                                    <div className="text-xs text-gray-500 uppercase tracking-wide font-semibold">Market Regime</div>
                                    <div className={`text-lg font-bold mt-0.5 ${regimeColor(data.regime)}`}>
                                        {data.regime.replace('_', ' ')}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Summary cards */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                            {[
                                { label: 'STRONG BUY', value: data.summary.strongBuy, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
                                { label: 'BUY', value: data.summary.buy, color: 'text-green-600 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-900/20' },
                                { label: 'Top Score', value: data.summary.topScore ? data.summary.topScore.toFixed(0) : '—', color: 'text-indigo-600 dark:text-indigo-400', bg: 'bg-indigo-50 dark:bg-indigo-900/20' },
                                { label: 'Avg Score', value: data.summary.avgScore ? data.summary.avgScore.toFixed(1) : '—', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20' },
                            ].map(c => (
                                <div key={c.label} className={`${c.bg} rounded-xl border border-gray-200 dark:border-gray-700 p-4`}>
                                    <div className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{c.label}</div>
                                    <div className={`text-3xl font-bold mt-1 ${c.color}`}>{c.value}</div>
                                </div>
                            ))}
                        </div>

                        {/* Filter tabs */}
                        <div className="flex items-center gap-2">
                            {(['ALL', 'STRONG BUY', 'BUY'] as const).map(f => (
                                <button
                                    key={f}
                                    onClick={() => setFilter(f)}
                                    className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                                        filter === f
                                            ? 'bg-indigo-600 text-white'
                                            : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
                                    }`}
                                >
                                    {f === 'ALL' ? `All (${data.summary.total})` : f === 'STRONG BUY' ? `⭐ Strong Buy (${data.summary.strongBuy})` : `📈 Buy (${data.summary.buy})`}
                                </button>
                            ))}
                            <span className="ml-auto text-xs text-gray-400">{visibleTickers.length} showing</span>
                        </div>

                        {/* Grouped ticker cards */}
                        {grouped(visibleTickers).map(([setupKey, tickers]) => {
                            const setup = SETUP_LABELS[setupKey] || { label: setupKey.replace(/_/g, ' '), emoji: '📌', order: 99 };
                            return (
                                <div key={setupKey}>
                                    <div className="flex items-center gap-2 mb-3">
                                        <span className="text-xl">{setup.emoji}</span>
                                        <h2 className="text-base font-bold text-gray-800 dark:text-gray-200">{setup.label}</h2>
                                        <span className="text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full px-2 py-0.5">{tickers.length}</span>
                                    </div>
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                                        {tickers.map(t => (
                                            <div
                                                key={t.symbol}
                                                className={`rounded-xl border p-4 flex flex-col gap-1 cursor-default ${scoreBg(t.aiScore)}`}
                                            >
                                                {/* Symbol + rec badge */}
                                                <div className="flex items-start justify-between gap-1">
                                                    <span className="text-lg font-bold text-gray-900 dark:text-white tracking-wide">
                                                        {t.symbol}
                                                    </span>
                                                    {t.recommendation === 'STRONG BUY' && (
                                                        <span className="text-[10px] font-bold bg-emerald-500 text-white rounded px-1.5 py-0.5 shrink-0">SB</span>
                                                    )}
                                                </div>
                                                {/* Score */}
                                                <div className={`text-2xl font-bold ${scoreColor(t.aiScore)}`}>
                                                    {t.aiScore.toFixed(0)}
                                                </div>
                                                {/* Sector */}
                                                <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-tight truncate" title={t.sector}>
                                                    {t.sector}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}

                        {visibleTickers.length === 0 && (
                            <div className="text-center py-12 text-gray-400">No tickers match this filter.</div>
                        )}

                        {/* Share text */}
                        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Share List</span>
                                <button
                                    onClick={copyTickers}
                                    className="text-xs px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg"
                                >
                                    {copied ? '✓ Copied' : 'Copy'}
                                </button>
                            </div>
                            <div className="text-sm text-gray-600 dark:text-gray-400 font-mono bg-gray-50 dark:bg-gray-800 rounded-lg p-3 leading-relaxed break-all">
                                {visibleTickers.length > 0
                                    ? visibleTickers.map(t => t.symbol).join(', ')
                                    : 'No tickers to display'}
                            </div>
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}
