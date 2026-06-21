'use client';
import { getApiBaseUrl } from '../config';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';


function formatCurrency(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return '$0.00';
    }

    return numericValue.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

function formatPercent(value, digits = 2) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return '0%';
    }

    return `${numericValue.toFixed(digits)}%`;
}

function formatRiskPercent(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return 'N/A';
    }

    return formatPercent(Math.abs(numericValue) * 100, 0);
}

function formatCheckInterval(milliseconds) {
    const numericValue = Number(milliseconds);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return 'N/A';
    }

    return `${Math.round(numericValue / 60000)} min`;
}

function getStatusBadgeClasses(active, activeClasses, inactiveClasses) {
    return active ? activeClasses : inactiveClasses;
}

const DEFAULT_ENHANCED_SETTINGS = {
    maxPositionSize: 0.10,
    minPositionSize: 0.02,
    maxPortfolioRisk: 0.6,
    minBuyScore: 85,
    stopLoss: -0.07,
    trailingStopPercent: 0.07,
    takeProfitPercent: 0.20,
    partialTakeProfitPercent: 0.12,
    maxOpenPositions: 4,
    minMarketCap: 2000000000,
    maxDailyTrades: 5,
    maxVix: 30,
    reducePositionsVix: 25,
    maxSectorAllocation: 0.20,
    dailyLossLimit: -300,
    maxOrderNotional: 500,
    emergencyStopEnabled: false
};

function buildEnhancedSettings(config = {}) {
    const emergencyStopEnabled = config?.['emergencyStopEnabled'] === true;

    return {
        ...DEFAULT_ENHANCED_SETTINGS,
        ...config,
        emergencyStopEnabled
    };
}

export default function AITradingPage() {
    const router = useRouter();
    const [token, setToken] = useState(null);
    const [loading, setLoading] = useState(true);
    const [aiStatus, setAIStatus] = useState(null);
    const [automationStatus, setAutomationStatus] = useState(null);
    const [recommendations, setRecommendations] = useState([]);
    const [processing, setProcessing] = useState(false);
    const [message, setMessage] = useState(null);
    const [settingsLoading, setSettingsLoading] = useState(true);
    const [aiSettings, setAISettings] = useState({ stopLoss: 0.06, takeProfit: 0.3, minCashReserve: 0 });
    const [settingsChanged, setSettingsChanged] = useState(false);
    const [enhancedSettings, setEnhancedSettings] = useState(buildEnhancedSettings());
    const [enhancedSettingsChanged, setEnhancedSettingsChanged] = useState(false);
    const [enhancedSettingsSaving, setEnhancedSettingsSaving] = useState(false);

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        if (!storedToken) {
            router.push('/login');
            return;
        }

        setToken(storedToken);
    }, [router]);

    useEffect(() => {
        if (!token) {
            return undefined;
        }

        loadAIData();

        const pollInterval = setInterval(() => {
            fetchAIStatus();
            fetchRecommendations();
            fetchAutomationStatus();
        }, 5000);

        return () => clearInterval(pollInterval);
    }, [token]);

    useEffect(() => {
        if (automationStatus?.riskConfig && !enhancedSettingsChanged) {
            setEnhancedSettings(buildEnhancedSettings(automationStatus.riskConfig));
        }
    }, [automationStatus, enhancedSettingsChanged]);

    const fetchAISettings = async () => {
        setSettingsLoading(true);

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/ai-trading/settings`, {
                headers: { Authorization: `Bearer ${token}` }
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

    const fetchAIStatus = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/ai-trading/status`, {
                headers: { Authorization: `Bearer ${token}` }
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
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.ok) {
                const data = await response.json();
                setRecommendations(data.recommendations || []);
            }
        } catch (error) {
            console.error('Error fetching recommendations:', error);
        }
    };

    const fetchAutomationStatus = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/enhanced-ai-trading/status`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.ok) {
                const data = await response.json();
                setAutomationStatus(data);
            }
        } catch (error) {
            console.error('Error fetching enhanced AI status:', error);
        }
    };

    const loadAIData = async () => {
        setLoading(true);

        try {
            await Promise.all([
                fetchAIStatus(),
                fetchRecommendations(),
                fetchAISettings(),
                fetchAutomationStatus()
            ]);
        } catch (error) {
            console.error('Failed to load AI data:', error);
        } finally {
            setLoading(false);
        }
    };

    const saveAISettings = async () => {
        setSettingsLoading(true);
        setMessage(null);

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/ai-trading/settings`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({
                    stopLoss: aiSettings.stopLoss,
                    takeProfit: aiSettings.takeProfit,
                    minCashReserve: aiSettings.minCashReserve
                })
            });

            const data = await response.json();

            if (response.ok) {
                setMessage({ type: 'success', text: 'Legacy AI settings saved successfully.' });
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

    const saveEnhancedSettings = async () => {
        setEnhancedSettingsSaving(true);
        setMessage(null);

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/enhanced-ai-trading/config`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify(enhancedSettings)
            });

            const data = await response.json();

            if (response.ok) {
                setEnhancedSettings(buildEnhancedSettings(data.riskConfig || enhancedSettings));
                setEnhancedSettingsChanged(false);
                setMessage({ type: 'success', text: 'Enhanced risk controls saved successfully.' });
                await fetchAutomationStatus();
            } else {
                setMessage({ type: 'error', text: data.error || 'Failed to save enhanced risk controls' });
            }
        } catch (error) {
            setMessage({ type: 'error', text: 'Error saving enhanced risk controls' });
        } finally {
            setEnhancedSettingsSaving(false);
        }
    };

    const updateEnhancedSetting = (key, value) => {
        setEnhancedSettings((current) => ({
            ...current,
            [key]: value
        }));
        setEnhancedSettingsChanged(true);
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
                    Authorization: `Bearer ${token}`
                }
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
                    Authorization: `Bearer ${token}`
                }
            });

            const data = await response.json();

            if (response.ok) {
                const executedCount = data.actions?.filter((action) => action.executed).length || 0;
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

    if (loading) {
        return (
            <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center">
                <div className="text-xl text-gray-600 dark:text-gray-300">Loading AI Trading...</div>
            </div>
        );
    }

    const riskConfig = automationStatus?.riskConfig || {};
    const schedulerStatus = automationStatus?.schedulerStatus || {};
    const lastActivity = automationStatus?.lastActivity || null;
    const lastActivityLabel = lastActivity?.action || lastActivity?.event_type || lastActivity?.type || 'No recent activity';
    const lastActivitySymbol = lastActivity?.symbol || null;
    const lastActivityTime = lastActivity?.timestamp || lastActivity?.created_at || lastActivity?.logged_at || null;
    const featureCards = [
        {
            title: 'Automated Buy Execution',
            description: 'Initial portfolio construction and re-entry decisions can place BUY orders when AI thresholds are met.',
            tone: 'from-blue-500/15 to-sky-500/5 border-blue-500/30'
        },
        {
            title: 'Automated Sell Execution',
            description: 'SELL paths exist for stop-loss, take-profit, partial-profit, drift rebalancing, and bearish signal changes.',
            tone: 'from-red-500/15 to-orange-500/5 border-red-500/30'
        },
        {
            title: 'Trailing Stop Protection',
            description: `Enhanced automation tracks peak price and currently trails by ${formatRiskPercent(riskConfig.trailingStopPercent || 0.08)} from peak.`,
            tone: 'from-amber-500/15 to-yellow-500/5 border-amber-500/30'
        },
        {
            title: 'Partial Take-Profit',
            description: `The enhanced bot can trim positions after intermediate gains at around ${formatRiskPercent(riskConfig.partialTakeProfitPercent || 0.15)}.`,
            tone: 'from-emerald-500/15 to-green-500/5 border-emerald-500/30'
        },
        {
            title: '5-Minute Automation Cycle',
            description: `The worker-driven enhanced scheduler checks market conditions every ${formatCheckInterval(schedulerStatus.checkInterval || 300000)} during market hours.`,
            tone: 'from-violet-500/15 to-indigo-500/5 border-violet-500/30'
        },
        {
            title: 'Operational Safeguards',
            description: 'Global trading controls, emergency stop flags, market-hour gating, and decision logging are all part of the live automation path.',
            tone: 'from-slate-500/15 to-gray-500/5 border-slate-500/30'
        }
    ];

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900">


            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
                <section className="rounded-3xl border border-slate-200/70 dark:border-slate-700/70 bg-white/85 dark:bg-slate-900/75 shadow-xl shadow-slate-200/40 dark:shadow-black/20 overflow-hidden">
                    <div className="bg-gradient-to-r from-slate-900 via-blue-900 to-cyan-800 px-6 py-8 text-white">
                        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                            <div>
                                <p className="text-xs uppercase tracking-[0.35em] text-cyan-200/80">AI Command Center</p>
                                <h1 className="mt-3 text-3xl font-bold">AI Trading Dashboard</h1>
                                <p className="mt-3 max-w-3xl text-sm text-slate-200">
                                    This view now reflects both surfaces in the system: the legacy manual AI portfolio controls and the enhanced worker-driven automation stack that handles live scheduling, trailing stops, partial profit-taking, and operational safeguards.
                                </p>
                            </div>

                            <div className="flex flex-wrap gap-2 text-xs font-semibold">
                                <span className={`rounded-full px-3 py-2 ${getStatusBadgeClasses(automationStatus?.aiTradingEnabled, 'bg-emerald-400/20 text-emerald-100 border border-emerald-300/30', 'bg-white/10 text-slate-100 border border-white/15')}`}>
                                    User Automation {automationStatus?.aiTradingEnabled ? 'ON' : 'OFF'}
                                </span>
                                <span className={`rounded-full px-3 py-2 ${getStatusBadgeClasses(automationStatus?.marketOpen, 'bg-cyan-400/20 text-cyan-100 border border-cyan-300/30', 'bg-white/10 text-slate-100 border border-white/15')}`}>
                                    Market {automationStatus?.marketOpen ? 'OPEN' : 'CLOSED'}
                                </span>
                                <span className={`rounded-full px-3 py-2 ${getStatusBadgeClasses(schedulerStatus?.running, 'bg-violet-400/20 text-violet-100 border border-violet-300/30', 'bg-white/10 text-slate-100 border border-white/15')}`}>
                                    Scheduler {schedulerStatus?.running ? 'RUNNING' : 'STOPPED'}
                                </span>
                                <span className={`rounded-full px-3 py-2 ${getStatusBadgeClasses(automationStatus?.globalTradingEnabled !== false, 'bg-amber-400/20 text-amber-100 border border-amber-300/30', 'bg-rose-400/20 text-rose-100 border border-rose-300/30')}`}>
                                    Global Trading {automationStatus?.globalTradingEnabled !== false ? 'ENABLED' : 'BLOCKED'}
                                </span>
                            </div>
                        </div>
                    </div>

                    {message && (
                        <div className={`mx-6 mt-6 rounded-2xl px-4 py-3 text-sm ${
                            message.type === 'success'
                                ? 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300'
                                : 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300'
                        }`}>
                            {message.text}
                        </div>
                    )}

                    <div className="p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4">
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/60 p-5">
                            <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Total Portfolio Value</div>
                            <div className="mt-3 text-2xl font-bold text-slate-900 dark:text-white">{formatCurrency(aiStatus?.totalValue)}</div>
                            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">Legacy portfolio status snapshot</div>
                        </div>
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/60 p-5">
                            <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Invested Capital</div>
                            <div className="mt-3 text-2xl font-bold text-blue-600 dark:text-blue-400">{formatCurrency(aiStatus?.investedValue)}</div>
                            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{formatPercent(aiStatus?.investedPercent)} deployed</div>
                        </div>
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/60 p-5">
                            <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Cash Reserve</div>
                            <div className="mt-3 text-2xl font-bold text-emerald-600 dark:text-emerald-400">{formatCurrency(aiStatus?.cashReserve)}</div>
                            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{formatPercent(aiStatus?.cashReservePercent)} liquid</div>
                        </div>
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/60 p-5">
                            <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Total Return</div>
                            <div className={`mt-3 text-2xl font-bold ${Number(aiStatus?.totalReturn) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                {Number(aiStatus?.totalReturn) >= 0 ? '+' : ''}{formatPercent(aiStatus?.totalReturn)}
                            </div>
                            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">Holdings {aiStatus?.holdings || 0}</div>
                        </div>
                        <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/80 dark:bg-slate-800/60 p-5">
                            <div className="text-sm font-medium text-slate-500 dark:text-slate-400">Automation Cycle</div>
                            <div className="mt-3 text-2xl font-bold text-slate-900 dark:text-white">{formatCheckInterval(schedulerStatus?.checkInterval || 300000)}</div>
                            <div className="mt-2 text-xs text-slate-500 dark:text-slate-400">{schedulerStatus?.isProcessing ? 'Cycle currently processing' : 'Idle between checks'}</div>
                        </div>
                    </div>
                </section>

                <section className="grid grid-cols-1 xl:grid-cols-[1.2fr_0.8fr] gap-6">
                    <div className="rounded-3xl border border-slate-200/70 dark:border-slate-700/70 bg-white/85 dark:bg-slate-900/75 p-6 shadow-lg shadow-slate-200/30 dark:shadow-black/20">
                        <div className="flex items-start justify-between gap-4 mb-6">
                            <div>
                                <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Manual Execution Controls</h2>
                                <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
                                    These buttons drive the legacy AI route surface. They remain useful for one-click initialization and discretionary rebalancing.
                                </p>
                            </div>
                        </div>

                        <div className="flex flex-wrap gap-4 mb-6">
                            <button
                                onClick={handleInitializeAI}
                                disabled={processing || aiStatus?.holdings > 0}
                                className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium"
                            >
                                {processing ? 'Processing...' : 'Initialize AI Portfolio'}
                            </button>
                            <button
                                onClick={handleRebalance}
                                disabled={processing || aiStatus?.holdings === 0}
                                className="px-6 py-3 bg-slate-900 text-white rounded-xl hover:bg-slate-800 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors font-medium dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
                            >
                                {processing ? 'Processing...' : 'Rebalance Portfolio'}
                            </button>
                        </div>

                        {/* Live Active Strategy Card — sourced from enhanced bot config (source of truth) */}
                        <div className="rounded-2xl border border-blue-200 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/30 p-5">
                            <div className="flex items-center gap-2 mb-4">
                                <div className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                                <span className="text-sm font-semibold text-blue-700 dark:text-blue-300 uppercase tracking-wide">Live Active Strategy</span>
                                <span className="ml-auto text-xs text-slate-400">(Enhanced Automation Config)</span>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                <div className="bg-white/70 dark:bg-slate-800/60 rounded-xl p-3">
                                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Stop Loss</div>
                                    <div className="text-xl font-bold text-red-600 dark:text-red-400">
                                        -{Math.abs((riskConfig.stopLoss ?? -0.07) * 100).toFixed(0)}%
                                    </div>
                                    <div className="text-xs text-slate-400 mt-0.5">Hard exit trigger</div>
                                </div>
                                <div className="bg-white/70 dark:bg-slate-800/60 rounded-xl p-3">
                                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Take Profit</div>
                                    <div className="text-xl font-bold text-emerald-600 dark:text-emerald-400">
                                        +{((riskConfig.takeProfitPercent ?? 0.20) * 100).toFixed(0)}%
                                    </div>
                                    <div className="text-xs text-slate-400 mt-0.5">Full exit target</div>
                                </div>
                                <div className="bg-white/70 dark:bg-slate-800/60 rounded-xl p-3">
                                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Trailing Stop</div>
                                    <div className="text-xl font-bold text-amber-600 dark:text-amber-400">
                                        {((riskConfig.trailingStopPercent ?? 0.07) * 100).toFixed(0)}%
                                    </div>
                                    <div className="text-xs text-slate-400 mt-0.5">From peak price</div>
                                </div>
                                <div className="bg-white/70 dark:bg-slate-800/60 rounded-xl p-3">
                                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Max Position Size</div>
                                    <div className="text-xl font-bold text-slate-900 dark:text-white">
                                        {((riskConfig.maxPositionSize ?? 0.10) * 100).toFixed(0)}%
                                    </div>
                                    <div className="text-xs text-slate-400 mt-0.5">Per single stock</div>
                                </div>
                                <div className="bg-white/70 dark:bg-slate-800/60 rounded-xl p-3">
                                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Max Open Positions</div>
                                    <div className="text-xl font-bold text-slate-900 dark:text-white">
                                        {riskConfig.maxOpenPositions ?? 4}
                                    </div>
                                    <div className="text-xs text-slate-400 mt-0.5">Concurrent trades</div>
                                </div>
                                <div className="bg-white/70 dark:bg-slate-800/60 rounded-xl p-3">
                                    <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Max Order Size</div>
                                    <div className="text-xl font-bold text-slate-900 dark:text-white">
                                        ${(riskConfig.maxOrderNotional ?? 500).toLocaleString()}
                                    </div>
                                    <div className="text-xs text-slate-400 mt-0.5">Per trade cap</div>
                                </div>
                            </div>
                            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
                                <span>Partial exit at +{((riskConfig.partialTakeProfitPercent ?? 0.12) * 100).toFixed(0)}%</span>
                                <span>•</span>
                                <span>Daily loss limit: ${Math.abs(riskConfig.dailyLossLimit ?? 300)}</span>
                                <span>•</span>
                                <span>Min score: {riskConfig.minBuyScore ?? 85}/100</span>
                                <span>•</span>
                                <span>Max VIX: {riskConfig.maxVix ?? 30}</span>
                                <button
                                    className="ml-auto text-xs font-medium px-3 py-1 rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800/60 transition-colors"
                                    onClick={() => {
                                        setEnhancedSettings(buildEnhancedSettings(DEFAULT_ENHANCED_SETTINGS));
                                        setEnhancedSettingsChanged(true);
                                    }}
                                    title="Load safe recommended values into the form below, then click Save Enhanced Settings to apply"
                                >
                                    Reset to Recommended Defaults
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="rounded-3xl border border-slate-200/70 dark:border-slate-700/70 bg-white/85 dark:bg-slate-900/75 p-6 shadow-lg shadow-slate-200/30 dark:shadow-black/20">
                        <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Automation State</h2>
                        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-1 gap-4">
                            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/60 p-4">
                                <div className="text-xs uppercase tracking-wide text-slate-400">Scheduler</div>
                                <div className="mt-2 text-lg font-semibold text-slate-900 dark:text-white">{schedulerStatus?.running ? 'Running' : 'Stopped'}</div>
                                <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{schedulerStatus?.isProcessing ? 'Cycle in progress' : 'Waiting for next cycle'}</div>
                            </div>
                            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/60 p-4">
                                <div className="text-xs uppercase tracking-wide text-slate-400">Market Hours</div>
                                <div className="mt-2 text-lg font-semibold text-slate-900 dark:text-white">{automationStatus?.marketOpen ? 'Open' : 'Closed'}</div>
                                <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">Enhanced bot only trades during market windows</div>
                            </div>
                            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/60 p-4">
                                <div className="text-xs uppercase tracking-wide text-slate-400">Global Trading</div>
                                <div className="mt-2 text-lg font-semibold text-slate-900 dark:text-white">{automationStatus?.globalTradingEnabled !== false ? 'Enabled' : 'Disabled'}</div>
                                <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">{automationStatus?.killSwitchReason || 'No kill switch reason active'}</div>
                            </div>
                            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/60 p-4">
                                <div className="text-xs uppercase tracking-wide text-slate-400">Emergency Stop</div>
                                <div className="mt-2 text-lg font-semibold text-slate-900 dark:text-white">{automationStatus?.emergencyStopEnabled ? 'Enabled' : 'Clear'}</div>
                                <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">User-level risk halt for automated execution</div>
                            </div>
                            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/60 p-4 sm:col-span-2 xl:col-span-1">
                                <div className="text-xs uppercase tracking-wide text-slate-400">Last Recorded Activity</div>
                                <div className="mt-2 text-lg font-semibold text-slate-900 dark:text-white">{lastActivityLabel}</div>
                                <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                                    {lastActivitySymbol ? `${lastActivitySymbol} • ` : ''}{lastActivityTime ? new Date(lastActivityTime).toLocaleString() : 'No recent log entry returned'}
                                </div>
                            </div>
                        </div>
                    </div>
                </section>

                <section className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-2 rounded-3xl border border-slate-200/70 dark:border-slate-700/70 bg-white/85 dark:bg-slate-900/75 p-6 shadow-lg shadow-slate-200/30 dark:shadow-black/20">
                        <div className="flex items-center justify-between gap-4 mb-6">
                            <div>
                                <h2 className="text-xl font-semibold text-slate-900 dark:text-white">AI Recommendations</h2>
                                <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">Live recommendation feed from the legacy AI analysis surface.</p>
                            </div>
                            <div className="text-sm text-slate-500 dark:text-slate-400">{recommendations.length} symbols</div>
                        </div>

                        {recommendations.length === 0 ? (
                            <div className="text-center py-12 text-slate-500 dark:text-slate-400">
                                No recommendations available.
                            </div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="min-w-full divide-y divide-slate-200 dark:divide-slate-700">
                                    <thead className="bg-slate-50 dark:bg-slate-800/70">
                                        <tr>
                                            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-300 uppercase">Symbol</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-300 uppercase">Sector</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-300 uppercase">Price</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-300 uppercase">Change</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-300 uppercase">AI Score</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-300 uppercase">Signal</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 dark:text-slate-300 uppercase">Weight</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                                        {recommendations.map((rec) => (
                                            <tr key={rec.symbol} className="bg-white/60 dark:bg-slate-900/20">
                                                <td className="px-4 py-4 whitespace-nowrap text-sm font-medium text-slate-900 dark:text-white">{rec.symbol}</td>
                                                <td className="px-4 py-4 whitespace-nowrap text-sm text-slate-600 dark:text-slate-300">{rec.sector}</td>
                                                <td className="px-4 py-4 whitespace-nowrap text-sm text-slate-600 dark:text-slate-300">{formatCurrency(rec.price)}</td>
                                                <td className={`px-4 py-4 whitespace-nowrap text-sm font-medium ${rec.change >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                                                    {rec.change >= 0 ? '+' : ''}{formatPercent(rec.change)}
                                                </td>
                                                <td className="px-4 py-4 whitespace-nowrap">
                                                    <div className="flex items-center gap-2">
                                                        <div className="text-sm font-semibold text-slate-900 dark:text-white">{rec.aiScore}/100</div>
                                                        <div className="w-20 bg-slate-200 dark:bg-slate-700 rounded-full h-2">
                                                            <div
                                                                className={`h-2 rounded-full ${rec.aiScore >= 70 ? 'bg-emerald-500' : rec.aiScore >= 40 ? 'bg-amber-500' : 'bg-red-500'}`}
                                                                style={{ width: `${rec.aiScore}%` }}
                                                            />
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="px-4 py-4 whitespace-nowrap">
                                                    <span className={`px-2 py-1 text-xs font-semibold rounded-full ${
                                                        rec.recommendation === 'BUY'
                                                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400'
                                                            : rec.recommendation === 'SELL'
                                                            ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
                                                            : 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-300'
                                                    }`}>
                                                        {rec.recommendation}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-4 whitespace-nowrap text-sm text-slate-600 dark:text-slate-300">{formatPercent((rec.targetWeight || 0) * 100, 0)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>

                    <div className="rounded-3xl border border-slate-200/70 dark:border-slate-700/70 bg-white/85 dark:bg-slate-900/75 p-6 shadow-lg shadow-slate-200/30 dark:shadow-black/20">
                        <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Risk Engine Coverage</h2>
                        <div className="mt-6 space-y-4">
                            {featureCards.map((feature) => (
                                <div key={feature.title} className={`rounded-2xl border bg-gradient-to-br p-4 ${feature.tone}`}>
                                    <h3 className="font-semibold text-slate-900 dark:text-white">{feature.title}</h3>
                                    <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{feature.description}</p>
                                </div>
                            ))}
                        </div>
                    </div>
                </section>

                <section className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-6">
                    <div className="rounded-3xl border border-slate-200/70 dark:border-slate-700/70 bg-white/85 dark:bg-slate-900/75 p-6 shadow-lg shadow-slate-200/30 dark:shadow-black/20">
                        <div className="flex items-center justify-between gap-4 mb-6">
                            <div>
                                <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Quick Settings Override</h2>
                                <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
                                    Override core risk parameters here. For full control, use Enhanced Risk Controls on the right.
                                </p>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Stop-Loss (%)</label>
                                <input
                                    type="number"
                                    min={1}
                                    max={20}
                                    value={Math.abs(aiSettings.stopLoss * 100)}
                                    onChange={(e) => {
                                        setAISettings((state) => ({ ...state, stopLoss: -Math.abs(Number(e.target.value) / 100) }));
                                        setSettingsChanged(true);
                                    }}
                                    className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                                    disabled={settingsLoading}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Take-Profit (%)</label>
                                <input
                                    type="number"
                                    min={5}
                                    max={50}
                                    value={Math.abs(aiSettings.takeProfit * 100)}
                                    onChange={(e) => {
                                        setAISettings((state) => ({ ...state, takeProfit: Math.abs(Number(e.target.value) / 100) }));
                                        setSettingsChanged(true);
                                    }}
                                    className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                                    disabled={settingsLoading}
                                />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Cash Reserve (%)</label>
                                <input
                                    type="number"
                                    min={0}
                                    max={50}
                                    value={Math.abs(aiSettings.minCashReserve * 100)}
                                    onChange={(e) => {
                                        setAISettings((state) => ({ ...state, minCashReserve: Math.abs(Number(e.target.value) / 100) }));
                                        setSettingsChanged(true);
                                    }}
                                    className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                                    disabled={settingsLoading}
                                />
                            </div>
                        </div>

                        <button
                            onClick={saveAISettings}
                            disabled={settingsLoading || !settingsChanged}
                            className="mt-6 px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium"
                        >
                            {settingsLoading ? 'Saving...' : 'Save Settings'}
                        </button>

                        <div className="mt-4 rounded-2xl bg-sky-50 text-sky-900 dark:bg-sky-900/20 dark:text-sky-200 px-4 py-3 text-sm">
                            For full parameter control (trailing stop, partial profit, VIX limits, sector caps) use Enhanced Risk Controls on the right.
                        </div>
                    </div>

                    <div className="rounded-3xl border border-slate-200/70 dark:border-slate-700/70 bg-white/85 dark:bg-slate-900/75 p-6 shadow-lg shadow-slate-200/30 dark:shadow-black/20">
                        <div className="flex items-start justify-between gap-4 mb-6">
                            <div>
                                <h2 className="text-xl font-semibold text-slate-900 dark:text-white">Enhanced Risk Controls</h2>
                                <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
                                    These fields save directly to the enhanced automation config used by the worker-backed trading engine.
                                </p>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Max Position Size (%)</label>
                                <input type="number" min={1} max={100} value={Math.abs(enhancedSettings.maxPositionSize * 100)} onChange={(e) => updateEnhancedSetting('maxPositionSize', Math.abs(Number(e.target.value) / 100))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Min Position Size (%)</label>
                                <input type="number" min={0} max={100} value={Math.abs(enhancedSettings.minPositionSize * 100)} onChange={(e) => updateEnhancedSetting('minPositionSize', Math.abs(Number(e.target.value) / 100))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Max Portfolio Risk (%)</label>
                                <input type="number" min={1} max={100} value={Math.abs(enhancedSettings.maxPortfolioRisk * 100)} onChange={(e) => updateEnhancedSetting('maxPortfolioRisk', Math.abs(Number(e.target.value) / 100))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Min Buy Score</label>
                                <input type="number" min={1} max={100} value={enhancedSettings.minBuyScore} onChange={(e) => updateEnhancedSetting('minBuyScore', Number(e.target.value))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Stop Loss (%)</label>
                                <input type="number" min={1} max={100} value={Math.abs(enhancedSettings.stopLoss * 100)} onChange={(e) => updateEnhancedSetting('stopLoss', -Math.abs(Number(e.target.value) / 100))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Trailing Stop (%)</label>
                                <input type="number" min={1} max={100} value={Math.abs(enhancedSettings.trailingStopPercent * 100)} onChange={(e) => updateEnhancedSetting('trailingStopPercent', Math.abs(Number(e.target.value) / 100))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Full Take-Profit (%)</label>
                                <input type="number" min={1} max={100} value={Math.abs(enhancedSettings.takeProfitPercent * 100)} onChange={(e) => updateEnhancedSetting('takeProfitPercent', Math.abs(Number(e.target.value) / 100))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Partial Take-Profit (%)</label>
                                <input type="number" min={1} max={100} value={Math.abs(enhancedSettings.partialTakeProfitPercent * 100)} onChange={(e) => updateEnhancedSetting('partialTakeProfitPercent', Math.abs(Number(e.target.value) / 100))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Max Open Positions</label>
                                <input type="number" min={1} value={enhancedSettings.maxOpenPositions} onChange={(e) => updateEnhancedSetting('maxOpenPositions', Number(e.target.value))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Min Market Cap ($)</label>
                                <input type="number" min={0} step="1000000" value={enhancedSettings.minMarketCap} onChange={(e) => updateEnhancedSetting('minMarketCap', Number(e.target.value))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Max Daily Trades</label>
                                <input type="number" min={1} value={enhancedSettings.maxDailyTrades} onChange={(e) => updateEnhancedSetting('maxDailyTrades', Number(e.target.value))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Max VIX</label>
                                <input type="number" min={1} value={enhancedSettings.maxVix} onChange={(e) => updateEnhancedSetting('maxVix', Number(e.target.value))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Reduce Positions Above VIX</label>
                                <input type="number" min={1} value={enhancedSettings.reducePositionsVix} onChange={(e) => updateEnhancedSetting('reducePositionsVix', Number(e.target.value))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Max Sector Allocation (%)</label>
                                <input type="number" min={1} max={100} value={Math.abs(enhancedSettings.maxSectorAllocation * 100)} onChange={(e) => updateEnhancedSetting('maxSectorAllocation', Math.abs(Number(e.target.value) / 100))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Daily Loss Limit ($)</label>
                                <input type="number" min={0} value={Math.abs(enhancedSettings.dailyLossLimit)} onChange={(e) => updateEnhancedSetting('dailyLossLimit', -Math.abs(Number(e.target.value)))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                            <div>
                                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">Max Order Notional ($)</label>
                                <input type="number" min={0} value={enhancedSettings.maxOrderNotional} onChange={(e) => updateEnhancedSetting('maxOrderNotional', Number(e.target.value))} className="w-full px-4 py-3 border border-slate-300 dark:border-slate-600 rounded-xl bg-white dark:bg-slate-800 text-slate-900 dark:text-white" />
                            </div>
                        </div>

                        <label className="mt-6 flex items-center gap-3 text-sm text-slate-700 dark:text-slate-300">
                            <input type="checkbox" checked={enhancedSettings.emergencyStopEnabled} onChange={(e) => updateEnhancedSetting('emergencyStopEnabled', e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-red-600 focus:ring-red-500" />
                            Enable emergency stop for automated trading execution
                        </label>

                        <div className="mt-6 flex flex-wrap items-center gap-4">
                            <button
                                onClick={saveEnhancedSettings}
                                disabled={enhancedSettingsSaving || !enhancedSettingsChanged}
                                className="px-6 py-3 bg-emerald-600 text-white rounded-xl hover:bg-emerald-700 disabled:bg-gray-400 disabled:cursor-not-allowed font-medium"
                            >
                                {enhancedSettingsSaving ? 'Saving...' : 'Save Enhanced Controls'}
                            </button>
                            <div className="text-sm text-slate-500 dark:text-slate-400">
                                Changes here update the enhanced worker automation, not just the legacy manual AI controls.
                            </div>
                        </div>
                    </div>
                </section>
            </main>
        </div>
    );
}
