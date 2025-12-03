'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import CandlestickChart from '../components/CandlestickChart';
import StockSearch from '../components/StockSearch';
import TickerList from '../components/TickerList';
import Logo from '../components/Logo';
import AIInsight from '../components/AIInsight';
import AIInsightEnhanced from '../components/AIInsightEnhanced';
import ReportView from '../components/ReportView';
import ThemeToggle from '../components/ThemeToggle';
import FundamentalsView from '../components/FundamentalsView';
import NewsSentimentView from '../components/NewsSentimentView';
import VolumeAnalysisView from '../components/VolumeAnalysisView';
import PatternDetectionView from '../components/PatternDetectionView';
import MoneyFlowView from '../components/MoneyFlowView';
import OptionsView from '../components/OptionsView';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { API_BASE_URL } from '../config';

export default function DashboardPage() {
    const router = useRouter();
    const [selectedStock, setSelectedStock] = useState('AAPL');
    const [symbols, setSymbols] = useState<string[]>(['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA']);
    // Remove stock from watchlist
    const handleRemoveStock = async (symbol: string) => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/stocks/symbols/${symbol}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                },
            });
            if (response.ok) {
                setSymbols(prev => prev.filter(s => s !== symbol));
                // If the removed symbol was selected, select another
                if (selectedStock === symbol && symbols.length > 1) {
                    setSelectedStock(symbols.find(s => s !== symbol) || '');
                }
            } else {
                console.error('Failed to remove symbol from watchlist');
            }
        } catch (error) {
            console.error('Error removing symbol:', error);
        }
    };
    const [latestSignal, setLatestSignal] = useState('Hold');
    const [token, setToken] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'chart' | 'fundamentals' | 'news' | 'patterns' | 'moneyflow' | 'options'>('chart');
    const [marketStatus, setMarketStatus] = useState<'open' | 'closed' | 'pre-market' | 'after-hours'>('closed');
    const [marketData, setMarketData] = useState({
        sp500: { value: 0, change: 0, changePercent: 0 },
        nasdaq: { value: 0, change: 0, changePercent: 0 },
        dow: { value: 0, change: 0, changePercent: 0 }
    });

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        if (!storedToken) {
            router.push('/login');
        } else {
            setToken(storedToken);
        }
    }, [router]);

    // Market status and data
    useEffect(() => {
        const updateMarketStatus = () => {
            const now = new Date();
            const day = now.getDay();
            const hour = now.getHours();
            const minute = now.getMinutes();
            const currentTime = hour * 60 + minute;

            // Market hours: Mon-Fri, 9:30 AM - 4:00 PM EST
            if (day >= 1 && day <= 5) {
                if (currentTime >= 570 && currentTime < 960) { // 9:30 AM - 4:00 PM
                    setMarketStatus('open');
                } else if (currentTime >= 480 && currentTime < 570) { // 8:00 AM - 9:30 AM
                    setMarketStatus('pre-market');
                } else if (currentTime >= 960 && currentTime < 1200) { // 4:00 PM - 8:00 PM
                    setMarketStatus('after-hours');
                } else {
                    setMarketStatus('closed');
                }
            } else {
                setMarketStatus('closed');
            }
        };

        updateMarketStatus();
        const interval = setInterval(updateMarketStatus, 60000); // Update every minute
        return () => clearInterval(interval);
    }, []);

    // Fetch market data
    useEffect(() => {
        const fetchMarketData = async () => {
            try {
                // This would typically fetch from an API, for now using mock data
                setMarketData({
                    sp500: { value: 4500.25, change: 15.30, changePercent: 0.34 },
                    nasdaq: { value: 14250.80, change: -25.45, changePercent: -0.18 },
                    dow: { value: 35600.50, change: 85.20, changePercent: 0.24 }
                });
            } catch (error) {
                console.error('Error fetching market data:', error);
            }
        };

        fetchMarketData();
        const interval = setInterval(fetchMarketData, 300000); // Update every 5 minutes
        return () => clearInterval(interval);
    }, []);

    // Logout handler
    const handleLogout = () => {
        localStorage.removeItem('token');
        setToken(null);
        router.push('/login');
    };

    useEffect(() => {
        const fetchSymbols = async () => {
            try {
                // Make unauthenticated request since backend routes are currently unprotected
                const response = await fetch(`${API_BASE_URL}/api/stocks/symbols`);
                
                if (response.ok) {
                    const data = await response.json();
                    setSymbols(data);
                    if (data.length > 0 && !data.includes(selectedStock)) {
                        setSelectedStock(data[0]);
                    }
                } else {
                    console.error('Failed to fetch symbols');
                }
            } catch (error) {
                console.error('Error fetching symbols:', error);
            }
        };

        fetchSymbols();
    }, [selectedStock]);

    useEffect(() => {
        const fetchLatestSignal = async () => {
            if (!selectedStock || !token) return;
            try {
                const response = await fetch(`${API_BASE_URL}/api/signals/${selectedStock}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (response.ok) {
                    const data = await response.json();
                    setLatestSignal(data.signal);
                } else {
                    setLatestSignal('Hold');
                }
            } catch (error) {
                console.error('Error fetching latest signal:', error);
                setLatestSignal('Hold');
            }
        };

        fetchLatestSignal();
    }, [selectedStock, token]);

    const handleSelectStock = async (symbol: string) => {
        setSelectedStock(symbol);
        if (!symbols.includes(symbol)) {
            try {
                console.log('[WATCHLIST] Attempting to add symbol:', symbol);
                const response = await fetch(`${API_BASE_URL}/api/stocks/symbols`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ symbol }),
                });
                const result = await response.json();
                console.log('[WATCHLIST] Add symbol response:', result);
                if (response.ok) {
                    // Force refresh symbols from backend
                    const symbolsResponse = await fetch(`${API_BASE_URL}/api/stocks/symbols`);
                    if (symbolsResponse.ok) {
                        const updatedSymbols = await symbolsResponse.json();
                        console.log('[WATCHLIST] Updated symbols:', updatedSymbols);
                        setSymbols(updatedSymbols);
                    } else {
                        console.error('[WATCHLIST] Failed to refresh symbols after add.');
                    }
                } else {
                    console.error('[WATCHLIST] Backend did not accept symbol:', symbol);
                    setSymbols(prevSymbols => prevSymbols.filter(s => s !== symbol));
                }
            } catch (error) {
                console.error('[WATCHLIST] Error adding symbol:', error);
                setSymbols(prevSymbols => prevSymbols.filter(s => s !== symbol));
            }
        } else {
            // Always refresh to ensure UI is up-to-date
            const symbolsResponse = await fetch(`${API_BASE_URL}/api/stocks/symbols`);
            if (symbolsResponse.ok) {
                const updatedSymbols = await symbolsResponse.json();
                setSymbols(updatedSymbols);
            }
        }
    };

    // Render nothing or a loading spinner if not authenticated
    if (!token) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                    <p className="text-gray-600 dark:text-gray-400">Loading dashboard...</p>
                </div>
            </div>
        );
    }

    const getMarketStatusColor = () => {
        switch (marketStatus) {
            case 'open': return 'text-green-600 bg-green-100 dark:bg-green-900/30';
            case 'pre-market': return 'text-blue-600 bg-blue-100 dark:bg-blue-900/30';
            case 'after-hours': return 'text-orange-600 bg-orange-100 dark:bg-orange-900/30';
            default: return 'text-gray-600 bg-gray-100 dark:bg-gray-900/30';
        }
    };

    const getMarketStatusText = () => {
        switch (marketStatus) {
            case 'open': return 'Market Open';
            case 'pre-market': return 'Pre-Market';
            case 'after-hours': return 'After Hours';
            default: return 'Market Closed';
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50 to-indigo-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 px-2 sm:px-0">
            {/* Enhanced Header */}
            <header className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-lg border-b border-gray-200/50 dark:border-gray-700/50 shadow-lg">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex flex-col md:flex-row items-center justify-between h-auto md:h-20 gap-2 md:gap-0">
                        {/* Logo and Branding */}
                        <div className="flex items-center space-x-4">
                            <div className="flex items-center space-x-3">
                                <div className="p-2 bg-gradient-to-r from-blue-600 to-indigo-600 rounded-xl shadow-lg">
                                    <span className="text-white text-xl font-bold">📈</span>
                                </div>
                                <div>
                                    <h1 className="text-xl md:text-2xl font-bold text-gray-900 dark:text-white">
                                        AI Trading
                                    </h1>
                                    <p className="text-xs md:text-sm text-gray-600 dark:text-gray-400">
                                        Professional Trading Platform
                                    </p>
                                </div>
                            </div>
                        </div>

                        {/* Market Status */}
                        <div className="hidden md:flex items-center space-x-6">
                            <div className={`flex items-center space-x-2 px-3 py-1.5 rounded-full text-sm font-medium ${getMarketStatusColor()}`}>
                                <div className={`w-2 h-2 rounded-full ${marketStatus === 'open' ? 'bg-green-400 animate-pulse' : marketStatus === 'pre-market' ? 'bg-blue-400' : 'bg-gray-400'}`}></div>
                                <span>{getMarketStatusText()}</span>
                            </div>
                            <div className="text-right">
                                <div className="text-xs text-gray-500 dark:text-gray-400">Market Time</div>
                                <div className="text-sm font-semibold text-gray-900 dark:text-white">
                                    {new Date().toLocaleTimeString()}
                                </div>
                            </div>
                        </div>

                        {/* Market Overview Bar */}
                        <div className="hidden lg:flex items-center space-x-4">
                            {symbols.slice(0, 3).map((symbol) => (
                                <div key={symbol} className="flex items-center space-x-2 px-3 py-1 bg-gray-100 dark:bg-gray-700 rounded-lg">
                                    <span className="text-sm font-medium text-gray-900 dark:text-white">{symbol}</span>
                                    <span className="text-xs text-green-600 dark:text-green-400">+1.2%</span>
                                </div>
                            ))}
                        </div>

                        {/* Search Bar */}
                        <div className="w-full md:w-64 relative" style={{ zIndex: 999999 }}>
                            <StockSearch onSelectStock={handleSelectStock} />
                        </div>

                        {/* User Actions */}
                        <div className="flex items-center space-x-2">
                            <div className="flex items-center space-x-2">
                                <Link
                                    href="/profile"
                                    className="p-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                                    title="Profile"
                                >
                                    ⚙️
                                </Link>
                                <ThemeToggle />
                            </div>
                            <button
                                onClick={handleLogout}
                                className="px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 rounded-lg shadow-md hover:shadow-lg transition-all duration-200"
                            >
                                Logout
                            </button>
                        </div>
                    </div>
                </div>
            </header>

            {/* Main Navigation - Sticky */}
            <nav className="bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm border-b border-gray-200/50 dark:border-gray-700/50 sticky top-12 md:top-20 z-40">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex items-center space-x-1 overflow-x-auto scrollbar-hide py-2">
                        {[
                            { href: '/dashboard', label: 'Dashboard', icon: '📊', active: true },
                            { href: '/portfolio', label: 'Portfolio', icon: '💼' },
                            { href: '/alerts', label: 'Alerts', icon: '🔔' },
                            { href: '/weekly', label: 'Next Week', icon: '📅' },
                            { href: '/ai-trading', label: 'AI Trading', icon: '🤖' },
                            { href: '/swing-trading', label: 'Swing', icon: '📈' },
                            { href: '/backtest', label: 'Backtest', icon: '📊' },
                            { href: '/scalping', label: 'Scalping', icon: '⚡' },
                            { href: '/scenarios', label: 'Scenarios', icon: '🎯' },
                        ].map((item) => (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`flex items-center space-x-2 px-4 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-all duration-200 ${
                                    item.active
                                        ? 'bg-blue-600 text-white shadow-md'
                                        : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700'
                                }`}
                            >
                                <span>{item.icon}</span>
                                <span>{item.label}</span>
                            </Link>
                        ))}
                    </div>
                </div>
            </nav>

            {/* Main Content */}
            <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
                {/* Market Overview & Watchlist Row */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
                    {/* Market Overview Card */}
                    <div className="lg:col-span-1">
                        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden h-full">
                            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20">
                                <div className="flex items-center space-x-3">
                                    <div className="p-2 bg-gradient-to-r from-emerald-600 to-teal-600 rounded-lg">
                                        <span className="text-white text-lg">🌍</span>
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-gray-900 dark:text-white">Market Overview</h3>
                                        <p className="text-sm text-gray-600 dark:text-gray-400">Global indices</p>
                                    </div>
                                </div>
                            </div>
                            <div className="p-4 space-y-3">
                                <div className="flex justify-between items-center p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">S&P 500</span>
                                    <div className="text-right">
                                        <div className="text-sm font-bold text-gray-900 dark:text-white">4,234.50</div>
                                        <div className="text-xs text-green-600 dark:text-green-400">+0.8%</div>
                                    </div>
                                </div>
                                <div className="flex justify-between items-center p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">NASDAQ</span>
                                    <div className="text-right">
                                        <div className="text-sm font-bold text-gray-900 dark:text-white">12,845.20</div>
                                        <div className="text-xs text-green-600 dark:text-green-400">+1.2%</div>
                                    </div>
                                </div>
                                <div className="flex justify-between items-center p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                                    <span className="text-sm font-medium text-gray-600 dark:text-gray-400">DOW</span>
                                    <div className="text-right">
                                        <div className="text-sm font-bold text-gray-900 dark:text-white">33,456.80</div>
                                        <div className="text-xs text-red-600 dark:text-red-400">-0.3%</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Watchlist Section */}
                    <div className="lg:col-span-2">
                        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden h-full">
                            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-gray-800 dark:to-gray-700">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center space-x-3">
                                        <div className="p-2 bg-blue-600 rounded-lg">
                                            <span className="text-white text-lg">📊</span>
                                        </div>
                                        <div>
                                            <h2 className="text-xl font-bold text-gray-900 dark:text-white">Watchlist</h2>
                                            <p className="text-sm text-gray-600 dark:text-gray-400">Track your favorite stocks</p>
                                        </div>
                                    </div>
                                    <div className="text-sm font-medium text-gray-500 dark:text-gray-400">
                                        {symbols.length} stocks
                                    </div>
                                </div>
                            </div>
                            <div className="p-6">
                                <TickerList symbols={symbols} onSelectStock={handleSelectStock} selectedStock={selectedStock} onRemoveStock={handleRemoveStock} />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Main Analysis Grid */}
                <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
                    {/* Primary Analysis Panel */}
                    <div className="xl:col-span-3">
                        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                            {/* Enhanced Tabs */}
                            <div className="border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                                <div className="flex overflow-x-auto scrollbar-hide">
                                    {[
                                        { id: 'chart', label: 'Chart Analysis', icon: '📈' },
                                        { id: 'fundamentals', label: 'Fundamentals', icon: '📊' },
                                        { id: 'news', label: 'News & Sentiment', icon: '📰' },
                                        { id: 'patterns', label: 'Patterns', icon: '📉' },
                                        { id: 'options', label: 'Options Chain', icon: '🎯' },
                                        { id: 'moneyflow', label: 'Money Flow', icon: '💰' },
                                    ].map((tab) => (
                                        <button
                                            key={tab.id}
                                            onClick={() => setActiveTab(tab.id as any)}
                                            className={`flex items-center space-x-2 px-6 py-4 text-sm font-semibold whitespace-nowrap border-b-2 transition-all duration-200 ${
                                                activeTab === tab.id
                                                    ? 'border-blue-600 text-blue-600 dark:text-blue-400 bg-white dark:bg-gray-800'
                                                    : 'border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700'
                                            }`}
                                        >
                                            <span>{tab.icon}</span>
                                            <span className="hidden sm:inline">{tab.label}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>

                            {/* Content Area */}
                            <div className="p-6 min-h-[600px]">
                                {activeTab === 'chart' && <CandlestickChart symbol={selectedStock} />}
                                {activeTab === 'fundamentals' && <FundamentalsView symbol={selectedStock} />}
                                {activeTab === 'news' && <NewsSentimentView symbol={selectedStock} />}
                                {activeTab === 'patterns' && <PatternDetectionView symbol={selectedStock} />}
                                {activeTab === 'options' && <OptionsView symbol={selectedStock} />}
                                {activeTab === 'moneyflow' && <MoneyFlowView symbol={selectedStock} />}
                            </div>
                        </div>
                    </div>

                    {/* Enhanced Sidebar */}
                    <div className="xl:col-span-2 space-y-4">
                        {/* AI Insights Card */}
                        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20">
                                <div className="flex items-center space-x-3">
                                    <div className="p-2 bg-gradient-to-r from-purple-600 to-pink-600 rounded-lg">
                                        <span className="text-white text-lg">🤖</span>
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-gray-900 dark:text-white">AI Insights</h3>
                                        <p className="text-sm text-gray-600 dark:text-gray-400">Smart analysis</p>
                                    </div>
                                </div>
                            </div>
                            <div className="p-6">
                                <AIInsightEnhanced signal={latestSignal} symbol={selectedStock} mode="ensemble" />
                            </div>
                        </div>

                        {/* Volume Analysis Card */}
                        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20">
                                <div className="flex items-center space-x-3">
                                    <div className="p-2 bg-gradient-to-r from-green-600 to-emerald-600 rounded-lg">
                                        <span className="text-white text-lg">📊</span>
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-gray-900 dark:text-white">Volume Analysis</h3>
                                        <p className="text-sm text-gray-600 dark:text-gray-400">Trading activity</p>
                                    </div>
                                </div>
                            </div>
                            <div className="p-6">
                                <VolumeAnalysisView symbol={selectedStock} />
                            </div>
                        </div>

                        {/* Quick Actions Card */}
                        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-orange-50 to-red-50 dark:from-orange-900/20 dark:to-red-900/20">
                                <div className="flex items-center space-x-3">
                                    <div className="p-2 bg-gradient-to-r from-orange-600 to-red-600 rounded-lg">
                                        <span className="text-white text-lg">⚡</span>
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-gray-900 dark:text-white">Quick Actions</h3>
                                        <p className="text-sm text-gray-600 dark:text-gray-400">Fast access</p>
                                    </div>
                                </div>
                            </div>
                            <div className="p-6 space-y-3">
                                <Link
                                    href="/portfolio"
                                    className="w-full flex items-center justify-center space-x-2 px-4 py-3 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 text-white rounded-lg font-medium transition-all duration-200 shadow-md hover:shadow-lg"
                                >
                                    <span>💼</span>
                                    <span>View Portfolio</span>
                                </Link>
                                <Link
                                    href="/ai-trading"
                                    className="w-full flex items-center justify-center space-x-2 px-4 py-3 bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 text-white rounded-lg font-medium transition-all duration-200 shadow-md hover:shadow-lg"
                                >
                                    <span>🤖</span>
                                    <span>AI Trading</span>
                                </Link>
                                <Link
                                    href="/alerts"
                                    className="w-full flex items-center justify-center space-x-2 px-4 py-3 bg-gradient-to-r from-green-600 to-green-700 hover:from-green-700 hover:to-green-800 text-white rounded-lg font-medium transition-all duration-200 shadow-md hover:shadow-lg"
                                >
                                    <span>🔔</span>
                                    <span>Set Alerts</span>
                                </Link>
                            </div>
                        </div>

                        {/* Market Stats Card */}
                        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-cyan-50 to-blue-50 dark:from-cyan-900/20 dark:to-blue-900/20">
                                <div className="flex items-center space-x-3">
                                    <div className="p-2 bg-gradient-to-r from-cyan-600 to-blue-600 rounded-lg">
                                        <span className="text-white text-lg">📈</span>
                                    </div>
                                    <div>
                                        <h3 className="text-lg font-bold text-gray-900 dark:text-white">Market Stats</h3>
                                        <p className="text-sm text-gray-600 dark:text-gray-400">Key metrics</p>
                                    </div>
                                </div>
                            </div>
                            <div className="p-4 space-y-3">
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                                        <div className="text-xs text-gray-600 dark:text-gray-400">Volume</div>
                                        <div className="text-sm font-bold text-gray-900 dark:text-white">2.4B</div>
                                    </div>
                                    <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                                        <div className="text-xs text-gray-600 dark:text-gray-400">Avg Vol</div>
                                        <div className="text-sm font-bold text-gray-900 dark:text-white">3.1B</div>
                                    </div>
                                    <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                                        <div className="text-xs text-gray-600 dark:text-gray-400">P/E Ratio</div>
                                        <div className="text-sm font-bold text-gray-900 dark:text-white">18.5</div>
                                    </div>
                                    <div className="text-center p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
                                        <div className="text-xs text-gray-600 dark:text-gray-400">Beta</div>
                                        <div className="text-sm font-bold text-gray-900 dark:text-white">1.02</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Enhanced Report Section */}
                <div className="mt-8">
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-indigo-50 to-blue-50 dark:from-indigo-900/20 dark:to-blue-900/20">
                            <div className="flex items-center space-x-3">
                                <div className="p-2 bg-gradient-to-r from-indigo-600 to-blue-600 rounded-lg">
                                    <span className="text-white text-lg">📋</span>
                                </div>
                                <div>
                                    <h3 className="text-xl font-bold text-gray-900 dark:text-white">Comprehensive Report</h3>
                                    <p className="text-sm text-gray-600 dark:text-gray-400">Detailed analysis and insights</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-6">
                            <ReportView symbol={selectedStock} token={token} />
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
