'use client';

import React, { useState, useEffect, useCallback } from 'react';
import AppHeader from '../components/AppHeader';
import { getApiBaseUrl } from '../config';

interface Blockers {
    duplicateOrders: number;
    orderStorms: number;
    stopLossFailures: number;
    reconciliationErrors: number;
    pendingOrdersOver24h: number;
}

interface Advisory {
    partialFills: number;
    reconFixes: number;
}

interface ReadinessData {
    liveReady: boolean;
    reason: string;
    blockers: Blockers;
    advisory: Advisory;
    blockerWindow: string;
    advisoryWindow: string;
    checkedAt: string;
}

interface HealthMetrics {
    duplicateOrders: number;
    openOrderStorms: number;
    partialFillWarnings: number;
    stopLossFailures: number;
    reconciliationFixes: number;
    pendingOrdersOver24h: number;
}

interface HealthData {
    date: string;
    metrics: HealthMetrics;
    status: 'GREEN' | 'YELLOW' | 'RED';
}

interface ScoreRow {
    score_bucket: string;
    trades: number;
    win_rate: number;
    avg_pnl_pct: number;
    total_pnl: number;
}

interface AttributionData {
    window: string;
    byScore: ScoreRow[];
}

interface HaltStatus {
    halted: boolean;
    reason: string | null;
    set_at: string | null;
}

export default function LiveReadinessPage() {
    const [readiness, setReadiness] = useState<ReadinessData | null>(null);
    const [health, setHealth] = useState<HealthData | null>(null);
    const [attribution, setAttribution] = useState<AttributionData | null>(null);
    const [haltStatus, setHaltStatus] = useState<HaltStatus | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
    const [ackLoading, setAckLoading] = useState(false);
    const [ackResult, setAckResult] = useState<string | null>(null);
    const [haltClearLoading, setHaltClearLoading] = useState(false);
    const [haltClearResult, setHaltClearResult] = useState<string | null>(null);

    const fetchAll = useCallback(async () => {
        try {
            const token = localStorage.getItem('token');
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;

            const base = getApiBaseUrl();
            const [rRes, hRes, aRes, haltRes] = await Promise.all([
                fetch(`${base}/api/system/live-readiness`, { headers }),
                fetch(`${base}/api/system/health-dashboard`, { headers }),
                fetch(`${base}/api/system/trade-attribution?days=90`, { headers }),
                fetch(`${base}/api/system/halt-status`, { headers }),
            ]);

            if (!rRes.ok) throw new Error(`Live-readiness: ${rRes.status}`);
            if (!hRes.ok) throw new Error(`Health dashboard: ${hRes.status}`);

            setReadiness(await rRes.json());
            setHealth(await hRes.json());
            if (aRes.ok) setAttribution(await aRes.json());
            if (haltRes.ok) setHaltStatus(await haltRes.json());

            setError(null);
            setLastRefresh(new Date());
        } catch (err: any) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchAll();
        const interval = setInterval(fetchAll, 60_000);
        return () => clearInterval(interval);
    }, [fetchAll]);

    const blockerLabels: Record<keyof Blockers, string> = {
        duplicateOrders:      'Duplicate Orders',
        orderStorms:          'Order Storms',
        stopLossFailures:     'Stop-Loss Failures',
        reconciliationErrors: 'Reconciliation Errors',
        pendingOrdersOver24h: 'Pending > 24h',
    };

    const advisoryLabels: Record<keyof Advisory, string> = {
        partialFills: 'Partial Fills',
        reconFixes:   'Recon Auto-Fixes',
    };

    const healthLabels: Record<keyof HealthMetrics, string> = {
        duplicateOrders:      'Duplicate Orders',
        openOrderStorms:      'Order Storms',
        partialFillWarnings:  'Partial Fills',
        stopLossFailures:     'Stop-Loss Failures',
        reconciliationFixes:  'Recon Fixes',
        pendingOrdersOver24h: 'Pending > 24h',
    };

    const healthSeverity: Record<keyof HealthMetrics, 'critical' | 'warning'> = {
        duplicateOrders:      'critical',
        openOrderStorms:      'critical',
        partialFillWarnings:  'warning',
        stopLossFailures:     'critical',
        reconciliationFixes:  'warning',
        pendingOrdersOver24h: 'critical',
    };

    const statusBadge = (count: number, type: 'critical' | 'warning') => {
        if (count === 0) return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300">0 ✓</span>;
        if (type === 'critical') return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">{count} ✗</span>;
        return <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300">{count} ⚠</span>;
    };

    const pnlColor = (v: number) => v > 0 ? 'text-green-600 dark:text-green-400' : v < 0 ? 'text-red-500 dark:text-red-400' : 'text-gray-500';

    const clearHalt = async () => {
        if (!confirm('Clear the Emergency Stop (HALT_ALL)?\n\nOnly do this if you\'ve confirmed the root cause is resolved. The bot will resume trading on the next scheduler tick (within 5 minutes).')) return;
        setHaltClearLoading(true);
        setHaltClearResult(null);
        try {
            const token = localStorage.getItem('token');
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch(`${getApiBaseUrl()}/api/system/halt/clear`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ confirm: true }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || res.statusText);
            setHaltClearResult(data.message);
            await fetchAll();
        } catch (err: any) {
            setHaltClearResult(`Error: ${err.message}`);
        } finally {
            setHaltClearLoading(false);
        }
    };

    const acknowledgeBlockers = async () => {
        if (!confirm('Acknowledge all current SENTINEL blockers?\n\nOnly do this after confirming the issues were caused by a known bug that is now fixed. Audit records are NOT deleted.')) return;
        setAckLoading(true);
        setAckResult(null);
        try {
            const token = localStorage.getItem('token');
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (token) headers['Authorization'] = `Bearer ${token}`;
            const res = await fetch(`${getApiBaseUrl()}/api/system/sentinel/acknowledge-blockers`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ reason: 'Acknowledged via SENTINEL UI — known bug confirmed fixed' }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || res.statusText);
            const { acknowledged } = data;
            setAckResult(
                `Cleared: ${acknowledged.orderKeysAcknowledged} order keys, ` +
                `${acknowledged.stopFailuresAcknowledged} stop-loss failures, ` +
                `${acknowledged.reconErrorsAcknowledged} recon errors`
            );
            await fetchAll();
        } catch (err: any) {
            setAckResult(`Error: ${err.message}`);
        } finally {
            setAckLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
            <AppHeader />

            <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">

                {/* Page Title */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                            🛡️ SENTINEL — Live Readiness
                        </h1>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                            Go / no-go gate before deploying real capital
                        </p>
                    </div>
                    <div className="flex items-center gap-3">
                        {lastRefresh && (
                            <span className="text-xs text-gray-400">
                                Refreshed {lastRefresh.toLocaleTimeString()}
                            </span>
                        )}
                        <button
                            onClick={fetchAll}
                            className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                        >
                            ↻ Refresh
                        </button>
                        {readiness && !readiness.liveReady && (
                            <button
                                onClick={acknowledgeBlockers}
                                disabled={ackLoading}
                                className="px-3 py-1.5 text-sm font-medium bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white rounded-lg transition-colors"
                            >
                                {ackLoading ? 'Clearing…' : '✓ Acknowledge Blockers'}
                            </button>
                        )}
                    </div>
                </div>

                {error && (
                    <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-700 dark:text-red-400 text-sm">
                        {error}
                    </div>
                )}

                {ackResult && (
                    <div className={`p-4 rounded-lg text-sm border ${
                        ackResult.startsWith('Error')
                            ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'
                            : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
                    }`}>
                        {ackResult.startsWith('Error') ? '✗ ' : '✓ '}{ackResult}
                    </div>
                )}

                {/* ─── Emergency Stop (HALT_ALL) Banner ─── */}
                {haltStatus && (
                    <div className={`rounded-xl p-5 border-2 flex flex-col sm:flex-row items-start sm:items-center gap-4 ${
                        haltStatus.halted
                            ? 'bg-red-50 dark:bg-red-900/20 border-red-500 dark:border-red-600 animate-pulse'
                            : 'bg-green-50 dark:bg-green-900/20 border-green-400 dark:border-green-600'
                    }`}>
                        <div className="text-4xl">{haltStatus.halted ? '🛑' : '🤖'}</div>
                        <div className="flex-1">
                            <div className={`text-lg font-bold ${haltStatus.halted ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}>
                                {haltStatus.halted ? 'BOT EMERGENCY STOP — Trading Frozen' : 'Bot Active — No Emergency Stop'}
                            </div>
                            {haltStatus.halted && (
                                <>
                                    <div className="text-sm text-red-600 dark:text-red-400 mt-1 font-mono break-all">{haltStatus.reason}</div>
                                    {haltStatus.set_at && (
                                        <div className="text-xs text-red-500 dark:text-red-400 mt-1">
                                            Set at: {new Date(haltStatus.set_at).toLocaleString()}
                                        </div>
                                    )}
                                </>
                            )}
                            {!haltStatus.halted && (
                                <div className="text-sm text-green-600 dark:text-green-400 mt-1">All scheduler cycles running normally</div>
                            )}
                        </div>
                        {haltStatus.halted && (
                            <div className="flex flex-col gap-2 items-end">
                                <button
                                    onClick={clearHalt}
                                    disabled={haltClearLoading}
                                    className="px-4 py-2 text-sm font-bold bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white rounded-lg transition-colors whitespace-nowrap"
                                >
                                    {haltClearLoading ? 'Clearing…' : '🔓 Clear Emergency Stop'}
                                </button>
                                <span className="text-xs text-red-500 dark:text-red-400">Bot resumes within 5 min</span>
                            </div>
                        )}
                    </div>
                )}

                {haltClearResult && (
                    <div className={`p-4 rounded-lg text-sm border ${
                        haltClearResult.startsWith('Error')
                            ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800 text-red-700 dark:text-red-400'
                            : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800 text-green-700 dark:text-green-400'
                    }`}>
                        {haltClearResult.startsWith('Error') ? '✗ ' : '✓ '}{haltClearResult}
                    </div>
                )}

                {loading && !readiness && (
                    <div className="flex items-center justify-center h-40 text-gray-400">
                        Loading…
                    </div>
                )}

                {/* ─── SENTINEL Gate Banner ─── */}
                {readiness && (
                    <div className={`rounded-2xl p-6 border-2 flex flex-col sm:flex-row items-start sm:items-center gap-4 ${
                        readiness.liveReady
                            ? 'bg-green-50 dark:bg-green-900/20 border-green-400 dark:border-green-600'
                            : 'bg-red-50 dark:bg-red-900/20 border-red-400 dark:border-red-600'
                    }`}>
                        <div className={`text-5xl ${readiness.liveReady ? '' : 'animate-pulse'}`}>
                            {readiness.liveReady ? '✅' : '🚫'}
                        </div>
                        <div className="flex-1">
                            <div className={`text-2xl font-extrabold ${readiness.liveReady ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>
                                {readiness.liveReady ? 'LIVE READY' : 'BLOCKED'}
                            </div>
                            <div className={`text-sm mt-1 ${readiness.liveReady ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                {readiness.reason}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                Blockers checked over {readiness.blockerWindow} · Advisory over {readiness.advisoryWindow}
                            </div>
                        </div>
                        <div className="text-xs text-gray-400 whitespace-nowrap">
                            {new Date(readiness.checkedAt).toLocaleString()}
                        </div>
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

                    {/* ─── Hard Blockers ─── */}
                    {readiness && (
                        <div className="bg-white dark:bg-gray-800 rounded-xl shadow border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <div className="px-5 py-4 bg-gradient-to-r from-red-600 to-rose-600 flex items-center justify-between">
                                <h2 className="text-white font-bold text-sm">Hard Blockers</h2>
                                <span className="text-red-100 text-xs">{readiness.blockerWindow} window · any non-zero blocks deployment</span>
                            </div>
                            <div className="divide-y divide-gray-100 dark:divide-gray-700">
                                {(Object.keys(readiness.blockers) as (keyof Blockers)[]).map(key => (
                                    <div key={key} className="flex items-center justify-between px-5 py-3">
                                        <span className="text-sm text-gray-700 dark:text-gray-300">{blockerLabels[key]}</span>
                                        {statusBadge(readiness.blockers[key], 'critical')}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* ─── Advisory Indicators ─── */}
                    {readiness && (
                        <div className="bg-white dark:bg-gray-800 rounded-xl shadow border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <div className="px-5 py-4 bg-gradient-to-r from-yellow-500 to-amber-500 flex items-center justify-between">
                                <h2 className="text-white font-bold text-sm">Advisory Indicators</h2>
                                <span className="text-yellow-100 text-xs">{readiness.advisoryWindow} window · informational only</span>
                            </div>
                            <div className="divide-y divide-gray-100 dark:divide-gray-700">
                                {(Object.keys(readiness.advisory) as (keyof Advisory)[]).map(key => (
                                    <div key={key} className="flex items-center justify-between px-5 py-3">
                                        <div>
                                            <span className="text-sm text-gray-700 dark:text-gray-300">{advisoryLabels[key]}</span>
                                            <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                                                {key === 'partialFills'
                                                    ? 'Normal in live trading — monitor for trends'
                                                    : 'Drift auto-corrected — review if count rises'}
                                            </p>
                                        </div>
                                        {statusBadge(readiness.advisory[key], 'warning')}
                                    </div>
                                ))}
                            </div>
                            <div className="px-5 py-3 bg-yellow-50 dark:bg-yellow-900/10 text-xs text-yellow-700 dark:text-yellow-400">
                                Advisory counts are normal operational events. They do not block live deployment but should not trend upward week-over-week.
                            </div>
                        </div>
                    )}
                </div>

                {/* ─── Today's Health Dashboard ─── */}
                {health && (
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow border border-gray-200 dark:border-gray-700 overflow-hidden">
                        <div className={`px-5 py-4 flex items-center justify-between ${
                            health.status === 'GREEN'  ? 'bg-gradient-to-r from-green-600 to-emerald-600' :
                            health.status === 'YELLOW' ? 'bg-gradient-to-r from-yellow-500 to-amber-500' :
                                                         'bg-gradient-to-r from-red-600 to-rose-600'
                        }`}>
                            <h2 className="text-white font-bold text-sm">Today's Execution Health</h2>
                            <span className={`px-3 py-1 rounded-full text-xs font-bold ${
                                health.status === 'GREEN'  ? 'bg-green-800/50 text-green-100' :
                                health.status === 'YELLOW' ? 'bg-yellow-800/50 text-yellow-100' :
                                                             'bg-red-800/50 text-red-100'
                            }`}>{health.status} — {health.date}</span>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 divide-x divide-y divide-gray-100 dark:divide-gray-700">
                            {(Object.keys(health.metrics) as (keyof HealthMetrics)[]).map(key => {
                                const v = health.metrics[key];
                                const sev = healthSeverity[key];
                                return (
                                    <div key={key} className="p-4 text-center">
                                        <div className={`text-2xl font-extrabold ${
                                            v === 0 ? 'text-green-600 dark:text-green-400' :
                                            sev === 'critical' ? 'text-red-600 dark:text-red-400' :
                                            'text-yellow-600 dark:text-yellow-400'
                                        }`}>{v}</div>
                                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 leading-tight">{healthLabels[key]}</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* ─── Trade Attribution by Score ─── */}
                {attribution && attribution.byScore.length > 0 && (
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow border border-gray-200 dark:border-gray-700 overflow-hidden">
                        <div className="px-5 py-4 bg-gradient-to-r from-blue-600 to-indigo-600 flex items-center justify-between">
                            <h2 className="text-white font-bold text-sm">Win Rate by AI Score Bucket</h2>
                            <span className="text-blue-100 text-xs">{attribution.window}</span>
                        </div>
                        {attribution.byScore.length === 0 ? (
                            <div className="px-5 py-6 text-center text-sm text-gray-400">
                                No closed trades in window yet — populate during paper run.
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead className="bg-gray-50 dark:bg-gray-700/50 text-xs text-gray-500 dark:text-gray-400 uppercase">
                                        <tr>
                                            <th className="px-5 py-2 text-left">Score Bucket</th>
                                            <th className="px-4 py-2 text-right">Trades</th>
                                            <th className="px-4 py-2 text-right">Win Rate</th>
                                            <th className="px-4 py-2 text-right">Avg P&L %</th>
                                            <th className="px-4 py-2 text-right">Total P&L</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                                        {attribution.byScore.map(row => (
                                            <tr key={row.score_bucket} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                                                <td className="px-5 py-3 font-semibold text-gray-900 dark:text-white">{row.score_bucket}</td>
                                                <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-300">{row.trades}</td>
                                                <td className="px-4 py-3 text-right">
                                                    <span className={`font-semibold ${Number(row.win_rate) >= 50 ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'}`}>
                                                        {row.win_rate}%
                                                    </span>
                                                </td>
                                                <td className={`px-4 py-3 text-right font-semibold ${pnlColor(Number(row.avg_pnl_pct))}`}>
                                                    {Number(row.avg_pnl_pct) > 0 ? '+' : ''}{row.avg_pnl_pct}%
                                                </td>
                                                <td className={`px-4 py-3 text-right font-semibold ${pnlColor(Number(row.total_pnl))}`}>
                                                    ${Number(row.total_pnl) > 0 ? '+' : ''}{Number(row.total_pnl).toFixed(2)}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        <div className="px-5 py-3 bg-blue-50 dark:bg-blue-900/10 text-xs text-blue-600 dark:text-blue-400">
                            Populated from <code>trade_decision_journal</code>. Will show data after paper/live trades are closed and journaled.
                        </div>
                    </div>
                )}

                {/* ─── Protocol Reminder ─── */}
                <div className="bg-gradient-to-r from-slate-800 to-gray-900 rounded-xl p-5 text-sm text-gray-300 space-y-2">
                    <div className="font-bold text-white text-base">100-Trade Live Protocol Phases</div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3">
                        {[
                            { phase: 'Phase 1 (0–25)', goal: 'Observation only', gate: 'Slippage ≤ 0.3% · Fill rate ≥ 90%' },
                            { phase: 'Phase 2 (26–50)', goal: 'Stability validation', gate: 'No stop-loss failures · Partials ≤ 15%' },
                            { phase: 'Phase 3 (51–100)', goal: 'Scaling eligibility', gate: 'Win rate 80+ bucket ≥ 45% · Avg P&L > 0' },
                        ].map(p => (
                            <div key={p.phase} className="bg-gray-700/40 rounded-lg p-3 space-y-1">
                                <div className="font-semibold text-white text-xs">{p.phase}</div>
                                <div className="text-gray-300 text-xs">{p.goal}</div>
                                <div className="text-gray-400 text-[11px]">{p.gate}</div>
                            </div>
                        ))}
                    </div>
                    <div className="text-xs text-gray-500 pt-1">Full protocol: <code>LIVE_TRADING_PROTOCOL.md</code> at project root</div>
                </div>

            </main>
        </div>
    );
}
