"use client";
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl } from '../config';
import AppHeader from '../components/AppHeader';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';
ChartJS.register(
    CategoryScale,
    LinearScale,
    PointElement,
    LineElement,
    Title,
    Tooltip,
    Legend
);

function PortfolioPage() {
    const router = useRouter();

    // Auth state
    const [token, setToken] = useState(null);

    // Loading state
    const [loading, setLoading] = useState(false);

    // Portfolio state
    const [cashBalance, setCashBalance] = useState(0);
    const [holdings, setHoldings] = useState([]);
    
    // Trade State
    const [tradeSymbol, setTradeSymbol] = useState('');
    const [tradeQuantity, setTradeQuantity] = useState('');
    const [tradeType, setTradeType] = useState('buy');
    const [currentPrice, setCurrentPrice] = useState(null);
    const [loadingPrice, setLoadingPrice] = useState(false);
    const [tradeMessage, setTradeMessage] = useState(null);
    
    // History & Performance
    const [tradeHistory, setTradeHistory] = useState([]);
    const [performanceData, setPerformanceData] = useState(null);
    
    // Deposit Modal
    const [showDepositModal, setShowDepositModal] = useState(false);
    const [depositAmount, setDepositAmount] = useState('');

    // Withdraw Modal
    const [showWithdrawModal, setShowWithdrawModal] = useState(false);
    const [withdrawAmount, setWithdrawAmount] = useState('');

    // Add chart state
    const [chartRange, setChartRange] = useState<'1D' | '1W' | '1M' | '3M' | 'YTD' | '1Y'>('1D');
    const [portfolioHistory, setPortfolioHistory] = useState([]);
    const [portfolioChange, setPortfolioChange] = useState({ value: 0, percent: 0 });

    // Tab state
    const [activeTab, setActiveTab] = useState('overview');

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
            loadData();
            fetchAISettings();
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
            if (response.ok) {
                setSettingsChanged(false);
            }
        } catch (error) {
            // Optionally show error
        } finally {
            setSettingsLoading(false);
        }
    };

    useEffect(() => {
        // Fetch portfolio history for chart
        if (token) fetchPortfolioHistory(chartRange);
    }, [token, chartRange]);

    const loadData = async () => {
        setLoading(true);
        try {
            await Promise.all([fetchPortfolio(), fetchTradeHistory(), fetchPerformance()]);
        } catch (error) {
            console.error('Failed to load data:', error);
        } finally {
            setLoading(false);
        }
    };

    // Reset cash balance state
    const [resetAmount, setResetAmount] = useState('');

    const handleResetBalance = async () => {
        const amount = parseFloat(resetAmount);
        if (isNaN(amount) || amount < 0) {
            alert('Please enter a valid non-negative amount');
            return;
        }
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/trading/reset-balance`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ amount }),
            });
            if (response.ok) {
                alert(`Cash balance reset to $${amount}`);
                setResetAmount('');
                await fetchPortfolio();
            } else {
                const data = await response.json();
                alert(data.error || 'Reset failed');
            }
        } catch (error) {
            alert('Error resetting balance');
        }
    };

    const handleClearAll = async () => {
        const confirmed = window.confirm(
            '⚠️ WARNING: This will permanently reset your entire portfolio to zero!\n\n' +
            '• Cash Balance → $0.00\n' +
            '• All Holdings → Cleared\n' +
            '• Trade History → Deleted\n' +
            '• Deposits/Withdrawals → Cleared\n\n' +
            'This action cannot be undone. Are you sure?'
        );

        if (!confirmed) return;

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/trading/clear-all`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                }
            });

            if (response.ok) {
                alert('Portfolio cleared successfully! Starting fresh from $0.00');
                await fetchPortfolio();
            } else {
                const data = await response.json();
                alert(data.error || 'Failed to clear portfolio');
            }
        } catch (error) {
            alert('Error clearing portfolio');
        }
    };

    const fetchPortfolio = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/trading/portfolio`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (response.ok) {
                const data = await response.json();
                setCashBalance(data.summary?.cashBalance || data.account?.cashBalance || 0);
                setHoldings(data.holdings || []);
            }
        } catch (error) {
            console.error('Error fetching portfolio:', error);
        }
    };

    const fetchTradeHistory = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/trading/history?limit=50`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (response.ok) {
                const data = await response.json();
                setTradeHistory(data.trades || []);
            }
        } catch (error) {
            console.error('Failed to fetch trades:', error);
        }
    };

    const fetchPerformance = async () => {
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/trading/performance`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (response.ok) {
                const data = await response.json();
                setPerformanceData(data);
            }
        } catch (error) {
            console.error('Failed to fetch performance:', error);
        }
    };

    const fetchQuote = async (symbol) => {
        if (!symbol.trim()) return;
        setLoadingPrice(true);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/trading/quote/${symbol}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (response.ok) {
                const data = await response.json();
                setCurrentPrice(data.price);
            } else {
                setTradeMessage({ type: 'error', text: 'Failed to fetch stock price' });
                setCurrentPrice(null);
            }
        } catch (error) {
            setTradeMessage({ type: 'error', text: 'Error fetching stock price' });
            setCurrentPrice(null);
        } finally {
            setLoadingPrice(false);
        }
    };

    const handleTrade = async (e) => {
        e.preventDefault();
        setTradeMessage(null);

        if (!tradeSymbol || !tradeQuantity || !currentPrice) {
            setTradeMessage({ type: 'error', text: 'Please fill all fields and fetch current price' });
            return;
        }

        const quantity = parseInt(tradeQuantity);
        if (isNaN(quantity) || quantity <= 0) {
            setTradeMessage({ type: 'error', text: 'Quantity must be a positive number' });
            return;
        }

        try {
            const endpoint = tradeType === 'buy' ? 'buy' : 'sell';
            const response = await fetch(`${getApiBaseUrl()}/api/trading/${endpoint}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    symbol: tradeSymbol.toUpperCase(),
                    quantity,
                }),
            });

            const data = await response.json();

            if (response.ok) {
                setTradeMessage({ 
                    type: 'success', 
                    text: `Successfully ${tradeType === 'buy' ? 'bought' : 'sold'} ${quantity} shares of ${tradeSymbol.toUpperCase()} at $${data.price?.toFixed(2) || currentPrice?.toFixed(2)}`
                });
                setTradeSymbol('');
                setTradeQuantity('');
                setCurrentPrice(null);
                await loadData();
            } else {
                setTradeMessage({ type: 'error', text: data.error || 'Trade failed' });
            }
        } catch (error) {
            setTradeMessage({ type: 'error', text: 'Error executing trade' });
        }
    };

    const handleDeposit = async () => {
        const amount = parseFloat(depositAmount);
        if (isNaN(amount) || amount <= 0) {
            alert('Please enter a valid amount');
            return;
        }

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/trading/deposit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ amount }),
            });

            if (response.ok) {
                alert(`Successfully deposited $${amount}`);
                setDepositAmount('');
                setShowDepositModal(false);
                await fetchPortfolio();
            } else {
                const data = await response.json();
                alert(data.error || 'Deposit failed');
            }
        } catch (error) {
            alert('Error processing deposit');
        }
    };

    const handleWithdraw = async () => {
        const amount = parseFloat(withdrawAmount);
        if (isNaN(amount) || amount <= 0) {
            alert('Please enter a valid amount');
            return;
        }

        if (amount > cashBalance) {
            alert('Withdrawal amount exceeds cash balance');
            return;
        }

        try {
            const response = await fetch(`${getApiBaseUrl()}/api/trading/withdraw`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ amount }),
            });

            if (response.ok) {
                alert(`Successfully withdrew $${amount}`);
                setWithdrawAmount('');
                setShowWithdrawModal(false);
                await fetchPortfolio();
            } else {
                const data = await response.json();
                alert(data.error || 'Withdrawal failed');
            }
        } catch (error) {
            alert('Error processing withdrawal');
        }
    };

    // Chart data and options
    const totalPortfolioValue = cashBalance + holdings.reduce((sum, h) => sum + (h.currentValue || 0), 0);
    const totalHoldingsValue = holdings.reduce((sum, h) => sum + (h.currentValue || 0), 0);
    const totalUnrealizedPL = holdings.reduce((sum, h) => sum + (h.unrealizedPL || 0), 0);

    const chartData = {
        labels: ['Open', 'High', 'Low', 'Close'],
        datasets: [
            {
                label: 'AAPL',
                data: [10000, 10200, 10150, 10300, 10400],
                borderColor: 'rgba(255, 99, 132, 1)',
                backgroundColor: 'rgba(255, 99, 132, 0.2)',
            },
        ],
    };
    const chartOptions = {
        responsive: true,
        plugins: {
            legend: { display: false },
            tooltip: {},
        },
        scales: {
            x: { display: false },
            y: { display: false },
        },
    };

    // Stub for fetchPortfolioHistory
    const fetchPortfolioHistory = (range) => {
        // Implement actual fetch logic here
        setPortfolioHistory([]);
    };

    // Stub for handleLogout
    const handleLogout = () => {
        setToken(null);
        router.push('/login');
    };
    // (Removed duplicate state and chartOptions blocks)
    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900 pb-20 lg:pb-8">
            <AppHeader showSearch={false} />

            {/* Portfolio Summary & Chart - Mobile Optimized */}
            <div className="max-w-3xl mx-auto mt-4 sm:mt-6 lg:mt-8 mb-4 sm:mb-6 px-3 sm:px-0">
                <div className="flex flex-col gap-3 mb-3">
                    <div>
                        <div className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 dark:text-white">
                            ${totalPortfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </div>
                        <div className={`mt-1 text-base sm:text-lg font-semibold ${portfolioChange.value < 0 ? 'text-red-600' : 'text-green-600'}`}> 
                            {portfolioChange.value < 0 ? '?' : '?'} ${Math.abs(portfolioChange.value).toLocaleString(undefined, { minimumFractionDigits: 2 })} ({portfolioChange.percent.toFixed(2)}%) Today
                        </div>
                    </div>
                    <div className="flex gap-1.5 sm:gap-2 overflow-x-auto scrollbar-hide pb-2">
                        {['1D','1W','1M','3M','YTD','1Y'].map((range) => (
                            <button
                                key={range}
                                onClick={() => setChartRange(range as any)}
                                className={`px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold whitespace-nowrap touch-manipulation min-h-[44px] transition-colors ${chartRange === range ? 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-200' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300'}`}
                            >
                                {range}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="w-full h-48 md:h-64">
                    <Line data={chartData} options={chartOptions} height={180} />
                </div>
                <div className="flex justify-between items-center mt-4">
                    <div className="text-gray-600 dark:text-gray-400 text-sm">Buying power</div>
                    <div className="text-lg font-bold text-gray-900 dark:text-white">${cashBalance.toFixed(2)}</div>
                </div>
            </div>

            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                {/* AI Trading Settings Panel */}
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

                {/* Info Section for AI Trading Rules */}
                <div className="mb-8 bg-blue-50 dark:bg-blue-900/20 rounded-lg p-6">
                    <h3 className="text-lg font-semibold text-blue-900 dark:text-blue-300 mb-3">How AI Trading Works</h3>
                    <ul className="space-y-2 text-sm text-blue-800 dark:text-blue-300">
                        <li>? <strong>Diversification:</strong> AI invests across 10 top stocks in multiple sectors</li>
                        <li>? <strong>Risk Management:</strong> Automatic stop-loss (<span className="font-bold">6%</span> by default, user-configurable) and take-profit (<span className="font-bold">30%</span> by default, user-configurable) triggers</li>
                        <li>? <strong>Smart Rebalancing:</strong> AI maintains optimal portfolio allocation automatically</li>
                        <li>? <strong>Real-time Analysis:</strong> Continuous market monitoring and AI-powered signals</li>
                        <li>? <strong>Cash Reserve:</strong> No default reserve; users can set their own cash reserve percentage</li>
                    </ul>
                </div>
                <div className="mb-4 sm:mb-6">
                    <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">Paper Trading Portfolio</h1>
                    <p className="mt-1 sm:mt-2 text-xs sm:text-sm text-gray-600 dark:text-gray-400">Practice trading with virtual money</p>
                </div>

                {/* Mobile-Optimized Portfolio Cards */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6 sm:mb-8">
                    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 sm:p-6">
                        <div className="text-xs sm:text-sm font-medium text-gray-500 dark:text-gray-400">Cash Balance</div>
                        <div className="mt-1 sm:mt-2 text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">${cashBalance.toFixed(2)}</div>
                        <div className="mt-3 sm:mt-4">
                            <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">Reset Cash Balance</label>
                            <div className="flex gap-2">
                                <input
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    value={resetAmount}
                                    onChange={e => setResetAmount(e.target.value)}
                                    placeholder="Amount ($)"
                                    className="flex-1 px-2 py-2 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm min-h-[44px]"
                                />
                                <button
                                    onClick={handleResetBalance}
                                    className="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 active:bg-blue-800 text-sm font-medium touch-manipulation min-h-[44px]"
                                >
                                    Reset
                                </button>
                            </div>
                            <button
                                onClick={handleClearAll}
                                className="mt-2 w-full px-3 py-2.5 bg-red-600 text-white rounded hover:bg-red-700 active:bg-red-800 text-sm font-medium transition-colors touch-manipulation min-h-[44px]"
                            >
                                🗑️ Clear All Portfolio
                            </button>
                        </div>
                    </div>
                    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 sm:p-6">
                        <div className="text-xs sm:text-sm font-medium text-gray-500 dark:text-gray-400">Holdings Value</div>
                        <div className="mt-1 sm:mt-2 text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">${totalHoldingsValue.toFixed(2)}</div>
                    </div>
                    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 sm:p-6">
                        <div className="text-xs sm:text-sm font-medium text-gray-500 dark:text-gray-400">Total Portfolio</div>
                        <div className="mt-1 sm:mt-2 text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">${totalPortfolioValue.toFixed(2)}</div>
                    </div>
                    <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 sm:p-6">
                        <div className="text-xs sm:text-sm font-medium text-gray-500 dark:text-gray-400">Unrealized P/L</div>
                        <div className={`mt-1 sm:mt-2 text-xl sm:text-2xl font-bold ${totalUnrealizedPL >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            ${totalUnrealizedPL.toFixed(2)}
                        </div>
                    </div>
                </div>

                <div className="bg-white dark:bg-gray-800 rounded-lg shadow">
                    <div className="border-b border-gray-200 dark:border-gray-700 overflow-x-auto scrollbar-hide">
                        <nav className="flex -mb-px">
                            {['overview', 'trade', 'history', 'performance'].map((tab) => (
                                <button
                                    key={tab}
                                    onClick={() => setActiveTab(tab)}
                                    className={`flex-1 sm:flex-none px-4 sm:px-6 py-3 text-xs sm:text-sm font-medium border-b-2 transition-colors whitespace-nowrap touch-manipulation min-h-[44px] ${
                                        activeTab === tab
                                            ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                                            : 'border-transparent text-gray-500 active:text-gray-700 dark:text-gray-400 dark:active:text-gray-300'
                                    }`}
                                >
                                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                                </button>
                            ))}
                        </nav>
                    </div>

                    <div className="p-3 sm:p-4 lg:p-6">
                        {activeTab === 'overview' && (
                            <div>
                                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-4">
                                    <h2 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-white">Current Holdings</h2>
                                    <button
                                        onClick={() => setShowDepositModal(true)}
                                        className="w-full sm:w-auto px-4 py-2.5 bg-green-600 text-white rounded-lg hover:bg-green-700 active:bg-green-800 transition-colors font-medium touch-manipulation min-h-[44px]"
                                    >
                                        Deposit Funds
                                    </button>
                                </div>

                                {holdings.length === 0 ? (
                                    <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                                        No holdings yet. Start trading to build your portfolio!
                                    </div>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                                            <thead className="bg-gray-50 dark:bg-gray-700">
                                                <tr>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Symbol</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Quantity</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Avg Price</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Current Price</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Market Value</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">Unrealized P/L</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase tracking-wider">% Change</th>
                                                </tr>
                                            </thead>
                                            <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                                                {holdings.map((holding) => (
                                                    <tr key={holding.symbol}>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-white">{holding.symbol}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">{holding.quantity}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">${holding.averagePrice?.toFixed(2) || '0.00'}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">${holding.currentPrice?.toFixed(2) || '0.00'}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">${holding.currentValue?.toFixed(2) || '0.00'}</td>
                                                        <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${(holding.unrealizedPL || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                            {(holding.unrealizedPL || 0) >= 0 ? '+' : ''}${holding.unrealizedPL?.toFixed(2) || '0.00'}
                                                        </td>
                                                        <td className={`px-6 py-4 whitespace-nowrap text-sm font-medium ${(holding.unrealizedPLPercent || 0) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                                                            {(holding.unrealizedPLPercent || 0) >= 0 ? '+' : ''}${holding.unrealizedPLPercent?.toFixed(2) || '0.00'}%
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                            <tfoot className="bg-gray-100 dark:bg-gray-700 border-t-2 border-gray-300 dark:border-gray-600">
                                                <tr className="font-bold">
                                                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">TOTAL</td>
                                                    <td className="px-6 py-4 text-sm text-gray-900 dark:text-white">
                                                        {holdings.reduce((sum, h) => sum + (h.quantity || 0), 0)} shares
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-300">
                                                        ${holdings.length > 0 ? (holdings.reduce((sum, h) => sum + ((h.averagePrice || 0) * (h.quantity || 0)), 0) / holdings.reduce((sum, h) => sum + (h.quantity || 0), 0)).toFixed(2) : '0.00'}
                                                    </td>
                                                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-300">
                                                        ${holdings.length > 0 ? (holdings.reduce((sum, h) => sum + ((h.currentPrice || 0) * (h.quantity || 0)), 0) / holdings.reduce((sum, h) => sum + (h.quantity || 0), 0)).toFixed(2) : '0.00'}
                                                    </td>
                                                    <td className="px-6 py-4 text-sm font-bold text-gray-900 dark:text-white">
                                                        ${holdings.reduce((sum, h) => sum + (h.currentValue || 0), 0).toFixed(2)}
                                                    </td>
                                                    <td className={`px-6 py-4 text-sm font-bold ${totalUnrealizedPL >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                                        {totalUnrealizedPL >= 0 ? '+' : ''}${totalUnrealizedPL.toFixed(2)}
                                                    </td>
                                                    <td className={`px-6 py-4 text-sm font-bold ${totalUnrealizedPL >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                                                        {totalHoldingsValue > 0 ? (
                                                            <>
                                                                {((totalUnrealizedPL / (totalHoldingsValue - totalUnrealizedPL)) * 100) >= 0 ? '+' : ''}
                                                                {((totalUnrealizedPL / (totalHoldingsValue - totalUnrealizedPL)) * 100).toFixed(2)}%
                                                            </>
                                                        ) : '0.00%'}
                                                    </td>
                                                </tr>
                                            </tfoot>
                                        </table>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'trade' && (
                            <div className="max-w-2xl mx-auto">
                                <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-6">Execute Trade</h2>
                                
                                {tradeMessage && (
                                    <div className={`mb-4 p-4 rounded-lg ${tradeMessage.type === 'success' ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-300' : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-300'}`}>
                                        {tradeMessage.text}
                                    </div>
                                )}

                                <form onSubmit={handleTrade} className="space-y-6">
                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Trade Type</label>
                                        <div className="flex gap-4">
                                            <button
                                                type="button"
                                                onClick={() => setTradeType('buy')}
                                                className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${tradeType === 'buy' ? 'bg-green-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}
                                            >
                                                Buy
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setTradeType('sell')}
                                                className={`flex-1 px-4 py-2 rounded-lg font-medium transition-colors ${tradeType === 'sell' ? 'bg-red-600 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'}`}
                                            >
                                                Sell
                                            </button>
                                        </div>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Stock Symbol</label>
                                        <div className="flex gap-2">
                                            <input
                                                type="text"
                                                value={tradeSymbol}
                                                onChange={(e) => setTradeSymbol(e.target.value.toUpperCase())}
                                                placeholder="e.g., AAPL"
                                                className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                                            />
                                            <button
                                                type="button"
                                                onClick={() => fetchQuote(tradeSymbol)}
                                                disabled={loadingPrice || !tradeSymbol}
                                                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400 transition-colors"
                                            >
                                                {loadingPrice ? 'Loading...' : 'Get Quote'}
                                            </button>
                                        </div>
                                    </div>

                                    {currentPrice !== null && (
                                        <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                                            <div className="text-sm font-medium text-blue-900 dark:text-blue-300">Current Price: ${currentPrice.toFixed(2)}</div>
                                        </div>
                                    )}

                                    <div>
                                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Quantity</label>
                                        <input
                                            type="number"
                                            value={tradeQuantity}
                                            onChange={(e) => setTradeQuantity(e.target.value)}
                                            placeholder="Number of shares"
                                            min="1"
                                            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                                        />
                                    </div>

                                    {currentPrice !== null && tradeQuantity && (
                                        <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                                            <div className="text-sm font-medium text-gray-700 dark:text-gray-300">
                                                Estimated {tradeType === 'buy' ? 'Cost' : 'Proceeds'}: ${(currentPrice * parseInt(tradeQuantity)).toFixed(2)}
                                            </div>
                                        </div>
                                    )}

                                    <button
                                        type="submit"
                                        className={`w-full px-6 py-3 rounded-lg font-medium text-white transition-colors ${tradeType === 'buy' ? 'bg-green-600 hover:bg-green-700' : 'bg-red-600 hover:bg-red-700'}`}
                                    >
                                        {tradeType === 'buy' ? 'Buy' : 'Sell'} {tradeSymbol || 'Stock'}
                                    </button>
                                </form>
                            </div>
                        )}

                        {activeTab === 'history' && (
                            <div>
                                <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-6">Trade History</h2>
                                {tradeHistory.length === 0 ? (
                                    <div className="text-center py-12 text-gray-500 dark:text-gray-400">No trades yet</div>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                                            <thead className="bg-gray-50 dark:bg-gray-700">
                                                <tr>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Date</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Type</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Symbol</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Quantity</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Price</th>
                                                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-300 uppercase">Total</th>
                                                </tr>
                                            </thead>
                                            <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                                                {tradeHistory.map((trade) => (
                                                    <tr key={trade.id}>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">{new Date(trade.timestamp).toLocaleString()}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap">
                                                            <span className={`px-2 py-1 text-xs font-semibold rounded-full ${trade.type === 'BUY' ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'}`}>
                                                                {trade.type}
                                                            </span>
                                                        </td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900 dark:text-white">{trade.symbol}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">{trade.quantity}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">${trade.price?.toFixed(2) || '0.00'}</td>
                                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 dark:text-gray-300">${trade.totalCost?.toFixed(2) || (trade.price * trade.quantity).toFixed(2)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'performance' && (
                            <div>
                                <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-6">Performance Analytics</h2>
                                {!performanceData || performanceData.totalTrades === 0 ? (
                                    <div className="text-center py-12 text-gray-500 dark:text-gray-400">No trading data yet</div>
                                ) : performanceData.message ? (
                                    <div className="space-y-4">
                                        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
                                            <p className="text-blue-800 dark:text-blue-300">{performanceData.message}</p>
                                        </div>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
                                                <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Trades</div>
                                                <div className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{performanceData.totalTrades}</div>
                                            </div>
                                            <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
                                                <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Buy Orders</div>
                                                <div className="mt-2 text-2xl font-bold text-green-600">{performanceData.buyOrders || 0}</div>
                                            </div>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
                                            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Total Trades</div>
                                            <div className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{performanceData.totalTrades}</div>
                                        </div>
                                        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
                                            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Win Rate</div>
                                            <div className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{(performanceData.winRate || 0).toFixed(1)}%</div>
                                        </div>
                                        <div className="bg-gray-50 dark:bg-gray-700/50 rounded-lg p-4">
                                            <div className="text-sm font-medium text-gray-500 dark:text-gray-400">Profit Factor</div>
                                            <div className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{(performanceData.profitFactor || 0).toFixed(2)}</div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </main>

            {showDepositModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
                        <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">Deposit Virtual Funds</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Amount ($)</label>
                                <input
                                    type="number"
                                    value={depositAmount}
                                    onChange={(e) => setDepositAmount(e.target.value)}
                                    placeholder="Enter amount"
                                    min="0"
                                    step="0.01"
                                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={handleDeposit}
                                    className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                                >
                                    Deposit
                                </button>
                                <button
                                    onClick={() => {
                                        setShowDepositModal(false);
                                        setDepositAmount('');
                                    }}
                                    className="flex-1 px-4 py-2 bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {showWithdrawModal && (
                <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4">
                        <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-4">Withdraw Virtual Funds</h3>
                        <div className="space-y-4">
                            <div>
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Amount ($)</label>
                                <input
                                    type="number"
                                    value={withdrawAmount}
                                    onChange={(e) => setWithdrawAmount(e.target.value)}
                                    placeholder="Enter amount"
                                    min="0"
                                    step="0.01"
                                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                                />
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={handleWithdraw}
                                    className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                                >
                                    Withdraw
                                </button>
                                <button
                                    onClick={() => {
                                        setShowWithdrawModal(false);
                                        setWithdrawAmount('');
                                    }}
                                    className="flex-1 px-4 py-2 bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-200 rounded-lg hover:bg-gray-400 dark:hover:bg-gray-500 transition-colors"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default PortfolioPage;



