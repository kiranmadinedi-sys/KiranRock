'use client';
import { getApiBaseUrl } from '../config';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import AppHeader from '../components/AppHeader';

export default function AITradingPage() {
    const router = useRouter();
    const [token, setToken] = useState(null);
    const [loading, setLoading] = useState(true);
    const [aiStatus, setAIStatus] = useState(null);
    const [recommendations, setRecommendations] = useState([]);
    const [processing, setProcessing] = useState(false);
    const [message, setMessage] = useState(null);

    // AI Trading Settings State
    const [settingsLoading, setSettingsLoading] = useState(true);
    const [aiSettings, setAISettings] = useState({ stopLoss: 0.06, takeProfit: 0.3, minCashReserve: 0 });
    const [settingsChanged, setSettingsChanged] = useState(false);

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        if (!storedToken) {
            router.push('/login');
        } else {
            setToken(storedToken);
        }
    }, [router]);

    useEffect(() => {
        if (token) {
            loadAIData();
            fetchAISettings();
            // Poll for live AI status and recommendations every 2 seconds
            const pollInterval = setInterval(() => {
                fetchAIStatus();
                fetchRecommendations();
            }, 2000);
            return () => clearInterval(pollInterval);
        }
    }, [token]);
    // Fetch user AI trading settings
    const fetchAISettings = async () => {
        setSettingsLoading(true);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/ai-trading/settings`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (response.ok) {
                const data = await response.json();
                setAISettings({
                    stopLoss: data.aiTradingSettings?.stopLoss ?? 0.06,
                    takeProfit: data.aiTradingSettings?.takeProfit ?? 0.3,
                    minCashReserve: data.aiTradingSettings?.minCashReserve ?? 0
                });
            }
        } catch (error) {
            console.error('Error fetching AI settings:', error);
        } finally {
            setSettingsLoading(false);
        }
    };

    // Save user AI trading settings
    const saveAISettings = async () => {
        setSettingsLoading(true);
        setMessage(null);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/ai-trading/settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    stopLoss: aiSettings.stopLoss,
                    takeProfit: aiSettings.takeProfit,
                    minCashReserve: aiSettings.minCashReserve
                })
            });
            const data = await response.json();
            if (response.ok) {
                setMessage({ type: 'success', text: 'AI trading settings saved!' });
                setSettingsChanged(false);
                await loadAIData();
            } else {
                setMessage({ type: 'error', text: data.error || 'Failed to save settings' });
            }
        } catch (error) {
            setMessage({ type: 'error', text: 'Error saving AI trading settings' });
        } finally {
            setSettingsLoading(false);
        }
    };

    const loadAIData = async () => {
        setLoading(true);
        try {
            await Promise.all([fetchAIStatus(), fetchRecommendations()]);
        } catch (error) {
            console.error('Failed to load AI data:', error);
        } finally {
            setLoading(false);
        }
    };

    const fetchAIStatus = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/ai-trading/status`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (response.ok) {
                const data = await response.json();
                setAIStatus(data);
            }
        } catch (error) {
            console.error('Error fetching AI status:', error);
        }
    };

    const fetchRecommendations = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/ai-trading/recommendations`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (response.ok) {
                const data = await response.json();
                setRecommendations(data.recommendations || []);
            }
        } catch (error) {
            console.error('Error fetching recommendations:', error);
        }
    };

    const handleInitializeAI = async () => {
        if (!confirm('AI will invest your balance across diversified stocks. Continue?')) {
            return;
        }

        setProcessing(true);
        setMessage(null);

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/ai-trading/initialize`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
            });

            const data = await response.json();

            if (response.ok) {
                setMessage({
                    type: 'success',
                    text: `${data.message}! Invested in ${data.executedTrades.length} stocks across ${data.diversification.sectors} sectors.`
                });
                await loadAIData();
            } else {
                setMessage({ type: 'error', text: data.error || 'Initialization failed' });
            }
        } catch (error) {
            setMessage({ type: 'error', text: 'Error initializing AI trading' });
        } finally {
            setProcessing(false);
        }
    };

    const handleRebalance = async () => {
        if (!confirm('AI will rebalance your portfolio. Continue?')) {
            return;
        }

        setProcessing(true);
        setMessage(null);

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/ai-trading/rebalance`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
            });

            const data = await response.json();

            if (response.ok) {
                const executedCount = data.actions?.filter(a => a.executed).length || 0;
                setMessage({
                    type: 'success',
                    text: `${data.message}! Executed ${executedCount} actions.`
                });
                await loadAIData();
            } else {
                setMessage({ type: 'error', text: data.error || 'Rebalancing failed' });
            }
        } catch (error) {
            setMessage({ type: 'error', text: 'Error rebalancing portfolio' });
        } finally {
            setProcessing(false);
        }
    };

    const handleLogout = () => {
        localStorage.removeItem('token');
        router.push('/login');
    };

    if (loading) {
        return (
            <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
                <div className="text-xl text-gray-600 dark:text-gray-300">Loading AI Trading...</div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900">
            <AppHeader showSearch={false} />

            {/* Main Content */}
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                <div className="mb-6">
                    <h1 className="text-3xl font-bold text-gray-900 dark:text-white">🤖 AI Trading Bot</h1>
                    <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                        Let AI manage your portfolio automatically with smart investment strategies
                    </p>
                </div>

                {message && (
                    <div className={`mb-6 p-4 rounded-lg ${
                        message.type === 'success' 
                            ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300'
                            : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300'
                    }`}>
                        {message.text}
                    </div>
                )}

                {/* AI Portfolio Status */}
                {aiStatus && (
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
                        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Value</div>
                            <div className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">
                                ${aiStatus.totalValue?.toFixed(2) || '0.00'}
                            </div>
                        </div>
                        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Invested</div>
                            <div className="mt-2 text-2xl font-bold text-blue-600">
                                ${aiStatus.investedValue?.toFixed(2) || '0.00'}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                {aiStatus.investedPercent}% of portfolio
                            </div>
                        </div>
                        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Cash Reserve</div>
                            <div className="mt-2 text-2xl font-bold text-green-600">
                                ${aiStatus.cashReserve?.toFixed(2) || '0.00'}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                                {aiStatus.cashReservePercent}% liquid
                            </div>
                        </div>
                        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Return</div>
                            <div className={`mt-2 text-2xl font-bold ${aiStatus.totalReturn >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                {aiStatus.totalReturn >= 0 ? '+' : ''}{aiStatus.totalReturn?.toFixed(2) || '0.00'}%
                            </div>
                        </div>
                    </div>
                )}

                {/* Action Buttons */}
                <div className="mb-8 flex gap-4">
                    <button
                        onClick={handleInitializeAI}
                        disabled={processing || (aiStatus?.holdings > 0)}
                        className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium"
                    >
                        {processing ? 'Processing...' : '🚀 Initialize AI Portfolio'}
                    </button>
                    <button
                        onClick={handleRebalance}
                        disabled={processing || (aiStatus?.holdings === 0)}
                        className="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium"
                    >
                        {processing ? 'Processing...' : '⚖️ Rebalance Portfolio'}
                    </button>
                </div>

                {/* AI Strategy Info */}
                {aiStatus?.strategy && (
                    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 mb-8">
                        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">📋 AI Strategy</h2>
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                            <div>
                                <div className="text-sm text-gray-500 dark:text-gray-400">Cash Reserve</div>
                                <div className="text-lg font-semibold text-gray-900 dark:text-white">{aiStatus.strategy.minCashReserve}</div>
                            </div>
                            <div>
                                <div className="text-sm text-gray-500 dark:text-gray-400">Max Position</div>
                                <div className="text-lg font-semibold text-gray-900 dark:text-white">{aiStatus.strategy.maxPositionSize}</div>
                            </div>
                            <div>
                                <div className="text-sm text-gray-500 dark:text-gray-400">Stop Loss</div>
                                <div className="text-lg font-semibold text-red-600">{aiStatus.strategy.stopLoss}</div>
                            </div>
                            <div>
                                <div className="text-sm text-gray-500 dark:text-gray-400">Take Profit</div>
                                <div className="text-lg font-semibold text-green-600">{aiStatus.strategy.takeProfit}</div>
                            </div>
                        </div>
                    </div>
                )}

                {/* AI Recommendations */}
                <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
                    <div className="p-6">
                        <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-6">🎯 AI Stock Recommendations</h2>
                        
                        {recommendations.length === 0 ? (
                            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                                No recommendations available
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                                    <thead className="bg-gray-50 dark:bg-gray-700">
                                        <tr>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Symbol</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Sector</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Price</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Change</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">AI Score</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Signal</th>
                                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Weight</th>
                                        </tr>
                                    </thead>
                                    <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                                        {recommendations.map((rec) => (
                                            <tr key={rec.symbol}>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-white">
                                                    {rec.symbol}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">
                                                    {rec.sector}
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">
                                                    ${rec.price?.toFixed(2)}
                                                </td>
                                                <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${rec.change >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                    {rec.change >= 0 ? '+' : ''}{rec.change?.toFixed(2)}%
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap">
                                                    <div className="flex items-center">
                                                        <div className="text-sm font-semibold text-gray-900 dark:text-white mr-2">
                                                            {rec.aiScore}/100
                                                        </div>
                                                        <div className="w-20 bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                                                            <div
                                                                className={`h-2 rounded-full ${rec.aiScore >= 70 ? 'bg-green-500' : rec.aiScore >= 40 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                                                style={{ width: `${rec.aiScore}%` }}
                                                            ></div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap">
                                                    <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                                                        rec.recommendation === 'BUY'
                                                            ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                                                            : rec.recommendation === 'SELL'
                                                            ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                                                            : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                                                    }`}>
                                                        {rec.recommendation}
                                                    </span>
                                                </td>
                                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">
                                                    {(rec.targetWeight * 100).toFixed(0)}%
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </div>

                {/* Settings Panel for AI Trading Configuration */}
                <div className="mb-8 bg-white dark:bg-gray-800 rounded-lg shadow p-6">
                    <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">AI Trading Settings</h2>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Stop-Loss (%)</label>
                            <input
                                type="number"
                                min={1}
                                max={20}
                                value={Math.abs(aiSettings.stopLoss * 100)}
                                onChange={e => {
                                    setAISettings(s => ({ ...s, stopLoss: -Math.abs(Number(e.target.value) / 100) }));
                                    setSettingsChanged(true);
                                }}
                                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                disabled={settingsLoading}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Take-Profit (%)</label>
                            <input
                                type="number"
                                min={5}
                                max={50}
                                value={Math.abs(aiSettings.takeProfit * 100)}
                                onChange={e => {
                                    setAISettings(s => ({ ...s, takeProfit: Math.abs(Number(e.target.value) / 100) }));
                                    setSettingsChanged(true);
                                }}
                                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                disabled={settingsLoading}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Cash Reserve (%)</label>
                            <input
                                type="number"
                                min={0}
                                max={50}
                                value={Math.abs(aiSettings.minCashReserve * 100)}
                                onChange={e => {
                                    setAISettings(s => ({ ...s, minCashReserve: Math.abs(Number(e.target.value) / 100) }));
                                    setSettingsChanged(true);
                                }}
                                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                disabled={settingsLoading}
                            />
                        </div>
                    </div>
                    <button
                        onClick={saveAISettings}
                        disabled={settingsLoading || !settingsChanged}
                        className="mt-6 px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium"
                    >
                        {settingsLoading ? 'Saving...' : 'Save Settings'}
                    </button>
                    <div className="mt-4 text-xs text-gray-500 dark:text-gray-400">
                        You can adjust your stop-loss, take-profit, and cash reserve settings at any time. These will be used by the AI for future trades and rebalancing.
                    </div>
                </div>

                {/* Info Section */}
                <div className="mt-8 bg-blue-50 dark:bg-blue-900/20 rounded-lg p-6">
                    <h3 className="text-lg font-semibold text-blue-900 dark:text-blue-300 mb-3">How AI Trading Works</h3>
                    <ul className="space-y-2 text-sm text-blue-800 dark:text-blue-300">
                        <li>✅ <strong>Diversification:</strong> AI invests across 10 top stocks in multiple sectors</li>
                        <li>✅ <strong>Risk Management:</strong> Automatic stop-loss (<span className="font-bold">6%</span> by default, user-configurable) and take-profit (<span className="font-bold">30%</span> by default, user-configurable) triggers</li>
                        <li>✅ <strong>Smart Rebalancing:</strong> AI maintains optimal portfolio allocation automatically</li>
                        <li>✅ <strong>Real-time Analysis:</strong> Continuous market monitoring and AI-powered signals</li>
                        <li>✅ <strong>Cash Reserve:</strong> No default reserve; users can set their own cash reserve percentage</li>
                    </ul>
                </div>
            </main>
        </div>
    );
}
