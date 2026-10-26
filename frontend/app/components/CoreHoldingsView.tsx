'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

interface CoreHolding {
    symbol: string;
    targetPct: number;
    targetUsd: number | null;
    qty: number;
    avgPrice: number | null;
    price: number | null;
    value: number;
    unrealizedPl: number;
    currentPct: number | null;
}

interface CoreStatus {
    settings: { enabled: boolean; cashReservePct: number };
    equity: number | null;
    cash: number | null;
    totalTargetPct: number;
    holdings: CoreHolding[];
    totals: { value: number; unrealizedPl: number; cost: number };
    limits: { maxSymbols: number; maxTotalPct: number; maxSinglePct: number };
    addons?: {
        sweep?: { enabled: boolean; qty: number; symbol: string; allowed: boolean };
        drawdown?: { peakIndex: number | null; alertedLevel: number };
        dividends?: { total: number; bySymbol: Record<string, number>; error?: string };
        longTerm?: Record<string, { firstBuy: string; longTermFrom: string }>;
        error?: string;
    };
}

interface EditRow { symbol: string; targetPct: string }

const money = (v: number | null | undefined) =>
    v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function CoreHoldingsView() {
    const [status, setStatus] = useState<CoreStatus | null>(null);
    const [rows, setRows] = useState<EditRow[]>([]);
    const [reserve, setReserve] = useState('25');
    const [release, setRelease] = useState<string[]>([]);
    const [dirty, setDirty] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const authHeaders = () => ({ 'Authorization': `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' });

    const loadData = async (resetForm = false) => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/core-holdings/status`, { headers: authHeaders() });
            if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
            const data: CoreStatus = await res.json();
            setStatus(data);
            if (resetForm) {
                setRows(data.holdings.map(h => ({ symbol: h.symbol, targetPct: String(h.targetPct) })));
                setReserve(String(data.settings.cashReservePct));
                setRelease([]);
                setDirty(false);
            }
            setError(null);
        } catch (e: any) {
            setError(e.message || 'Failed to load core holdings');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData(true);
        const interval = setInterval(() => loadData(false), 30000); // live values refresh; the form is left alone
        return () => clearInterval(interval);
    }, []);

    const flash = (type: 'success' | 'error', text: string, ms = 5000) => {
        setMessage({ type, text });
        setTimeout(() => setMessage(null), ms);
    };

    const toggleEnabled = async () => {
        if (!status) return;
        const enabled = !status.settings.enabled;
        setSaving(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/core-holdings/enable`, {
                method: 'POST', headers: authHeaders(), body: JSON.stringify({ enabled })
            });
            if (!res.ok) throw new Error('Failed to update');
            setStatus({ ...status, settings: { ...status.settings, enabled } });
            flash('success', enabled
                ? 'Core holdings on — buys toward your targets once a trading day after 10:00 AM ET'
                : 'Core buying paused — existing core positions are kept and still protected from the swing bot');
        } catch (e: any) {
            flash('error', e.message || 'Failed to update');
        } finally {
            setSaving(false);
        }
    };

    const heldSymbols = new Set((status?.holdings || []).filter(h => h.qty > 0).map(h => h.symbol));
    const editedSymbols = new Set(rows.map(r => r.symbol.trim().toUpperCase()).filter(Boolean));
    const removedHeld = Array.from(heldSymbols).filter(s => !editedSymbols.has(s));
    const totalPct = rows.reduce((s, r) => s + (parseFloat(r.targetPct) || 0), 0);
    const maxTotal = status?.limits.maxTotalPct ?? 80;

    const updateRow = (i: number, key: keyof EditRow, value: string) => {
        const next = rows.slice();
        next[i] = { ...next[i], [key]: key === 'symbol' ? value.toUpperCase() : value };
        setRows(next); setDirty(true);
    };
    const addRow = () => { setRows([...rows, { symbol: '', targetPct: '10' }]); setDirty(true); };
    const removeRow = (i: number) => { setRows(rows.filter((_, k) => k !== i)); setDirty(true); };
    const toggleRelease = (sym: string) =>
        setRelease(release.includes(sym) ? release.filter(s => s !== sym) : [...release, sym]);

    const saveConfig = async () => {
        setSaving(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/core-holdings/config`, {
                method: 'PUT', headers: authHeaders(),
                body: JSON.stringify({
                    cashReservePct: parseFloat(reserve),
                    holdings: rows.filter(r => r.symbol.trim()).map(r => ({ symbol: r.symbol.trim().toUpperCase(), targetPct: parseFloat(r.targetPct) || 0 })),
                    releaseSymbols: release,
                })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed to save settings');
            flash('success', data.released?.length
                ? `Saved. Released to the swing bot: ${data.released.join(', ')}`
                : 'Core holdings settings saved');
            await loadData(true);
        } catch (e: any) {
            flash('error', e.message || 'Failed to save settings', 9000);
        } finally {
            setSaving(false);
        }
    };

    if (loading) return <div className="p-6 text-slate-500 dark:text-slate-400">Loading core holdings...</div>;
    if (error) return <div className="p-6 text-red-600 dark:text-red-400">Error: {error}</div>;
    if (!status) return null;

    const plPct = status.totals.cost > 0 ? status.totals.unrealizedPl / status.totals.cost * 100 : 0;
    const corePct = status.equity ? status.totals.value / status.equity * 100 : 0;
    const input = 'w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white';

    return (
        <div className="space-y-6">
            {message && (
                <div className={`px-4 py-3 rounded-xl text-sm font-medium ${message.type === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'}`}>
                    {message.text}
                </div>
            )}

            {/* Enable/disable + summary */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                <div className="flex items-center justify-between gap-4">
                    <div>
                        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Core Holdings</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                            Long-term positions for idle cash — {status.settings.enabled ? 'buying toward targets' : 'buying paused'}
                        </p>
                    </div>
                    <button
                        onClick={toggleEnabled}
                        disabled={saving}
                        className={`px-5 py-2.5 rounded-xl font-medium transition-colors ${status.settings.enabled
                            ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300'
                            : 'bg-green-600 text-white hover:bg-green-700'}`}
                    >
                        {saving ? 'Saving...' : status.settings.enabled ? 'Pause Buying' : 'Enable'}
                    </button>
                </div>

                <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">Core Value</div>
                        <div className="text-xl font-semibold text-slate-900 dark:text-white">{money(status.totals.value)}</div>
                    </div>
                    <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">Unrealized P&L</div>
                        <div className={`text-xl font-semibold ${status.totals.unrealizedPl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {money(status.totals.unrealizedPl)} ({plPct.toFixed(1)}%)
                        </div>
                    </div>
                    <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">Core / Account</div>
                        <div className="text-xl font-semibold text-slate-900 dark:text-white">{corePct.toFixed(1)}% <span className="text-sm text-slate-500">of {status.totalTargetPct}% target</span></div>
                    </div>
                    <div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">Account Equity / Cash</div>
                        <div className="text-xl font-semibold text-slate-900 dark:text-white">{money(status.equity)}</div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">cash {money(status.cash)}</div>
                    </div>
                </div>
            </div>

            {/* Positions */}
            {status.holdings.length > 0 && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                    <h3 className="text-md font-semibold text-slate-900 dark:text-white mb-4">Positions</h3>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-slate-500 dark:text-slate-400">
                                    <th className="pb-2">Symbol</th>
                                    <th className="pb-2">Target</th>
                                    <th className="pb-2">Now</th>
                                    <th className="pb-2">Shares</th>
                                    <th className="pb-2">Avg Price</th>
                                    <th className="pb-2">Price</th>
                                    <th className="pb-2">Value</th>
                                    <th className="pb-2">P&L</th>
                                    <th className="pb-2">Dividends</th>
                                    <th className="pb-2" title="US long-term holding period: held more than one year (first lot). Not tax advice.">Long-term from</th>
                                </tr>
                            </thead>
                            <tbody>
                                {status.holdings.map(h => (
                                    <tr key={h.symbol} className="border-t border-slate-100 dark:border-slate-700">
                                        <td className="py-2 font-medium text-slate-900 dark:text-white">{h.symbol}</td>
                                        <td className="py-2">{h.targetPct}%{h.targetPct === 0 ? ' (hold only)' : ''} <span className="text-slate-400">{money(h.targetUsd)}</span></td>
                                        <td className="py-2">{h.currentPct ?? '—'}%</td>
                                        <td className="py-2">{h.qty}</td>
                                        <td className="py-2">{money(h.avgPrice)}</td>
                                        <td className="py-2">{money(h.price)}</td>
                                        <td className="py-2">{money(h.value)}</td>
                                        <td className={`py-2 ${h.unrealizedPl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{h.qty > 0 ? money(h.unrealizedPl) : '—'}</td>
                                        <td className="py-2">{money(status.addons?.dividends?.bySymbol?.[h.symbol] ?? 0)}</td>
                                        <td className="py-2 whitespace-nowrap">{status.addons?.longTerm?.[h.symbol]?.longTermFrom ?? '—'}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Income, cash sweep, drawdown (2026-10-26) */}
            {status.addons && !status.addons.error && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                    <h3 className="text-md font-semibold text-slate-900 dark:text-white mb-4">Income &amp; protection</h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                        <div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">Dividends received (core)</div>
                            <div className="text-xl font-semibold text-slate-900 dark:text-white">{money(status.addons.dividends?.total ?? 0)}</div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">{status.addons.dividends?.error || 'Reinvested by the daily top-up toward targets'}</div>
                        </div>
                        <div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">Drawdown alerts</div>
                            <div className="text-slate-900 dark:text-white">Telegram at −10%, −15%, −20% from core&apos;s peak{status.addons.drawdown?.alertedLevel ? ` (last: −${status.addons.drawdown.alertedLevel}%)` : ''}</div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">Information only — core never sells automatically</div>
                        </div>
                        <div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">Cash sweep into {status.addons.sweep?.symbol} (T-bills)</div>
                            {status.addons.sweep?.allowed ? (
                                <label className="flex items-center gap-2 text-slate-900 dark:text-white">
                                    <input type="checkbox" checked={!!status.addons.sweep?.enabled} onChange={async e => {
                                        try {
                                            const res = await fetch(`${getApiBaseUrl()}/api/core-holdings/sweep`, { method: 'PUT', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: e.target.checked }) });
                                            const d = await res.json();
                                            if (!res.ok) throw new Error(d.error || 'Failed');
                                            loadData();
                                        } catch (err: any) { setMessage({ type: 'error', text: err.message }); }
                                    }} />
                                    {status.addons.sweep?.enabled ? `On — ${(status.addons.sweep?.qty ?? 0).toFixed(2)} swept shares` : 'Off'}
                                </label>
                            ) : <div className="text-slate-500 dark:text-slate-400">Paper accounts only for now</div>}
                            <div className="text-xs text-slate-500 dark:text-slate-400">Idle cash above reserve + 5% earns T-bill yield; sold back when swing trading needs it</div>
                        </div>
                    </div>
                </div>
            )}

            {/* Settings */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                <h3 className="text-md font-semibold text-slate-900 dark:text-white mb-1">Settings</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">
                    Target = % of total account value. Set a stock to 0% to keep holding it without buying more.
                </p>

                <div className="space-y-3">
                    {rows.map((r, i) => (
                        <div key={i} className="grid grid-cols-12 gap-3 items-center">
                            <input className={`${input} col-span-5`} placeholder="Symbol (e.g. SPY)" value={r.symbol} onChange={e => updateRow(i, 'symbol', e.target.value)} />
                            <div className="col-span-5 flex items-center gap-2">
                                <input type="number" min={0} max={status.limits.maxSinglePct} className={input} value={r.targetPct} onChange={e => updateRow(i, 'targetPct', e.target.value)} />
                                <span className="text-sm text-slate-500">%</span>
                            </div>
                            <button onClick={() => removeRow(i)} className="col-span-2 px-3 py-2 rounded-xl text-sm bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200">Remove</button>
                        </div>
                    ))}
                    {rows.length < status.limits.maxSymbols && (
                        <button onClick={addRow} className="px-4 py-2 rounded-xl text-sm bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200">+ Add stock</button>
                    )}
                </div>

                <div className={`mt-4 text-sm ${totalPct > maxTotal ? 'text-red-600' : 'text-slate-600 dark:text-slate-300'}`}>
                    Total target: <b>{totalPct}%</b> of account (max {maxTotal}%, each stock up to {status.limits.maxSinglePct}%)
                </div>

                <div className="mt-4 max-w-xs">
                    <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Cash kept free for swing trading (%)</label>
                    <input type="number" min={10} max={80} className={input} value={reserve} onChange={e => { setReserve(e.target.value); setDirty(true); }} />
                </div>

                {removedHeld.length > 0 && (
                    <div className="mt-4 p-4 rounded-xl bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 text-sm text-amber-900 dark:text-amber-200">
                        <b>You removed a stock you still hold.</b> Removing it hands the position to the swing bot, which may set a stop or sell it.
                        To keep holding it without buying more, set it to 0% instead.
                        {removedHeld.map(sym => (
                            <label key={sym} className="flex items-center gap-2 mt-2">
                                <input type="checkbox" checked={release.includes(sym)} onChange={() => toggleRelease(sym)} />
                                Yes, release {sym} to the swing bot
                            </label>
                        ))}
                    </div>
                )}

                <button
                    onClick={saveConfig}
                    disabled={saving || !dirty || totalPct > maxTotal}
                    className="mt-5 px-5 py-2.5 rounded-xl font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                    {saving ? 'Saving...' : 'Save Settings'}
                </button>
            </div>

            {/* How it works */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 text-sm text-slate-600 dark:text-slate-300 space-y-2">
                <h3 className="text-md font-semibold text-slate-900 dark:text-white mb-2">How it works</h3>
                <p>• Once each trading day after 10:00 AM ET, buys whole shares toward your targets, keeping the cash reserve free for the swing bot. Large targets build up over a few days (per-order limit).</p>
                <p>• <b>Never sells automatically.</b> Selling core is always your decision.</p>
                <p>• No stop-loss on core positions, and the swing bot never touches them — they don't count toward its position limit.</p>
                <p>• Core moves with the market: since 2023 the S&P 500's worst drop was about −19% and the Nasdaq's about −23%. Use money you can hold through that.</p>
            </div>
        </div>
    );
}
