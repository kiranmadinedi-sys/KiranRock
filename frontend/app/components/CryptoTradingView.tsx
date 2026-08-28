'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

interface CryptoConfig {
    enabled: boolean;
    allocation_amount: string;
    max_position_notional: string;
    max_open_positions: number;
    max_daily_trades: number;
    daily_loss_limit: string;
    stop_loss_percent: string;
    take_profit_percent: string;
    min_score: number;
}

interface CryptoPosition {
    symbol: string;
    quantity: string;
    average_price: string;
    current_price: string;
    market_value: string;
    gain_loss: string | null;
    gain_loss_percent: string | null;
}

interface TodayStats {
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
}

export default function CryptoTradingView() {
    const [config, setConfig] = useState<CryptoConfig | null>(null);
    const [positions, setPositions] = useState<CryptoPosition[]>([]);
    const [todayStats, setTodayStats] = useState<TodayStats | null>(null);
    const [universe, setUniverse] = useState<string[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const loadData = async () => {
        try {
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();
            const res = await fetch(`${apiUrl}/api/crypto-trading/status`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
            const data = await res.json();
            setConfig(data.config);
            setPositions(data.openPositions || []);
            setTodayStats(data.todayStats || null);
            setUniverse(data.universe || []);
            setError(null);
        } catch (e: any) {
            setError(e.message || 'Failed to load crypto trading status');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        loadData();
        const interval = setInterval(loadData, 30000); // refresh every 30s, matches Options Bot's polling style
        return () => clearInterval(interval);
    }, []);

    const toggleEnabled = async () => {
        if (!config) return;
        const newEnabled = !config.enabled;
        setSaving(true);
        try {
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();
            const res = await fetch(`${apiUrl}/api/crypto-trading/enable`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: newEnabled })
            });
            if (!res.ok) throw new Error('Failed to update');
            setConfig({ ...config, enabled: newEnabled });
            setMessage({ type: 'success', text: newEnabled ? 'Crypto trading enabled' : 'Crypto trading disabled' });
        } catch (e: any) {
            setMessage({ type: 'error', text: e.message || 'Failed to update' });
        } finally {
            setSaving(false);
            setTimeout(() => setMessage(null), 4000);
        }
    };

    const updateField = (key: keyof CryptoConfig, value: string) => {
        if (!config) return;
        setConfig({ ...config, [key]: value } as CryptoConfig);
    };

    const saveConfig = async () => {
        if (!config) return;
        setSaving(true);
        try {
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();
            const res = await fetch(`${apiUrl}/api/crypto-trading/config`, {
                method: 'PUT',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    allocation_amount: config.allocation_amount,
                    max_position_notional: config.max_position_notional,
                    max_open_positions: config.max_open_positions,
                    max_daily_trades: config.max_daily_trades,
                    daily_loss_limit: config.daily_loss_limit,
                    stop_loss_percent: config.stop_loss_percent,
                    take_profit_percent: config.take_profit_percent,
                    min_score: config.min_score
                })
            });
            if (!res.ok) throw new Error('Failed to save settings');
            setMessage({ type: 'success', text: 'Crypto trading settings saved' });
        } catch (e: any) {
            setMessage({ type: 'error', text: e.message || 'Failed to save settings' });
        } finally {
            setSaving(false);
            setTimeout(() => setMessage(null), 4000);
        }
    };

    if (loading) {
        return <div className="p-6 text-slate-500 dark:text-slate-400">Loading crypto trading status...</div>;
    }

    if (error) {
        return <div className="p-6 text-red-600 dark:text-red-400">Error: {error}</div>;
    }

    if (!config) return null;

    return (
        <div className="space-y-6">
            {message && (
                <div className={`px-4 py-3 rounded-xl text-sm font-medium ${message.type === 'success' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'}`}>
                    {message.text}
                </div>
            )}

            {/* Enable/disable + status summary */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                <div className="flex items-center justify-between">
                    <div>
                        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Crypto Trading</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                            24/7 automated crypto trading — {config.enabled ? 'currently active' : 'currently off'}
                        </p>
                    </div>
                    <button
                        onClick={toggleEnabled}
                        disabled={saving}
                        className={`px-5 py-2.5 rounded-xl font-medium transition-colors ${config.enabled
                            ? 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300'
                            : 'bg-green-600 text-white hover:bg-green-700'}`}
                    >
                        {saving ? 'Saving...' : config.enabled ? 'Disable' : 'Enable'}
                    </button>
                </div>

                {config.enabled && (
                    <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">Open Positions</div>
                            <div className="text-xl font-semibold text-slate-900 dark:text-white">{positions.length} / {config.max_open_positions}</div>
                        </div>
                        <div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">Trades Today</div>
                            <div className="text-xl font-semibold text-slate-900 dark:text-white">{todayStats?.trades ?? 0} / {config.max_daily_trades}</div>
                        </div>
                        <div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">Win Rate</div>
                            <div className="text-xl font-semibold text-slate-900 dark:text-white">{todayStats ? todayStats.winRate.toFixed(0) : 0}%</div>
                        </div>
                        <div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">Today's P&L</div>
                            <div className={`text-xl font-semibold ${(todayStats?.totalPnl ?? 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                ${(todayStats?.totalPnl ?? 0).toFixed(2)}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Open positions */}
            {positions.length > 0 && (
                <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                    <h3 className="text-md font-semibold text-slate-900 dark:text-white mb-4">Open Positions</h3>
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-left text-slate-500 dark:text-slate-400">
                                    <th className="pb-2">Symbol</th>
                                    <th className="pb-2">Qty</th>
                                    <th className="pb-2">Avg Price</th>
                                    <th className="pb-2">Current</th>
                                    <th className="pb-2">Value</th>
                                    <th className="pb-2">P&L</th>
                                </tr>
                            </thead>
                            <tbody>
                                {positions.map((p) => (
                                    <tr key={p.symbol} className="border-t border-slate-100 dark:border-slate-700">
                                        <td className="py-2 font-medium text-slate-900 dark:text-white">{p.symbol}</td>
                                        <td className="py-2">{parseFloat(p.quantity).toFixed(6)}</td>
                                        <td className="py-2">${parseFloat(p.average_price).toFixed(2)}</td>
                                        <td className="py-2">${parseFloat(p.current_price || p.average_price).toFixed(2)}</td>
                                        <td className="py-2">${parseFloat(p.market_value || '0').toFixed(2)}</td>
                                        <td className={`py-2 ${parseFloat(p.gain_loss || '0') >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                            {p.gain_loss ? `$${parseFloat(p.gain_loss).toFixed(2)} (${parseFloat(p.gain_loss_percent || '0').toFixed(2)}%)` : '—'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {/* Settings */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                <h3 className="text-md font-semibold text-slate-900 dark:text-white mb-4">Settings</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Allocation Amount ($)</label>
                        <input type="number" min={0} value={config.allocation_amount} onChange={(e) => updateField('allocation_amount', e.target.value)} className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Max Position Notional ($)</label>
                        <input type="number" min={0} value={config.max_position_notional} onChange={(e) => updateField('max_position_notional', e.target.value)} className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Max Open Positions</label>
                        <input type="number" min={1} value={config.max_open_positions} onChange={(e) => updateField('max_open_positions', e.target.value)} className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Max Daily Trades</label>
                        <input type="number" min={1} value={config.max_daily_trades} onChange={(e) => updateField('max_daily_trades', e.target.value)} className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Daily Loss Limit ($)</label>
                        <input type="number" value={config.daily_loss_limit} onChange={(e) => updateField('daily_loss_limit', e.target.value)} className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Min Score (0-100)</label>
                        <input type="number" min={0} max={100} value={config.min_score} onChange={(e) => updateField('min_score', e.target.value)} className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Stop Loss (%)</label>
                        <input type="number" min={0} value={config.stop_loss_percent} onChange={(e) => updateField('stop_loss_percent', e.target.value)} className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Take Profit (%)</label>
                        <input type="number" min={0} value={config.take_profit_percent} onChange={(e) => updateField('take_profit_percent', e.target.value)} className="w-full px-4 py-2.5 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                    </div>
                </div>
                <button
                    onClick={saveConfig}
                    disabled={saving}
                    className="mt-5 px-5 py-2.5 rounded-xl font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                    {saving ? 'Saving...' : 'Save Settings'}
                </button>
            </div>

            {/* Universe */}
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6">
                <h3 className="text-md font-semibold text-slate-900 dark:text-white mb-3">Tradeable Universe</h3>
                <div className="flex flex-wrap gap-2">
                    {universe.map((s) => (
                        <span key={s} className="px-3 py-1 text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-full">{s}</span>
                    ))}
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-3">
                    5-minute scan cycle, 24/7 including weekends. A curated liquid pair list, not the full crypto market.
                </p>
            </div>
        </div>
    );
}
