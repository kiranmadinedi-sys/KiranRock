'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthToken } from '../utils/auth';
import { getApiBaseUrl } from '../config';

// ── Types ──────────────────────────────────────────────────────────────────────

interface ScanSummary {
    total_analyzed: number;
    passed: number;
    filtered: number;
    avg_score: number;
    max_score: number;
}

interface ExclusionRow {
    category: string;
    count: number;
}

interface ScanSummaryResponse {
    summary: ScanSummary | null;
    exclusions: ExclusionRow[];
    newTickers: string[];
}

interface SymbolRecord {
    symbol: string;
    analysis_date: string;
    ai_score: number | null;
    recommendation: string | null;
    setup_family: string | null;
    sector: string | null;
    market_cap: number | null;
    passed_prescreen: boolean;
    exclusion_reason: string | null;
    updated_at: string;
}

interface DriftReport {
    lookbackDays: number;
    prescreenCount: number;
    tradedCount: number;
    conversionRate: number;
    avgPnl: number;
    winRate: number;
}

type Tab = 'summary' | 'lookup' | 'drift' | 'controls';

const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'summary',  label: 'Scan Summary',   icon: '🔭' },
    { id: 'lookup',   label: 'Symbol Lookup',  icon: '🔍' },
    { id: 'drift',    label: 'Drift Report',   icon: '📊' },
    { id: 'controls', label: 'Controls',       icon: '⚙️' },
];

const EXCLUSION_LABELS: Record<string, string> = {
    score_borderline: 'Score borderline (BUY, not STRONG BUY)',
    weak_signal:      'Weak signal (HOLD / SELL)',
    analysis_null:    'Analysis returned null',
    api_rate_limit:   'API rate limit / timeout',
    error:            'Error during analysis',
    other:            'Other',
};

// ── API helpers ────────────────────────────────────────────────────────────────

function authHeaders() {
    const token = getAuthToken();
    return { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

async function apiFetch(path: string, opts: RequestInit = {}) {
    const base = getApiBaseUrl();
    const res  = await fetch(`${base}${path}`, { headers: authHeaders(), ...opts });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
    return (
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-4">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wide mb-1">{label}</p>
            <p className={`text-2xl font-bold ${color || 'text-slate-900 dark:text-white'}`}>{value}</p>
            {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
        </div>
    );
}

function Badge({ text, variant }: { text: string; variant: 'green' | 'red' | 'yellow' | 'blue' | 'gray' }) {
    const cls = {
        green:  'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
        red:    'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
        yellow: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
        blue:   'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
        gray:   'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
    }[variant];
    return <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>{text}</span>;
}

// ── Tabs ───────────────────────────────────────────────────────────────────────

function SummaryTab() {
    const [data, setData] = useState<ScanSummaryResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        apiFetch('/api/asset-universe/scan-summary')
            .then(d => setData(d))
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    if (loading) return <div className="text-center py-12 text-slate-400">Loading scan data…</div>;
    if (error)   return <div className="text-center py-12 text-red-500">Error: {error}</div>;

    const s = data?.summary;
    const hasData = s && Number(s.total_analyzed) > 0;

    return (
        <div className="space-y-6">
            {/* Stats row */}
            {hasData ? (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                    <StatCard label="Total Analyzed" value={s.total_analyzed} />
                    <StatCard label="Passed Prescreen" value={s.passed} color="text-green-600 dark:text-green-400" />
                    <StatCard label="Filtered Out" value={s.filtered} color="text-red-500 dark:text-red-400" />
                    <StatCard label="Avg AI Score" value={s.avg_score} />
                    <StatCard label="Top Score" value={s.max_score} color="text-blue-600 dark:text-blue-400" />
                </div>
            ) : (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-8 text-center text-slate-400">
                    No scan data for today yet. The nightly scan runs automatically after market close (~5 PM ET).
                </div>
            )}

            {/* Exclusion breakdown */}
            {data?.exclusions?.length ? (
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                    <div className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 font-semibold text-slate-700 dark:text-slate-200">
                        Exclusion Breakdown
                    </div>
                    <div className="divide-y divide-slate-100 dark:divide-slate-700">
                        {data.exclusions.map(row => {
                            const total = s ? Number(s.filtered) || 1 : 1;
                            const pct = ((Number(row.count) / total) * 100).toFixed(1);
                            const isHighError = (row.category === 'api_rate_limit' || row.category === 'error')
                                && Number(row.count) > (s ? Number(s.total_analyzed) * 0.10 : 999);
                            return (
                                <div key={row.category} className="flex items-center justify-between px-5 py-3">
                                    <div className="flex items-center gap-2">
                                        <span className="text-sm text-slate-700 dark:text-slate-300">
                                            {EXCLUSION_LABELS[row.category] || row.category}
                                        </span>
                                        {isHighError && <Badge text="⚠️ High rate" variant="red" />}
                                    </div>
                                    <div className="flex items-center gap-3 text-sm">
                                        <span className="text-slate-500 dark:text-slate-400">{pct}%</span>
                                        <span className="font-semibold text-slate-700 dark:text-slate-200 w-10 text-right">{row.count}</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            ) : null}

            {/* New tickers */}
            {data?.newTickers?.length ? (
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-blue-200 dark:border-blue-800/50 overflow-hidden">
                    <div className="px-5 py-3 border-b border-blue-100 dark:border-blue-800/50 font-semibold text-blue-700 dark:text-blue-300 flex items-center gap-2">
                        🆕 New Tickers in Today's Scan
                        <Badge text={String(data.newTickers.length)} variant="blue" />
                    </div>
                    <div className="px-5 py-4 flex flex-wrap gap-2">
                        {data.newTickers.map(t => (
                            <span key={t} className="px-2 py-1 rounded-md bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 text-xs font-mono font-semibold">
                                {t}
                            </span>
                        ))}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

function LookupTab() {
    const [symbol, setSymbol] = useState('');
    const [date,   setDate]   = useState('');
    const [result, setResult] = useState<{ found: boolean; record?: SymbolRecord; message?: string } | null>(null);
    const [loading, setLoading] = useState(false);
    const [error,   setError]   = useState('');

    const lookup = async () => {
        if (!symbol.trim()) return;
        setLoading(true); setError(''); setResult(null);
        try {
            const params = date ? `?date=${date}` : '';
            const d = await apiFetch(`/api/asset-universe/why/${symbol.trim().toUpperCase()}${params}`);
            setResult(d);
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    const rec = result?.record;

    return (
        <div className="space-y-5">
            <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
                <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-4">Why was a ticker included or excluded?</h3>
                <div className="flex flex-col sm:flex-row gap-3">
                    <input
                        type="text"
                        value={symbol}
                        onChange={e => setSymbol(e.target.value.toUpperCase())}
                        onKeyDown={e => e.key === 'Enter' && lookup()}
                        placeholder="Symbol (e.g. AMD)"
                        className="flex-1 px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-white font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <input
                        type="date"
                        value={date}
                        onChange={e => setDate(e.target.value)}
                        className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <button
                        onClick={lookup}
                        disabled={loading || !symbol.trim()}
                        className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                        {loading ? 'Looking up…' : 'Look Up'}
                    </button>
                </div>
            </div>

            {error && <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-red-700 dark:text-red-300 text-sm">{error}</div>}

            {result && !result.found && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-6 text-center text-slate-400">
                    {result.message || `${symbol} was not found in the nightly scan for the selected date.`}
                </div>
            )}

            {rec && (
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                    <div className={`px-5 py-4 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3 ${rec.passed_prescreen ? 'bg-green-50 dark:bg-green-900/10' : 'bg-red-50 dark:bg-red-900/10'}`}>
                        <span className="text-xl font-mono font-bold text-slate-900 dark:text-white">{rec.symbol}</span>
                        <Badge text={rec.passed_prescreen ? '✅ Passed Prescreen' : '❌ Filtered Out'} variant={rec.passed_prescreen ? 'green' : 'red'} />
                        <span className="text-xs text-slate-400 ml-auto">{rec.analysis_date}</span>
                    </div>
                    <div className="divide-y divide-slate-100 dark:divide-slate-700/50">
                        {[
                            { label: 'AI Score',      value: rec.ai_score ?? 'n/a' },
                            { label: 'Recommendation', value: rec.recommendation ?? 'n/a' },
                            { label: 'Setup Family',   value: rec.setup_family ?? 'n/a' },
                            { label: 'Sector',         value: rec.sector ?? 'n/a' },
                            { label: 'Market Cap',     value: rec.market_cap ? `$${(rec.market_cap / 1e9).toFixed(1)}B` : 'n/a' },
                        ].map(({ label, value }) => (
                            <div key={label} className="flex justify-between px-5 py-3 text-sm">
                                <span className="text-slate-500 dark:text-slate-400">{label}</span>
                                <span className="font-medium text-slate-800 dark:text-slate-200">{value}</span>
                            </div>
                        ))}
                        {!rec.passed_prescreen && rec.exclusion_reason && (
                            <div className="px-5 py-3 text-sm">
                                <span className="text-slate-500 dark:text-slate-400 block mb-1">Exclusion Reason</span>
                                <span className="text-red-600 dark:text-red-400">{rec.exclusion_reason}</span>
                            </div>
                        )}
                        <div className="flex justify-between px-5 py-3 text-xs text-slate-400">
                            <span>Last updated</span>
                            <span>{new Date(rec.updated_at).toLocaleString()}</span>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

function DriftTab() {
    const [days,   setDays]   = useState(7);
    const [drift,  setDrift]  = useState<DriftReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error,   setError]   = useState('');

    const load = useCallback((d: number) => {
        setLoading(true); setError('');
        apiFetch(`/api/asset-universe/drift?days=${d}`)
            .then(r => setDrift(r.drift))
            .catch(e => setError(e.message))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { load(days); }, [days, load]);

    const lowConversion = drift && drift.conversionRate < 5 && drift.prescreenCount > 20;
    const lowWinRate    = drift && drift.winRate < 40 && drift.tradedCount >= 5;

    return (
        <div className="space-y-5">
            <div className="flex items-center gap-3">
                <span className="text-sm text-slate-500 dark:text-slate-400">Lookback:</span>
                {[7, 14, 30].map(d => (
                    <button
                        key={d}
                        onClick={() => setDays(d)}
                        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${days === d
                            ? 'bg-blue-600 text-white'
                            : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-600'
                        }`}
                    >
                        {d}d
                    </button>
                ))}
            </div>

            {loading && <div className="text-center py-12 text-slate-400">Loading drift data…</div>}
            {error   && <div className="text-center py-12 text-red-500">Error: {error}</div>}

            {!loading && !error && drift && (
                <>
                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                        <StatCard label="Prescreened" value={drift.prescreenCount} sub={`${days}d ago`} />
                        <StatCard label="Actually Traded" value={drift.tradedCount} />
                        <StatCard
                            label="Conversion Rate"
                            value={`${drift.conversionRate}%`}
                            color={lowConversion ? 'text-yellow-600 dark:text-yellow-400' : 'text-slate-900 dark:text-white'}
                        />
                        <StatCard
                            label="Win Rate (traded)"
                            value={drift.tradedCount > 0 ? `${drift.winRate}%` : 'n/a'}
                            color={lowWinRate ? 'text-red-500 dark:text-red-400' : drift.winRate >= 55 ? 'text-green-600 dark:text-green-400' : 'text-slate-900 dark:text-white'}
                        />
                        <StatCard
                            label="Avg P&L (traded)"
                            value={drift.tradedCount > 0 ? `$${drift.avgPnl.toFixed(2)}` : 'n/a'}
                            color={drift.avgPnl > 0 ? 'text-green-600 dark:text-green-400' : drift.avgPnl < 0 ? 'text-red-500 dark:text-red-400' : 'text-slate-900 dark:text-white'}
                        />
                    </div>

                    {(lowConversion || lowWinRate) && (
                        <div className="space-y-2">
                            {lowConversion && (
                                <div className="flex gap-3 p-4 rounded-xl bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800/50 text-sm text-yellow-800 dark:text-yellow-300">
                                    <span>⚠️</span>
                                    <span><strong>Low conversion rate ({drift.conversionRate}%)</strong> — Prescreen threshold may be too strict, or the regime has been blocking entries consistently.</span>
                                </div>
                            )}
                            {lowWinRate && (
                                <div className="flex gap-3 p-4 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 text-sm text-red-800 dark:text-red-300">
                                    <span>🔴</span>
                                    <span><strong>Low win rate on prescreened stocks ({drift.winRate}%)</strong> — Overnight scoring may be stale or the ai_score floor should be raised.</span>
                                </div>
                            )}
                        </div>
                    )}

                    {!lowConversion && !lowWinRate && drift.tradedCount > 0 && (
                        <div className="flex gap-3 p-4 rounded-xl bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/50 text-sm text-green-800 dark:text-green-300">
                            <span>✅</span>
                            <span>Prescreen thresholds look healthy. Conversion and win rate are within acceptable range.</span>
                        </div>
                    )}

                    {drift.tradedCount === 0 && (
                        <div className="text-center py-4 text-slate-400 text-sm">
                            No trades executed from prescreened stocks in the lookback window yet. Check back after more trading days.
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function ControlsTab() {
    const [scanning,  setScanning]  = useState(false);
    const [scanMsg,   setScanMsg]   = useState('');
    const [scanError, setScanError] = useState('');

    const triggerScan = async () => {
        setScanning(true); setScanMsg(''); setScanError('');
        try {
            await apiFetch('/api/asset-universe/nightly-scan', { method: 'POST' });
            setScanMsg('Nightly scan started in background. Check server logs for progress. Results will appear in Scan Summary once complete (typically 10–20 min).');
        } catch (e: any) {
            setScanError(e.message);
        } finally {
            setScanning(false);
        }
    };

    return (
        <div className="space-y-5 max-w-lg">
            <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5 space-y-4">
                <h3 className="font-semibold text-slate-700 dark:text-slate-200">Manual Nightly Scan</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                    The scan runs automatically after market close (~5 PM ET). Use this to run it manually for testing or after a scan failure.
                </p>
                <div className="rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700 p-3 text-xs text-slate-500 dark:text-slate-400 space-y-1">
                    <p>• Analyzes the full universe (~500 symbols) overnight</p>
                    <p>• Stores every score + exclusion reason in the database</p>
                    <p>• Market-hours scan reads top 120 pre-screened candidates</p>
                    <p>• Run time: ~10–20 min depending on data provider speed</p>
                </div>
                <button
                    onClick={triggerScan}
                    disabled={scanning}
                    className="w-full px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2"
                >
                    {scanning ? (
                        <><span className="animate-spin">⏳</span> Starting scan…</>
                    ) : (
                        <><span>🔭</span> Trigger Nightly Universe Scan</>
                    )}
                </button>
                {scanMsg   && <p className="text-sm text-green-700 dark:text-green-300">{scanMsg}</p>}
                {scanError && <p className="text-sm text-red-600 dark:text-red-400">Error: {scanError}</p>}
            </div>

            <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 p-5">
                <h3 className="font-semibold text-slate-700 dark:text-slate-200 mb-3">CLI Commands</h3>
                <div className="space-y-2 font-mono text-xs text-slate-600 dark:text-slate-300">
                    {[
                        ['Run nightly scan manually',     'node scripts/nightlyUniverseScan.js'],
                        ['Why was AMD excluded?',         'node scripts/queryTickerExclusion.js AMD'],
                        ['AMD on a specific date',        'node scripts/queryTickerExclusion.js AMD 2026-05-27'],
                        ['Exclusion summary',             'node scripts/queryTickerExclusion.js --summary'],
                        ['7-day drift report',            'node scripts/queryTickerExclusion.js --drift'],
                        ['New tickers today',             'node scripts/queryTickerExclusion.js --new'],
                    ].map(([label, cmd]) => (
                        <div key={cmd} className="rounded bg-slate-100 dark:bg-slate-900/60 p-2">
                            <span className="text-slate-400 block mb-0.5"># {label}</span>
                            <span>{cmd}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function UniversePage() {
    const router   = useRouter();
    const [tab, setTab] = useState<Tab>('summary');
    const [today,   setToday]  = useState('');

    useEffect(() => {
        const token = getAuthToken();
        if (!token) { router.replace('/login'); return; }
        setToday(new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }));
    }, [router]);

    return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
            <div className="max-w-6xl mx-auto px-4 py-6 space-y-6">

                {/* Header */}
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                    <div>
                        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">🔭 Universe Scanner</h1>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">Nightly full-market AI analysis — coverage, exclusions, drift</p>
                    </div>
                    {today && <span className="text-xs text-slate-400">{today}</span>}
                </div>

                {/* Tabs */}
                <div className="flex gap-1 bg-slate-100 dark:bg-slate-800 rounded-xl p-1 w-fit">
                    {TABS.map(t => (
                        <button
                            key={t.id}
                            onClick={() => setTab(t.id)}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${
                                tab === t.id
                                    ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-sm'
                                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
                            }`}
                        >
                            <span>{t.icon}</span>
                            <span>{t.label}</span>
                        </button>
                    ))}
                </div>

                {/* Tab content */}
                {tab === 'summary'  && <SummaryTab />}
                {tab === 'lookup'   && <LookupTab />}
                {tab === 'drift'    && <DriftTab />}
                {tab === 'controls' && <ControlsTab />}
            </div>
        </div>
    );
}
