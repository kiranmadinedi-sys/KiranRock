'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

interface OptionPosition {
    id: number;
    symbol: string;
    strike: number;
    expiration: string;
    option_type: string;
    contracts: number;
    entry_price: number;
    exit_price?: number;
    entry_date: string;
    strategy: string;
    status: string;
    profit_loss?: number;
    greeks_at_entry: any;
}

interface BotConfig {
    enabled: boolean;
    scalping_enabled: boolean;
    swing_enabled: boolean;
    spreads_enabled: boolean;
    max_open_positions: number;
    max_daily_loss: number;
    take_profit_percent: number;
    stop_loss_percent: number;
}

interface BotStatus {
    enabled: boolean;
    config: BotConfig | null;
    openPositions: number;
    todayPerformance: any;
    scheduler: any;
    vix: any;
}

export default function OptionsBotView() {
    const [status, setStatus] = useState<BotStatus | null>(null);
    const [positions, setPositions] = useState<OptionPosition[]>([]);
    const [performance, setPerformance] = useState<any>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [enabling, setEnabling] = useState(false);
    const [showWarningModal, setShowWarningModal] = useState(false);

    useEffect(() => {
        loadBotData();
        const interval = setInterval(loadBotData, 30000); // Refresh every 30 seconds
        return () => clearInterval(interval);
    }, []);

    const loadBotData = async () => {
        try {
            const token = localStorage.getItem('token');
            if (!token) {
                console.log('[Options Bot] No token found');
                setError('Please login to use Options Bot');
                setLoading(false);
                return;
            }

            const apiUrl = getApiBaseUrl();
            console.log('[Options Bot] Loading data from:', apiUrl);

            // Load status
            const statusRes = await fetch(`${apiUrl}/api/options-bot/status`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            
            console.log('[Options Bot] Status response:', statusRes.status);
            
            if (statusRes.ok) {
                const statusData = await statusRes.json();
                console.log('[Options Bot] Status data:', statusData);
                setStatus(statusData);
            } else {
                const errorText = await statusRes.text();
                console.error('[Options Bot] Status fetch failed:', statusRes.status, errorText);
            }

            // Load positions
            const positionsRes = await fetch(`${apiUrl}/api/options-bot/positions`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (positionsRes.ok) {
                const positionsData = await positionsRes.json();
                console.log('[Options Bot] Positions:', positionsData.length);
                setPositions(positionsData);
            }

            // Load performance
            const perfRes = await fetch(`${apiUrl}/api/options-bot/performance?period=week`, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            if (perfRes.ok) {
                const perfData = await perfRes.json();
                setPerformance(perfData);
            }

            setLoading(false);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load bot data');
            setLoading(false);
        }
    };

    const toggleBot = async () => {
        // If enabling bot, show warning first
        if (!status?.enabled && !showWarningModal) {
            setShowWarningModal(true);
            return;
        }

        try {
            setEnabling(true);
            setError(null); // Clear previous errors
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();
            const newEnabledState = !status?.enabled;

            console.log('[Options Bot] Toggling bot...', { 
                currentState: status?.enabled, 
                newState: newEnabledState,
                apiUrl,
                hasToken: !!token 
            });

            if (!token) {
                throw new Error('No authentication token found');
            }

            const res = await fetch(`${apiUrl}/api/options-bot/enable`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ enabled: newEnabledState })
            });

            console.log('[Options Bot] API Response:', res.status, res.statusText);

            if (res.ok) {
                const result = await res.json();
                console.log('[Options Bot] Toggle successful:', result);
                
                // Update status immediately with new state
                if (status && status.config) {
                    setStatus({ 
                        ...status, 
                        enabled: newEnabledState,
                        config: { ...status.config, enabled: newEnabledState }
                    });
                }
                
                // Show success message
                alert(`Options Bot ${newEnabledState ? 'ENABLED' : 'DISABLED'} successfully!`);
                
                // Reload full data after a short delay
                setTimeout(() => loadBotData(), 500);
                setShowWarningModal(false);
            } else {
                const errorText = await res.text();
                console.error('[Options Bot] Toggle failed:', res.status, errorText);
                alert(`Failed to toggle bot: ${errorText}`);
                setError('Failed to toggle bot: ' + errorText);
            }
        } catch (err) {
            console.error('[Options Bot] Toggle error:', err);
            const errorMsg = err instanceof Error ? err.message : 'Unknown error';
            alert(`Error toggling bot: ${errorMsg}`);
            setError('Failed to toggle bot: ' + errorMsg);
        } finally {
            setEnabling(false);
        }
    };

    const manualScan = async () => {
        try {
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();

            const res = await fetch(`${apiUrl}/api/options-bot/manual-scan`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` }
            });

            if (res.ok) {
                alert('Manual scan completed! Check your Telegram for results.');
                await loadBotData();
            }
        } catch (err) {
            alert('Failed to trigger manual scan');
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-96">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                    <p className="text-gray-600 dark:text-gray-400">Loading Options Bot...</p>
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

    const strategyEmoji: Record<string, string> = {
        deltaNeutralScalping: '⚡',
        directionalSwing: '🎯',
        creditSpreads: '💰',
        protectivePuts: '🛡️'
    };

    return (
        <div className="space-y-4 p-4">
            {/* Header & Controls */}
            <div className="bg-gradient-to-r from-purple-600 to-indigo-600 rounded-lg p-6 text-white">
                <div className="flex items-center justify-between mb-4">
                    <div>
                        <h2 className="text-2xl font-bold flex items-center gap-2">
                            🤖 Autonomous Options Bot
                            <span className={`text-sm px-3 py-1 rounded-full ${status?.enabled ? 'bg-green-500' : 'bg-gray-500'}`}>
                                {status?.enabled ? 'ACTIVE' : 'DISABLED'}
                            </span>
                        </h2>
                        <p className="text-purple-100 text-sm mt-1">
                            {status?.scheduler?.marketOpen ? '🟢 Market Open' : '🔴 Market Closed'} • 
                            VIX: {status?.vix?.value?.toFixed(2)} ({status?.vix?.regime})
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
                            {enabling ? 'Processing...' : status?.enabled ? 'Disable Bot' : 'Enable Bot'}
                        </button>
                        <button
                            onClick={manualScan}
                            className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-lg font-semibold transition-colors"
                        >
                            🔍 Manual Scan
                        </button>
                    </div>
                </div>

                {/* Stats Grid */}
                <div className="grid grid-cols-4 gap-4">
                    <div className="bg-white/10 rounded-lg p-4">
                        <div className="text-sm opacity-90">Open Positions</div>
                        <div className="text-3xl font-bold">{status?.openPositions || 0}</div>
                        <div className="text-xs opacity-75">Max: {status?.config?.max_open_positions}</div>
                    </div>
                    <div className="bg-white/10 rounded-lg p-4">
                        <div className="text-sm opacity-90">Today's P/L</div>
                        <div className={`text-3xl font-bold ${
                            (status?.todayPerformance?.total_pnl || 0) >= 0 ? 'text-green-300' : 'text-red-300'
                        }`}>
                            ${status?.todayPerformance?.total_pnl?.toFixed(2) || '0.00'}
                        </div>
                        <div className="text-xs opacity-75">
                            Limit: ${status?.config?.max_daily_loss || 1000}
                        </div>
                    </div>
                    <div className="bg-white/10 rounded-lg p-4">
                        <div className="text-sm opacity-90">Risk Per Trade</div>
                        <div className="text-3xl font-bold">
                            {(status?.config as any)?.risk_per_trade_percent || 1.5}%
                        </div>
                        <div className="text-xs opacity-75">
                            Of account balance
                        </div>
                    </div>
                    <div className="bg-white/10 rounded-lg p-4">
                        <div className="text-sm opacity-90">Next Scan</div>
                        <div className="text-xl font-bold">
                            {status?.scheduler?.nextScans?.[0] || 'Market Closed'}
                        </div>
                        <div className="text-xs opacity-75">Auto-scan 4x daily</div>
                    </div>
                </div>

                {/* VIX Regime Rules */}
                <div className="mt-4 bg-white/10 rounded-lg p-4">
                    <h4 className="font-semibold mb-2 flex items-center gap-2">
                        🌡️ VIX Regime: {status?.vix?.regime?.toUpperCase() || 'UNKNOWN'}
                        <span className="text-xl ml-2">{status?.vix?.value?.toFixed(2) || '0'}</span>
                    </h4>
                    <div className="grid grid-cols-3 gap-3 text-sm">
                        <div className={`p-2 rounded ${
                            (status?.vix?.value || 0) < 15 ? 'bg-green-500/30' : 'bg-gray-500/20'
                        }`}>
                            <div className="font-semibold">🟢 LOW (VIX &lt; 15)</div>
                            <div className="text-xs mt-1">• Full position sizing</div>
                            <div className="text-xs">• All strategies enabled</div>
                            <div className="text-xs">• Credit spreads favored</div>
                        </div>
                        <div className={`p-2 rounded ${
                            (status?.vix?.value || 0) >= 15 && (status?.vix?.value || 0) < 25 ? 'bg-yellow-500/30' : 'bg-gray-500/20'
                        }`}>
                            <div className="font-semibold">🟡 NORMAL (15-25)</div>
                            <div className="text-xs mt-1">• Standard sizing</div>
                            <div className="text-xs">• Balanced approach</div>
                            <div className="text-xs">• All strategies active</div>
                        </div>
                        <div className={`p-2 rounded ${
                            (status?.vix?.value || 0) >= 25 ? 'bg-red-500/30' : 'bg-gray-500/20'
                        }`}>
                            <div className="font-semibold">🔴 HIGH (VIX &gt; 25)</div>
                            <div className="text-xs mt-1">• 50% position size</div>
                            <div className="text-xs">• Wider stops (+10%)</div>
                            <div className="text-xs">• Protective hedging increased</div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Strategy Definitions - Institutional Grade */}
            {status?.config && (
                <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
                    <h3 className="font-bold text-lg mb-3 text-gray-800 dark:text-white">📊 Strategy Definitions</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Delta-Neutral Scalping */}
                        <div className={`p-4 rounded-lg border-2 ${
                            status.config.scalping_enabled
                                ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                                : 'border-gray-300 bg-gray-50 dark:bg-gray-700'
                        }`}>
                            <div className="flex items-center justify-between mb-2">
                                <div className="font-bold text-base">⚡ Delta-Neutral Scalping</div>
                                <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                    status.config.scalping_enabled ? 'bg-green-600 text-white' : 'bg-gray-400 text-white'
                                }`}>
                                    {status.config.scalping_enabled ? 'ACTIVE' : 'OFF'}
                                </span>
                            </div>
                            <div className="text-xs text-gray-700 dark:text-gray-300 space-y-1">
                                <div>• <b>Structure:</b> ATM straddles/strangles</div>
                                <div>• <b>Delta Range:</b> -0.05 to +0.05 (neutral)</div>
                                <div>• <b>DTE:</b> 0-7 days (short-term)</div>
                                <div>• <b>Capital:</b> 30% allocation</div>
                                <div>• <b>Risk:</b> 1-2% per trade</div>
                                <div>• <b>Target:</b> 20% profit, 15% stop</div>
                                <div>• <b>Vega:</b> Positive (profits from IV expansion)</div>
                            </div>
                        </div>

                        {/* Directional Swing */}
                        <div className={`p-4 rounded-lg border-2 ${
                            status.config.swing_enabled
                                ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                                : 'border-gray-300 bg-gray-50 dark:bg-gray-700'
                        }`}>
                            <div className="flex items-center justify-between mb-2">
                                <div className="font-bold text-base">🎯 Directional Swing</div>
                                <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                    status.config.swing_enabled ? 'bg-green-600 text-white' : 'bg-gray-400 text-white'
                                }`}>
                                    {status.config.swing_enabled ? 'ACTIVE' : 'OFF'}
                                </span>
                            </div>
                            <div className="text-xs text-gray-700 dark:text-gray-300 space-y-1">
                                <div>• <b>Structure:</b> ITM/ATM calls or puts</div>
                                <div>• <b>Delta Range:</b> 0.60-0.80 (directional)</div>
                                <div>• <b>DTE:</b> 14-45 days (medium-term)</div>
                                <div>• <b>Capital:</b> 40% allocation</div>
                                <div>• <b>Risk:</b> 2% per trade</div>
                                <div>• <b>Target:</b> 35% profit, 25% stop</div>
                                <div>• <b>Entry:</b> Momentum + volume confirmation</div>
                            </div>
                        </div>

                        {/* Credit Spreads */}
                        <div className={`p-4 rounded-lg border-2 ${
                            status.config.spreads_enabled
                                ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                                : 'border-gray-300 bg-gray-50 dark:bg-gray-700'
                        }`}>
                            <div className="flex items-center justify-between mb-2">
                                <div className="font-bold text-base">💰 Credit Spreads</div>
                                <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                    status.config.spreads_enabled ? 'bg-green-600 text-white' : 'bg-gray-400 text-white'
                                }`}>
                                    {status.config.spreads_enabled ? 'ACTIVE' : 'OFF'}
                                </span>
                            </div>
                            <div className="text-xs text-gray-700 dark:text-gray-300 space-y-1">
                                <div>• <b>Structure:</b> Bull/Bear credit spreads</div>
                                <div>• <b>Delta:</b> Short leg at 0.20-0.30</div>
                                <div>• <b>Width:</b> $5 spread on stocks</div>
                                <div>• <b>DTE:</b> 30-45 days</div>
                                <div>• <b>Capital:</b> 20% allocation</div>
                                <div>• <b>Risk:</b> 1% per trade</div>
                                <div>• <b>Target:</b> 50% max profit or 21 DTE exit</div>
                            </div>
                        </div>

                        {/* Protective Hedging */}
                        <div className="p-4 rounded-lg border-2 border-blue-500 bg-blue-50 dark:bg-blue-900/20">
                            <div className="flex items-center justify-between mb-2">
                                <div className="font-bold text-base">🛡️ Protective Hedging</div>
                                <span className="px-2 py-1 rounded text-xs font-semibold bg-blue-600 text-white">
                                    ALWAYS ON
                                </span>
                            </div>
                            <div className="text-xs text-gray-700 dark:text-gray-300 space-y-1">
                                <div>• <b>Structure:</b> OTM puts on SPY/QQQ</div>
                                <div>• <b>Delta:</b> 0.05-0.15 (deep OTM)</div>
                                <div>• <b>DTE:</b> 30-60 days</div>
                                <div>• <b>Capital:</b> 10% allocation</div>
                                <div>• <b>Purpose:</b> Portfolio insurance</div>
                                <div>• <b>Trigger:</b> VIX spike &gt;30 or position loss &gt;5%</div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Open Positions */}
            <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
                <h3 className="font-bold text-lg mb-3 text-gray-800 dark:text-white">
                    📈 Open Positions ({positions.length})
                </h3>
                {positions.length === 0 ? (
                    <div className="text-center py-8 text-gray-500 dark:text-gray-400">
                        <p>No open positions</p>
                        <p className="text-sm mt-1">Bot will open positions during next scan</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                            <thead className="bg-gray-50 dark:bg-gray-700">
                                <tr>
                                    <th className="px-4 py-2 text-left">Strategy</th>
                                    <th className="px-4 py-2 text-left">Symbol</th>
                                    <th className="px-4 py-2 text-left">Type</th>
                                    <th className="px-4 py-2 text-right">Strike</th>
                                    <th className="px-4 py-2 text-left">Exp</th>
                                    <th className="px-4 py-2 text-right">Contracts</th>
                                    <th className="px-4 py-2 text-right">Entry</th>
                                    <th className="px-4 py-2 text-right">Delta</th>
                                    <th className="px-4 py-2 text-left">Days</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                                {positions.map((pos) => (
                                    <tr key={pos.id} className="hover:bg-gray-50 dark:hover:bg-gray-700">
                                        <td className="px-4 py-2">
                                            <span className="text-lg">{strategyEmoji[pos.strategy] || '📊'}</span>
                                        </td>
                                        <td className="px-4 py-2 font-semibold">{pos.symbol}</td>
                                        <td className="px-4 py-2">
                                            <span className={`px-2 py-1 rounded text-xs ${
                                                pos.option_type === 'CALL'
                                                    ? 'bg-green-100 text-green-700'
                                                    : 'bg-red-100 text-red-700'
                                            }`}>
                                                {pos.option_type}
                                            </span>
                                        </td>
                                        <td className="px-4 py-2 text-right">${pos.strike.toFixed(2)}</td>
                                        <td className="px-4 py-2">{pos.expiration}</td>
                                        <td className="px-4 py-2 text-right">{pos.contracts}</td>
                                        <td className="px-4 py-2 text-right">${pos.entry_price.toFixed(2)}</td>
                                        <td className="px-4 py-2 text-right">
                                            {pos.greeks_at_entry?.delta?.toFixed(3) || 'N/A'}
                                        </td>
                                        <td className="px-4 py-2">
                                            {Math.floor((Date.now() - new Date(pos.entry_date).getTime()) / (1000 * 60 * 60 * 24))}d
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>

            {/* Performance Summary */}
            {performance && (
                <div className="bg-white dark:bg-gray-800 rounded-lg p-4 shadow">
                    <div className="flex items-center justify-between mb-3">
                        <h3 className="font-bold text-lg text-gray-800 dark:text-white">📊 Week Performance</h3>
                        <a
                            href="/backtest?type=options"
                            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded-lg font-semibold transition-colors"
                        >
                            📈 View Full Analysis
                        </a>
                    </div>
                    <div className="grid grid-cols-4 gap-4">
                        <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                            <div className="text-sm text-gray-600 dark:text-gray-400">Total Trades</div>
                            <div className="text-2xl font-bold">{performance.overall?.total_trades || 0}</div>
                        </div>
                        <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                            <div className="text-sm text-gray-600 dark:text-gray-400">Win Rate</div>
                            <div className="text-2xl font-bold text-green-600">
                                {performance.overall?.win_rate?.toFixed(1) || '0'}%
                            </div>
                        </div>
                        <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                            <div className="text-sm text-gray-600 dark:text-gray-400">Total P/L</div>
                            <div className={`text-2xl font-bold ${
                                (performance.overall?.total_pnl || 0) >= 0 ? 'text-green-600' : 'text-red-600'
                            }`}>
                                ${performance.overall?.total_pnl?.toFixed(2) || '0.00'}
                            </div>
                        </div>
                        <div className="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                            <div className="text-sm text-gray-600 dark:text-gray-400">Avg Win</div>
                            <div className="text-2xl font-bold text-green-600">
                                ${performance.overall?.avg_win?.toFixed(2) || '0.00'}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Event Filters & Risk Controls */}
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                <div className="flex items-start gap-3">
                    <span className="text-2xl">⚠️</span>
                    <div className="text-sm text-amber-800 dark:text-amber-200">
                        <p className="font-semibold mb-2">Event Filters & Protection</p>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                            <div className="flex items-center gap-1">
                                <span className="text-green-600">✓</span> Earnings blackout (±2 days)
                            </div>
                            <div className="flex items-center gap-1">
                                <span className="text-green-600">✓</span> FOMC day protection
                            </div>
                            <div className="flex items-center gap-1">
                                <span className="text-green-600">✓</span> CPI/Jobs report avoidance
                            </div>
                            <div className="flex items-center gap-1">
                                <span className="text-green-600">✓</span> Ex-dividend adjustment
                            </div>
                        </div>
                        <p className="mt-2 text-xs">
                            Bot automatically avoids trading around high-risk events to prevent volatility-driven losses.
                        </p>
                    </div>
                </div>
            </div>

            {/* Info Alert */}
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                <div className="flex items-start gap-3">
                    <span className="text-2xl">ℹ️</span>
                    <div className="text-sm text-blue-800 dark:text-blue-200">
                        <p className="font-semibold mb-1">Autonomous Options Trading</p>
                        <p>Bot automatically scans market at 09:45, 11:00, 13:00, and 15:00 ET. It executes trades based on Greeks analysis and monitors positions every 5 minutes. Telegram alerts are sent for all trading events.</p>
                        <p className="mt-2 text-xs opacity-75">
                            Min Balance: $10,000 • Max Positions: {status?.config?.max_open_positions} • 
                            Daily Loss Limit: ${status?.config?.max_daily_loss} • Risk Per Trade: 1-2%
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
                                    You are about to enable <b>LIVE OPTIONS TRADING</b> with real money. 
                                    This bot will automatically execute trades without further confirmation.
                                </p>
                            </div>
                        </div>

                        <div className="bg-red-50 dark:bg-red-900/20 border-2 border-red-500 rounded-lg p-4 mb-4">
                            <h3 className="font-bold text-red-700 dark:text-red-300 mb-2">⛔ Pre-Flight Checklist:</h3>
                            <div className="space-y-2 text-sm text-gray-800 dark:text-gray-200">
                                <div className="flex items-start gap-2">
                                    <span className="text-red-600">❌</span>
                                    <div><b>Backtest Status:</b> NOT VALIDATED (0 historical trades)</div>
                                </div>
                                <div className="flex items-start gap-2">
                                    <span className="text-red-600">❌</span>
                                    <div><b>Paper Trading:</b> NOT COMPLETED (recommended 2-4 weeks)</div>
                                </div>
                                <div className="flex items-start gap-2">
                                    <span className="text-red-600">❌</span>
                                    <div><b>Max Drawdown:</b> UNKNOWN (need 200+ trades to measure)</div>
                                </div>
                                <div className="flex items-start gap-2">
                                    <span className="text-red-600">❌</span>
                                    <div><b>Profit Factor:</b> UNPROVEN (no historical data)</div>
                                </div>
                            </div>
                        </div>

                        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-500 rounded-lg p-4 mb-4">
                            <h3 className="font-bold text-yellow-700 dark:text-yellow-300 mb-2">💡 What You Should Do First:</h3>
                            <ol className="list-decimal list-inside space-y-1 text-sm text-gray-800 dark:text-gray-200">
                                <li>Run 1-year backtest on historical data (200-500+ trades)</li>
                                <li>Paper trade for 2-4 weeks to validate real-time execution</li>
                                <li>Verify max drawdown is acceptable for your risk tolerance</li>
                                <li>Confirm profit factor &gt; 1.5 and win rate &gt; 55%</li>
                                <li>Start with minimal capital ($1,000-$2,000) for 1 month</li>
                            </ol>
                        </div>

                        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-500 rounded-lg p-3 mb-4">
                            <p className="text-xs text-blue-800 dark:text-blue-200">
                                <b>Current Protection:</b> Max {status?.config?.max_open_positions} positions • 
                                ${status?.config?.max_daily_loss} daily loss limit • Risk per trade: 1-2% • 
                                Event filters active (earnings, FOMC, CPI) • VIX-based position sizing
                            </p>
                        </div>

                        <div className="flex gap-3">
                            <button
                                onClick={() => setShowWarningModal(false)}
                                className="flex-1 px-4 py-3 bg-gray-300 hover:bg-gray-400 text-gray-800 rounded-lg font-semibold"
                            >
                                Cancel - I'll Backtest First
                            </button>
                            <button
                                onClick={toggleBot}
                                disabled={enabling}
                                className="flex-1 px-4 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold disabled:opacity-50"
                            >
                                {enabling ? 'Enabling...' : 'I Understand the Risks - Enable Bot'}
                            </button>
                        </div>

                        <p className="text-xs text-center text-gray-500 mt-3">
                            Options trading involves substantial risk of loss. Past performance does not guarantee future results.
                        </p>
                    </div>
                </div>
            )}
        </div>
    );
}
