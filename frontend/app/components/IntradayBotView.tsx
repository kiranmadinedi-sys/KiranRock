'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

interface IntradayPosition {
    id: number;
    symbol: string;
    quantity: number;
    average_price: number;
    current_price?: number;
    market_value?: number;
    gain_loss?: number;
    gain_loss_percent?: number;
    stop_loss_price?: number;
    take_profit_price?: number;
    opened_at: string;
}

interface IntradayConfig {
    enabled: boolean;
    allocation_amount: number;
    max_position_notional: number;
    max_open_positions: number;
    max_daily_trades: number;
    daily_loss_limit: number;
    stop_loss_percent: number;
    take_profit_percent: number;
    min_score: number;
    force_flat_eod: boolean;
}

interface BotStatus {
    enabled: boolean;
    config: IntradayConfig | null;
    openPositions: number;
    positions: IntradayPosition[];
    todayPnl: number;
    tradesToday: number;
    universe: string[];
    scheduler: { active: boolean; marketOpen: boolean };
}

export default function IntradayBotView() {
    const [status, setStatus] = useState<BotStatus | null>(null);
    const [performance, setPerformance] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [enabling, setEnabling] = useState(false);
    const [showWarningModal, setShowWarningModal] = useState(false);
    const [scanning, setScanning] = useState(false);

    const [settingsLoading, setSettingsLoading] = useState(false);
    const [settingsChanged, setSettingsChanged] = useState(false);
    const [formConfig, setFormConfig] = useState<IntradayConfig | null>(null);

    useEffect(() => {
        loadBotData();
        const interval = setInterval(loadBotData, 30000);
        return () => clearInterval(interval);
    }, []);

    const loadBotData = async () => {
        try {
            const token = localStorage.getItem('token');
            if (!token) {
                setError('Please login to use Blitz');
                setLoading(false);
                return;
            }

            const apiUrl = getApiBaseUrl();

            const statusRes = await fetch(`${apiUrl}/api/intraday/status`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (statusRes.ok) {
                const statusData = await statusRes.json();
                setStatus(statusData);
                setFormConfig(prev => (prev && settingsChanged) ? prev : statusData.config);
            }

            const perfRes = await fetch(`${apiUrl}/api/intraday/performance?period=week`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (perfRes.ok) {
                setPerformance(await perfRes.json());
            }

            setLoading(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load Blitz data');
            setLoading(false);
        }
    };

    const toggleBot = async () => {
        if (!status?.enabled && !showWarningModal) {
            setShowWarningModal(true);
            return;
        }

        try {
            setEnabling(true);
            setError(null);
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();
            const newEnabledState = !status?.enabled;

            const res = await fetch(`${apiUrl}/api/intraday/enable`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ enabled: newEnabledState })
            });

            if (res.ok) {
                alert(`Blitz ${newEnabledState ? 'ENABLED' : 'DISABLED'} successfully!`);
                setShowWarningModal(false);
                setTimeout(() => loadBotData(), 500);
            } else {
                const errorText = await res.text();
                alert(`Failed to toggle Blitz: ${errorText}`);
                setError('Failed to toggle Blitz: ' + errorText);
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : 'Unknown error';
            alert(`Error toggling Blitz: ${errorMsg}`);
            setError('Failed to toggle Blitz: ' + errorMsg);
        } finally {
            setEnabling(false);
        }
    };

    const manualScan = async () => {
        try {
            setScanning(true);
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();

            const res = await fetch(`${apiUrl}/api/intraday/manual-scan`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.ok) {
                alert('Manual Blitz scan completed!');
                await loadBotData();
            } else {
                const errorText = await res.text();
                alert(`Manual scan failed: ${errorText}`);
            }
        } catch (err) {
            alert('Failed to trigger manual scan');
        } finally {
            setScanning(false);
        }
    };

    const closePosition = async (symbol: string) => {
        if (!confirm(`Close Blitz position in ${symbol}?`)) return;
        try {
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();
            const res = await fetch(`${apiUrl}/api/intraday/close-position/${symbol}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (res.ok) {
                await loadBotData();
            } else {
                const errorText = await res.text();
                alert(`Failed to close position: ${errorText}`);
            }
        } catch (err) {
            alert('Failed to close position');
        }
    };

    const saveSettings = async () => {
        if (!formConfig) return;
        try {
            setSettingsLoading(true);
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();
            const res = await fetch(`${apiUrl}/api/intraday/config`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(formConfig)
            });
            if (res.ok) {
                setSettingsChanged(false);
                await loadBotData();
            } else {
                const errorText = await res.text();
                alert(`Failed to save settings: ${errorText}`);
            }
        } catch (err) {
            alert('Failed to save settings');
        } finally {
            setSettingsLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-96">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-yellow-500 mx-auto mb-4"></div>
                    <p className="text-gray-600 dark:text-gray-400">Loading Blitz...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-6 bg-red-50 dark:bg-red-900/20 rounded-lg">
                <p className="text-red-600 dark:text-red-400">{error}</p>
            </div>
        );
    }

    const allocation = Number(status?.config?.allocation_amount) || 0;
    const deployed = (status?.positions || []).reduce((sum, p) => {
        const value = Number(p.market_value) || Number(p.quantity) * Number(p.average_price) || 0;
        return sum + value;
    }, 0);
    const deployedPct = allocation > 0 ? Math.min(100, (deployed / allocation) * 100) : 0;

    return (
        <div className="space-y-4 p-4">
            {/* Header & Controls */}
            <div className="bg-gradient-to-r from-amber-500 to-orange-600 rounded-lg p-6 text-white">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2">
                            ⚡ Blitz — Intraday Trading
                            <span className={`text-sm px-3 py-1 rounded-full ${status?.enabled ? 'bg-green-500' : 'bg-gray-500'}`}>
                                {status?.enabled ? 'ACTIVE' : 'DISABLED'}
                            </span>
                        </h2>
                        <p className="text-orange-100 text-sm mt-1">
                            {status?.scheduler?.marketOpen ? '🟢 Market Open' : '🔴 Market Closed'} • 1-min cycle • Fixed capital, separate from Swing
                        </p>
                    </div>
                    <div className="flex gap-2">
                        <button
                            onClick={toggleBot}
                            disabled={enabling}
                            className={`px-4 py-2 rounded-lg font-semibold transition-colors ${
                                status?.enabled
                                    ? 'bg-red-500 hover:bg-red-600'
                                    : 'bg-green-500 hover:bg-green-600'
                            } text-white disabled:opacity-50`}
                        >
                            {enabling ? 'Processing...' : status?.enabled ? 'Disable Blitz' : 'Enable Blitz'}
                        </button>
                        <button
                            onClick={manualScan}
                            disabled={scanning}
                            className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg font-semibold transition-colors disabled:opacity-50"
                        >
                            🔍 {scanning ? 'Scanning...' : 'Manual Scan'}
                        </button>
                    </div>
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="bg-white/10 rounded-lg p-4">
                        <div className="text-sm opacity-90">Today's P/L</div>
                        <div className={`text-3xl font-bold ${(Number(status?.todayPnl) || 0) >= 0 ? 'text-green-300' : 'text-red-300'}`}>
                            ${(Number(status?.todayPnl) || 0).toFixed(2)}
                        </div>
                        <div className="text-xs opacity-75">Limit: ${Number(status?.config?.daily_loss_limit) || 0}</div>
                    </div>
                    <div className="bg-white/10 rounded-lg p-4">
                        <div className="text-sm opacity-90">Open Positions</div>
                        <div className="text-3xl font-bold">{status?.openPositions || 0}</div>
                        <div className="text-xs opacity-75">Max: {status?.config?.max_open_positions}</div>
                    </div>
                    <div className="bg-white/10 rounded-lg p-4">
                        <div className="text-sm opacity-90">Win Rate (7d)</div>
                        <div className="text-3xl font-bold">
                            {performance?.winRate?.toFixed(0) || '0'}%
                        </div>
                        <div className="text-xs opacity-75">{performance?.totalTrades || 0} trades</div>
                    </div>
                    <div className="bg-white/10 rounded-lg p-4">
                        <div className="text-sm opacity-90">Trades Today</div>
                        <div className="text-3xl font-bold">{status?.tradesToday || 0}</div>
                        <div className="text-xs opacity-75">Max: {status?.config?.max_daily_trades}/day</div>
                    </div>
                </div>

                {/* Capital Deployed */}
                <div className="mt-4 bg-white/10 rounded-lg p-4">
                    <div className="flex items-center justify-between text-sm mb-2">
                        <span className="font-semibold">💰 Capital Deployed</span>
                        <span>${deployed.toFixed(2)} / ${allocation.toFixed(2)}</span>
                    </div>
                    <div className="w-full bg-white/20 rounded-full h-3">
                        <div
                            className={`h-3 rounded-full ${deployedPct >= 90 ? 'bg-red-400' : deployedPct >= 60 ? 'bg-yellow-400' : 'bg-green-400'}`}
                            style={{ width: `${deployedPct}%` }}
                        ></div>
                    </div>
                    <div className="text-xs opacity-75 mt-1">
                        This is a fixed dollar allocation, separate from Swing's capital. Both share the same Alpaca account.
                    </div>
                </div>
            </div>

            {/* Universe */}
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
                <h3 className="font-bold text-lg mb-2 text-gray-800 dark:text-white">📋 Fixed Trading Universe</h3>
                <div className="flex flex-wrap gap-2">
                    {(status?.universe || []).map(sym => (
                        <span key={sym} className="px-3 py-1 bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300 rounded-full text-sm font-semibold">
                            {sym}
                        </span>
                    ))}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    Blitz only trades this small, liquid list — kept deliberately narrow to control risk and API load.
                </p>
            </div>

            {/* Open Positions */}
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
                <h3 className="font-bold text-lg mb-3 text-gray-800 dark:text-white">
                    📈 Open Positions ({status?.positions?.length || 0})
                </h3>
                {(!status?.positions || status.positions.length === 0) ? (
                    <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                        <p>No open Blitz positions</p>
                        <p className="text-sm mt-1">Bot will open positions during next scan while market is open</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-gray-50 dark:bg-gray-700">
                                <tr>
                                    <th className="px-4 py-2 text-left">Symbol</th>
                                    <th className="px-4 py-2 text-right">Qty</th>
                                    <th className="px-4 py-2 text-right">Entry</th>
                                    <th className="px-4 py-2 text-right">Current</th>
                                    <th className="px-4 py-2 text-right">P/L</th>
                                    <th className="px-4 py-2 text-right">Stop</th>
                                    <th className="px-4 py-2 text-right">Target</th>
                                    <th className="px-4 py-2"></th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                                {status.positions.map((pos) => (
                                    <tr key={pos.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                        <td className="px-4 py-2 font-semibold">{pos.symbol}</td>
                                        <td className="px-4 py-2 text-right">{pos.quantity}</td>
                                        <td className="px-4 py-2 text-right">${Number(pos.average_price).toFixed(2)}</td>
                                        <td className="px-4 py-2 text-right">${Number(pos.current_price || pos.average_price).toFixed(2)}</td>
                                        <td className={`px-4 py-2 text-right font-semibold ${(pos.gain_loss || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                            ${Number(pos.gain_loss || 0).toFixed(2)}
                                        </td>
                                        <td className="px-4 py-2 text-right">{pos.stop_loss_price ? `$${Number(pos.stop_loss_price).toFixed(2)}` : '—'}</td>
                                        <td className="px-4 py-2 text-right">{pos.take_profit_price ? `$${Number(pos.take_profit_price).toFixed(2)}` : '—'}</td>
                                        <td className="px-4 py-2 text-right">
                                            <button
                                                onClick={() => closePosition(pos.symbol)}
                                                className="px-2 py-1 bg-red-100 hover:bg-red-200 text-red-700 rounded text-xs font-semibold"
                                            >
                                                Close
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Settings */}
            {formConfig && (
                <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
                    <h3 className="font-bold text-lg mb-3 text-gray-800 dark:text-white">⚙️ Blitz Settings</h3>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                        <div>
                            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Allocation ($)</label>
                            <input type="number" min={0} step={50}
                                value={formConfig.allocation_amount}
                                onChange={e => { setFormConfig({ ...formConfig, allocation_amount: Number(e.target.value) }); setSettingsChanged(true); }}
                                disabled={settingsLoading}
                                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        </div>
                        <div>
                            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Max Position ($)</label>
                            <input type="number" min={0} step={25}
                                value={formConfig.max_position_notional}
                                onChange={e => { setFormConfig({ ...formConfig, max_position_notional: Number(e.target.value) }); setSettingsChanged(true); }}
                                disabled={settingsLoading}
                                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        </div>
                        <div>
                            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Max Open Positions</label>
                            <input type="number" min={1} max={10} step={1}
                                value={formConfig.max_open_positions}
                                onChange={e => { setFormConfig({ ...formConfig, max_open_positions: Number(e.target.value) }); setSettingsChanged(true); }}
                                disabled={settingsLoading}
                                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        </div>
                        <div>
                            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Max Daily Trades</label>
                            <input type="number" min={1} max={50} step={1}
                                value={formConfig.max_daily_trades}
                                onChange={e => { setFormConfig({ ...formConfig, max_daily_trades: Number(e.target.value) }); setSettingsChanged(true); }}
                                disabled={settingsLoading}
                                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        </div>
                        <div>
                            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Daily Loss Limit ($)</label>
                            <input type="number" max={0} step={10}
                                value={formConfig.daily_loss_limit}
                                onChange={e => { setFormConfig({ ...formConfig, daily_loss_limit: Number(e.target.value) }); setSettingsChanged(true); }}
                                disabled={settingsLoading}
                                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        </div>
                        <div>
                            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Stop Loss (%)</label>
                            <input type="number" min={0.1} max={10} step={0.1}
                                value={formConfig.stop_loss_percent}
                                onChange={e => { setFormConfig({ ...formConfig, stop_loss_percent: Number(e.target.value) }); setSettingsChanged(true); }}
                                disabled={settingsLoading}
                                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        </div>
                        <div>
                            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Take Profit (%)</label>
                            <input type="number" min={0.1} max={20} step={0.1}
                                value={formConfig.take_profit_percent}
                                onChange={e => { setFormConfig({ ...formConfig, take_profit_percent: Number(e.target.value) }); setSettingsChanged(true); }}
                                disabled={settingsLoading}
                                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        </div>
                        <div>
                            <label className="block text-sm text-gray-600 dark:text-gray-400 mb-1">Min Score</label>
                            <input type="number" min={0} max={100} step={1}
                                value={formConfig.min_score}
                                onChange={e => { setFormConfig({ ...formConfig, min_score: Number(e.target.value) }); setSettingsChanged(true); }}
                                disabled={settingsLoading}
                                className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white" />
                        </div>
                    </div>
                    <label className="flex items-center gap-2 mt-4 text-sm text-gray-700 dark:text-gray-300">
                        <input type="checkbox"
                            checked={formConfig.force_flat_eod}
                            onChange={e => { setFormConfig({ ...formConfig, force_flat_eod: e.target.checked }); setSettingsChanged(true); }}
                            disabled={settingsLoading} />
                        Force-flatten all Blitz positions at 15:50 ET (no overnight risk)
                    </label>
                    <button onClick={saveSettings} disabled={settingsLoading || !settingsChanged}
                        className="mt-4 px-6 py-2.5 rounded-xl bg-amber-600 text-white font-bold hover:opacity-90 transition-opacity disabled:opacity-40">
                        {settingsLoading ? 'Saving…' : 'Save Blitz Settings'}
                    </button>
                </div>
            )}

            {/* Info Alert */}
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <div className="flex items-start gap-3">
                    <span className="text-2xl">ℹ️</span>
                    <div className="text-sm text-blue-800 dark:text-blue-200">
                        <p className="font-semibold mb-1">Separate from Swing Trading</p>
                        <p>
                            Blitz runs as its own agent with its own capital ceiling, its own positions table, and its own
                            scheduler (1-minute cycle during market hours). It shares your Alpaca account and market data
                            with your Swing bot, but never touches Swing's holdings or trades. Blitz positions are
                            force-flattened before the close by default.
                        </p>
                    </div>
                </div>
            </div>

            {/* Warning Modal */}
            {showWarningModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-gray-800 rounded-lg max-w-2xl w-full p-6 shadow-2xl">
                        <div className="flex items-start gap-4 mb-4">
                            <span className="text-5xl">⚠️</span>
                            <div>
                                <h2 className="text-2xl font-bold text-red-600 dark:text-red-400 mb-2">
                                    ⚠️ CRITICAL WARNING - Read Before Enabling
                                </h2>
                                <p className="text-gray-700 dark:text-gray-300 mb-3">
                                    You are about to enable <b>LIVE INTRADAY TRADING</b> with real money. Blitz will
                                    automatically open and close positions throughout the trading day without further
                                    confirmation, using a separate fixed-dollar capital allocation from the same Alpaca
                                    account as your Swing bot.
                                </p>
                            </div>
                        </div>

                        <div className="bg-red-50 dark:bg-red-900/20 border-2 border-red-500 rounded-lg p-4 mb-4">
                            <h3 className="font-bold text-red-700 dark:text-red-300 mb-2">⛔ Pre-Flight Checklist:</h3>
                            <div className="space-y-2 text-sm text-gray-800 dark:text-gray-200">
                                <div className="flex items-start gap-2">
                                    <span className="text-red-600">❌</span>
                                    <div><b>Track Record:</b> Blitz is a new module with no historical trades yet</div>
                                </div>
                                <div className="flex items-start gap-2">
                                    <span className="text-red-600">❌</span>
                                    <div><b>Capital at Risk:</b> Up to your configured allocation (${status?.config?.allocation_amount || 500} by default)</div>
                                </div>
                                <div className="flex items-start gap-2">
                                    <span className="text-red-600">❌</span>
                                    <div><b>Frequency:</b> Scans every minute during market hours — many more trades than Swing</div>
                                </div>
                            </div>
                        </div>

                        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-500 rounded-lg p-3 mb-4">
                            <p className="text-xs text-blue-800 dark:text-blue-200">
                                <b>Current Protection:</b> Max {status?.config?.max_open_positions} positions •
                                ${status?.config?.daily_loss_limit} daily loss limit •
                                Fixed universe of {status?.universe?.length || 0} liquid symbols •
                                Force-flatten at 15:50 ET
                            </p>
                        </div>

                        <div className="flex gap-3">
                            <button
                                onClick={() => setShowWarningModal(false)}
                                className="flex-1 px-4 py-3 bg-gray-300 hover:bg-gray-400 text-gray-800 rounded-lg font-semibold"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={toggleBot}
                                disabled={enabling}
                                className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold disabled:opacity-50"
                            >
                                {enabling ? 'Enabling...' : 'I Understand the Risks - Enable Blitz'}
                            </button>
                        </div>

                        <p className="text-xs text-center text-gray-500 mt-3">
                            Intraday trading involves substantial risk of loss. Past performance does not guarantee future results.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
