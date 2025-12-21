'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AppHeader from '../components/AppHeader';
import CandlestickChart from '../components/CandlestickChart';
import StockSearch from '../components/StockSearch';
import TickerList from '../components/TickerList';
import Logo from '../components/Logo';
import AIInsight from '../components/AIInsight';
import AIInsightEnhanced from '../components/AIInsightEnhanced';
import EnhancedSignalPanel from '../components/EnhancedSignalPanel';
import ReportView from '../components/ReportView';
import ThemeToggle from '../components/ThemeToggle';
import FundamentalsView from '../components/FundamentalsView';
import NewsSentimentView from '../components/NewsSentimentView';
import VolumeAnalysisView from '../components/VolumeAnalysisView';
import PatternDetectionView from '../components/PatternDetectionView';
import MoneyFlowView from '../components/MoneyFlowView';
import OptionsView from '../components/OptionsView';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { getApiBaseUrl } from '../config';

interface SearchResult {
    symbol: string;
    name: string;
    type: string;
    exchange: string;
}

export default function DashboardPage() {
    const router = useRouter();
    const [selectedStock, setSelectedStock] = useState('AAPL');
    const [symbols, setSymbols] = useState<string[]>([]);
    const [showAddModal, setShowAddModal] = useState(false);
    const [newSymbol, setNewSymbol] = useState('');
    const [addError, setAddError] = useState('');
    const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
    const [showSearchDropdown, setShowSearchDropdown] = useState(false);
    const [user, setUser] = useState<any>(null);
    const [latestSignal, setLatestSignal] = useState('Hold');
    const [token, setToken] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<'chart' | 'fundamentals' | 'news' | 'patterns' | 'moneyflow' | 'options'>('chart');
    const [marketStatus, setMarketStatus] = useState<'open' | 'closed' | 'pre-market' | 'after-hours'>('closed');
    const [marketData, setMarketData] = useState({
        sp500: { value: 0, change: 0, changePercent: 0 },
        nasdaq: { value: 0, change: 0, changePercent: 0 },
        dow: { value: 0, change: 0, changePercent: 0 }
    });
    
    // Search for stocks
    const handleSearchStocks = async (query: string) => {
        if (query.length < 1) {
            setSearchResults([]);
            setShowSearchDropdown(false);
            return;
        }
        
        try {
            const apiUrl = getApiBaseUrl();
            const searchResponse = await fetch(`${apiUrl}/api/stocks/search?q=${encodeURIComponent(query)}`);
            if (searchResponse.ok) {
                const results = await searchResponse.json();
                setSearchResults(results);
                setShowSearchDropdown(results.length > 0);
            }
        } catch (error) {
            console.error('Error searching stocks:', error);
            setSearchResults([]);
            setShowSearchDropdown(false);
        }
    };
    
    // Add stock from search result
    const handleSelectSearchResult = async (stock: SearchResult) => {
        const symbol = stock.symbol.toUpperCase();
        setNewSymbol(symbol);
        setSearchResults([]);
        setShowSearchDropdown(false);
        
        if (symbols.includes(symbol)) {
            setAddError(`${symbol} is already in your watchlist`);
            return;
        }
        
        try {
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();
            const response = await fetch(`${apiUrl}/api/watchlist/add`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ symbol }),
            });
            
            if (response.ok) {
                setSymbols(prev => [...prev, symbol]);
                setSelectedStock(symbol);
                setShowAddModal(false);
                setNewSymbol('');
                setAddError('');
                setSearchResults([]);
            } else {
                const error = await response.json();
                setAddError(error.error || 'Failed to add stock');
            }
        } catch (error) {
            console.error('Error adding symbol:', error);
            setAddError('Error adding stock. Please try again.');
        }
    };
    
    // Add stock to watchlist (kept for Enter key functionality)
    const handleAddStock = async () => {
        const input = newSymbol.trim();
        if (!input) {
            setAddError('Please enter a stock symbol or name');
            return;
        }
        
        setAddError('Searching for stock...');
        
        try {
            const apiUrl = getApiBaseUrl();
            
            // First, search for the stock to validate and get the correct symbol
            const searchResponse = await fetch(`${apiUrl}/api/stocks/search?q=${encodeURIComponent(input)}`);
            if (!searchResponse.ok) {
                setAddError('Unable to search for stock. Please try again.');
                return;
            }
            
            const searchResults = await searchResponse.json();
            if (!searchResults || searchResults.length === 0) {
                setAddError('Stock not found. Please check the symbol or name.');
                return;
            }
            
            // Get the first matching result
            const stock = searchResults[0];
            const symbol = stock.symbol.toUpperCase();
            
            if (symbols.includes(symbol)) {
                setAddError(`${symbol} is already in your watchlist`);
                return;
            }
            
            // Add to watchlist
            const token = localStorage.getItem('token');
            const response = await fetch(`${apiUrl}/api/watchlist/add`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ symbol }),
            });
            
            if (response.ok) {
                setSymbols(prev => [...prev, symbol]);
                setSelectedStock(symbol);
                setShowAddModal(false);
                setNewSymbol('');
                setAddError('');
                setSearchResults([]);
            } else {
                const error = await response.json();
                setAddError(error.error || 'Failed to add stock');
            }
        } catch (error) {
            console.error('Error adding symbol:', error);
            setAddError('Error adding stock. Please try again.');
        }
    };
    
    // Remove stock from watchlist
    const handleRemoveStock = async (symbol: string) => {
        try {
            const token = localStorage.getItem('token');
            const apiUrl = getApiBaseUrl();
            const response = await fetch(`${apiUrl}/api/watchlist/remove/${symbol}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
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

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        const storedUser = localStorage.getItem('user');
        
        if (!storedToken) {
            router.push('/login');
        } else {
            setToken(storedToken);
            if (storedUser) {
                setUser(JSON.parse(storedUser));
            }
            
            // Load user's watchlist
            loadWatchlist(storedToken);
        }
    }, [router]);
    
    // Load user's watchlist
    const loadWatchlist = async (token: string) => {
        try {
            const apiUrl = getApiBaseUrl();
            const response = await fetch(`${apiUrl}/api/watchlist`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.success && data.watchlist.length > 0) {
                    setSymbols(data.watchlist);
                    setSelectedStock(data.watchlist[0]);
                } else {
                    // Default watchlist for new users
                    const defaultSymbols = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA'];
                    setSymbols(defaultSymbols);
                    setSelectedStock(defaultSymbols[0]);
                }
            }
        } catch (error) {
            console.error('Error loading watchlist:', error);
            // Fallback to default symbols
            const defaultSymbols = ['AAPL', 'GOOGL', 'MSFT', 'AMZN', 'TSLA'];
            setSymbols(defaultSymbols);
            setSelectedStock(defaultSymbols[0]);
        }
    };

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
        const fetchLatestSignal = async () => {
            if (!selectedStock || !token) return;
            try {
                const apiUrl = getApiBaseUrl();
                const response = await fetch(`${apiUrl}/api/signals/${selectedStock}`, {
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
        const resolveTicker = (nameOrSymbol: string) => {
            const map: Record<string, string> = {
                google: 'GOOGL',
                alphabet: 'GOOGL',
                'alphabet inc': 'GOOGL',
                microsoft: 'MSFT',
                apple: 'AAPL',
                amazon: 'AMZN',
                meta: 'META',
                facebook: 'META',
                nvidia: 'NVDA',
                tesla: 'TSLA',
            };
            const key = nameOrSymbol.trim().toLowerCase();
            // If user supplied a known mapping, use it; otherwise assume it's already a ticker
            return map[key] || nameOrSymbol.toUpperCase();
        };

        const ticker = resolveTicker(symbol);
        setSelectedStock(ticker);
        const apiUrl = getApiBaseUrl();
        const addUrl = `${apiUrl}/api/watchlist/add`;
        console.log('[WATCHLIST] API URL:', apiUrl);
        console.log('[WATCHLIST] Selected:', symbol, 'Resolved ticker:', ticker, 'addUrl:', addUrl);

        if (!symbols.includes(ticker)) {
            try {
                const token = localStorage.getItem('token');
                const response = await fetch(addUrl, {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify({ symbol: ticker }),
                });

                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    console.error('[WATCHLIST] Add failed:', response.status, text);
                    setSymbols(prev => prev.filter(s => s !== ticker));
                    return;
                }

                const result = await response.json().catch(() => ({}));
                console.log('[WATCHLIST] Add symbol response:', result);

                const listUrl = `${apiUrl}/api/watchlist`;
                const symbolsResponse = await fetch(listUrl).catch(err => {
                    console.error('[WATCHLIST] Refresh symbols error:', err);
                    return null as any;
                });
                if (symbolsResponse && symbolsResponse.ok) {
                    const updatedSymbols = await symbolsResponse.json().catch(() => []);
                    console.log('[WATCHLIST] Updated symbols:', updatedSymbols);
                    setSymbols(updatedSymbols);
                } else {
                    console.warn('[WATCHLIST] Failed to refresh symbols after add.');
                }
            } catch (error) {
                console.error('[WATCHLIST] Network error adding symbol:', error);
                setSymbols(prev => prev.filter(s => s !== ticker));
            }
        } else {
            try {
                const listUrl = `${apiUrl}/api/watchlist`;
                const symbolsResponse = await fetch(listUrl);
                if (symbolsResponse.ok) {
                    const updatedSymbols = await symbolsResponse.json().catch(() => symbols);
                    setSymbols(updatedSymbols);
                } else {
                    console.warn('[WATCHLIST] Refresh symbols failed:', symbolsResponse.status);
                }
            } catch (err) {
                console.error('[WATCHLIST] Network error refreshing symbols:', err);
            }
        }
    };

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

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900 pb-20 lg:pb-8">
            <AppHeader showSearch={true} onSelectStock={handleSelectStock} symbols={symbols} />

            {/* Main Content - Mobile Optimized */}
            <main className="max-w-full px-0 py-0">
                {/* Professional Dashboard Header - Desktop Only */}
                <div className="hidden md:flex mb-0 items-center justify-between bg-gradient-to-r from-blue-600 to-indigo-600 px-6 py-3 border-b-2 border-blue-700 shadow-lg">
                    <div className="flex items-center gap-3">
                        <span className="text-2xl">🎯</span>
                        <div>
                            <h2 className="text-base font-bold text-white">Professional Trading Dashboard</h2>
                            <p className="text-xs text-blue-100">Real-time market data & AI-powered insights</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className="h-2 w-2 rounded-full bg-green-400 animate-pulse"></div>
                        <span className="text-xs font-bold text-white">LIVE MARKET DATA</span>
                    </div>
                </div>

                {/* Mobile Dashboard Header */}
                <div className="md:hidden bg-gradient-to-r from-blue-600 to-indigo-600 px-3 py-2.5 border-b-2 border-blue-700 sticky z-40" style={{ top: '56px' }}>
                    <div className="flex items-center justify-between mb-2">
                        <h2 className="text-sm font-bold text-white">Professional Trading</h2>
                        <div className="flex items-center gap-1.5">
                            <div className="h-1.5 w-1.5 rounded-full bg-green-400 animate-pulse"></div>
                            <span className="text-[10px] font-bold text-white">LIVE DATA</span>
                        </div>
                    </div>
                    <p className="text-[10px] text-blue-100">Real-time market data & AI insights</p>
                </div>
                {/* Market Overview & Watchlist Row */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 mb-0">
                    {/* Market Overview Card */}
                    <div className="lg:col-span-1">
                        <div className="bg-white dark:bg-gray-800 shadow-xl border-r border-gray-200 dark:border-gray-700 overflow-hidden h-full">
                            <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-emerald-600 to-teal-600">
                                <div className="flex items-center space-x-2">
                                    <span className="text-white text-lg">🌍</span>
                                    <div>
                                        <h3 className="text-sm font-bold text-white">Market Overview</h3>
                                        <p className="text-xs text-emerald-100">Global indices</p>
                                    </div>
                                </div>
                            </div>
                            <div className="p-3 space-y-2">
                                <div className="flex justify-between items-center p-2 sm:p-2.5 bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-700 dark:to-gray-750 rounded-lg active:shadow-md transition-shadow touch-manipulation">
                                    <span className="text-xs sm:text-sm font-semibold text-gray-700 dark:text-gray-300">S&P 500</span>
                                    <div className="text-right">
                                        <div className="text-xs sm:text-sm font-bold text-gray-900 dark:text-white">4,234.50</div>
                                        <div className="text-[10px] sm:text-xs font-medium text-green-600 dark:text-green-400">▲ +0.8%</div>
                                    </div>
                                </div>
                                <div className="flex justify-between items-center p-2 sm:p-2.5 bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-700 dark:to-gray-750 rounded-lg active:shadow-md transition-shadow touch-manipulation">
                                    <span className="text-xs sm:text-sm font-semibold text-gray-700 dark:text-gray-300">NASDAQ</span>
                                    <div className="text-right">
                                        <div className="text-xs sm:text-sm font-bold text-gray-900 dark:text-white">12,845.20</div>
                                        <div className="text-[10px] sm:text-xs font-medium text-green-600 dark:text-green-400">▲ +1.2%</div>
                                    </div>
                                </div>
                                <div className="flex justify-between items-center p-2 sm:p-2.5 bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-700 dark:to-gray-750 rounded-lg active:shadow-md transition-shadow touch-manipulation">
                                    <span className="text-xs sm:text-sm font-semibold text-gray-700 dark:text-gray-300">DOW</span>
                                    <div className="text-right">
                                        <div className="text-xs sm:text-sm font-bold text-gray-900 dark:text-white">33,456.80</div>
                                        <div className="text-[10px] sm:text-xs font-medium text-red-600 dark:text-red-400">▼ -0.3%</div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Watchlist Section */}
                    <div className="lg:col-span-2">
                        <div className="bg-white dark:bg-gray-800 shadow-xl overflow-hidden h-full">
                            <div className="px-3 sm:px-4 py-2 sm:py-2.5 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-blue-600 to-indigo-600">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center space-x-2">
                                        <span className="text-white text-base sm:text-lg">📊</span>
                                        <div>
                                            <h2 className="text-xs sm:text-sm font-bold text-white">Watchlist</h2>
                                            <p className="text-[10px] sm:text-xs text-blue-100">Track your favorite stocks</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-1.5 sm:gap-2">
                                        <button
                                            onClick={() => setShowAddModal(true)}
                                            className="bg-white active:bg-blue-50 text-blue-600 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg text-xs sm:text-sm font-bold transition-colors flex items-center gap-1 touch-manipulation min-h-[36px] sm:min-h-[32px]"
                                            title="Add Stock to Watchlist"
                                        >
                                            <span className="text-lg">+</span>
                                            <span className="hidden sm:inline">Add</span>
                                        </button>
                                        <div className="text-xs font-bold text-white bg-blue-700 px-2 py-1 rounded">
                                            {symbols.length}
                                        </div>
                                    </div>
                                </div>
                            </div>
                            <div className="p-3">
                                <TickerList symbols={symbols} onSelectStock={handleSelectStock} selectedStock={selectedStock} onRemoveStock={handleRemoveStock} />
                            </div>
                        </div>
                    </div>
                </div>

                {/* Main Analysis Grid */}
                <div className="grid grid-cols-1 xl:grid-cols-5 gap-0">
                    {/* Primary Analysis Panel */}
                    <div className="xl:col-span-3">
                        <div className="bg-white dark:bg-gray-800 shadow-xl border-r border-gray-200 dark:border-gray-700 overflow-hidden">
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
                                            className={`flex items-center space-x-2 px-4 py-3 text-sm font-semibold whitespace-nowrap border-b-2 transition-all duration-200 ${
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
                            <div className="p-0 sm:p-4 min-h-[500px] sm:min-h-[600px]">
                                {activeTab === 'chart' && (
                                    <CandlestickChart key={selectedStock} symbol={selectedStock} />
                                )}
                                {activeTab === 'fundamentals' && <FundamentalsView symbol={selectedStock} />}
                                {activeTab === 'news' && <NewsSentimentView symbol={selectedStock} />}
                                {activeTab === 'patterns' && <PatternDetectionView symbol={selectedStock} />}
                                {activeTab === 'options' && <OptionsView symbol={selectedStock} />}
                                {activeTab === 'moneyflow' && <MoneyFlowView symbol={selectedStock} />}
                            </div>
                        </div>
                    </div>

                    {/* Enhanced Sidebar */}
                    <div className="xl:col-span-2 space-y-0">
                        {/* Enhanced Signal Analysis Panel */}
                        <EnhancedSignalPanel symbol={selectedStock} interval="1d" />
                    </div>
                </div>

                {/* AI Insights, Volume Analysis, and Market Stats - Full Width Row */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 mt-0">
                    {/* AI Insights Card */}
                    <div className="bg-white dark:bg-gray-800 shadow-xl border-b border-r border-gray-200 dark:border-gray-700 overflow-hidden">
                        <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-purple-600 to-pink-600">
                            <div className="flex items-center space-x-2">
                                <span className="text-white text-lg">🤖</span>
                                <div>
                                    <h3 className="text-sm font-bold text-white">AI Insights</h3>
                                    <p className="text-xs text-purple-100">Smart analysis</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-3">
                            <AIInsightEnhanced signal={latestSignal} symbol={selectedStock} mode="ensemble" />
                        </div>
                    </div>

                    {/* Volume Analysis Card */}
                    <div className="bg-white dark:bg-gray-800 shadow-xl border-b border-r border-gray-200 dark:border-gray-700 overflow-hidden">
                        <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-green-600 to-emerald-600">
                            <div className="flex items-center space-x-2">
                                <span className="text-white text-lg">📊</span>
                                <div>
                                    <h3 className="text-sm font-bold text-white">Volume Analysis</h3>
                                    <p className="text-xs text-green-100">Trading activity</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-3">
                            <VolumeAnalysisView symbol={selectedStock} />
                        </div>
                    </div>

                    {/* Market Stats Card */}
                    <div className="bg-white dark:bg-gray-800 shadow-xl border-b border-gray-200 dark:border-gray-700 overflow-hidden">
                        <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-cyan-600 to-blue-600">
                            <div className="flex items-center space-x-2">
                                <span className="text-white text-lg">📈</span>
                                <div>
                                    <h3 className="text-sm font-bold text-white">Market Stats</h3>
                                    <p className="text-xs text-cyan-100">Key metrics</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-3">
                            <div className="grid grid-cols-2 gap-2">
                                <div className="text-center p-2.5 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-lg border border-blue-100 dark:border-blue-800/30 hover:shadow-md transition-all">
                                    <div className="text-xs font-medium text-blue-600 dark:text-blue-400">Volume</div>
                                    <div className="text-sm font-bold text-gray-900 dark:text-white mt-0.5">2.4B</div>
                                </div>
                                <div className="text-center p-2.5 bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 rounded-lg border border-purple-100 dark:border-purple-800/30 hover:shadow-md transition-all">
                                    <div className="text-xs font-medium text-purple-600 dark:text-purple-400">Avg Vol</div>
                                    <div className="text-sm font-bold text-gray-900 dark:text-white mt-0.5">3.1B</div>
                                </div>
                                <div className="text-center p-2.5 bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20 rounded-lg border border-emerald-100 dark:border-emerald-800/30 hover:shadow-md transition-all">
                                    <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">P/E Ratio</div>
                                    <div className="text-sm font-bold text-gray-900 dark:text-white mt-0.5">18.5</div>
                                </div>
                                <div className="text-center p-2.5 bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20 rounded-lg border border-amber-100 dark:border-amber-800/30 hover:shadow-md transition-all">
                                    <div className="text-xs font-medium text-amber-600 dark:text-amber-400">Beta</div>
                                    <div className="text-sm font-bold text-gray-900 dark:text-white mt-0.5">1.02</div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Enhanced Report Section */}
                <div className="mt-0">
                    <div className="bg-white dark:bg-gray-800 shadow-xl border-t border-gray-200 dark:border-gray-700 overflow-hidden">
                        <div className="px-4 py-2.5 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-indigo-600 to-blue-600">
                            <div className="flex items-center space-x-2">
                                <span className="text-white text-lg">📋</span>
                                <div>
                                    <h3 className="text-sm font-bold text-white">Comprehensive Report</h3>
                                    <p className="text-xs text-indigo-100">Detailed analysis and insights</p>
                                </div>
                            </div>
                        </div>
                        <div className="p-3">
                            <ReportView symbol={selectedStock} token={token} />
                        </div>
                    </div>
                </div>
            </main>
            
            {/* Add Stock Modal */}
            {showAddModal && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl max-w-md w-full border border-gray-200 dark:border-gray-700">
                        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-blue-600 to-indigo-600">
                            <div className="flex items-center justify-between">
                                <h3 className="text-lg font-bold text-white flex items-center space-x-2">
                                    <span>📊</span>
                                    <span>Add Stock to Watchlist</span>
                                </h3>
                                <button
                                    onClick={() => {
                                        setShowAddModal(false);
                                        setNewSymbol('');
                                        setAddError('');
                                    }}
                                    className="text-white hover:text-gray-200 transition-colors"
                                >
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>
                        </div>
                        <div className="p-6">
                            <div className="mb-4 relative">
                                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                                    Stock Symbol or Name
                                </label>
                                <input
                                    type="text"
                                    value={newSymbol}
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        setNewSymbol(value);
                                        setAddError('');
                                        handleSearchStocks(value);
                                    }}
                                    onKeyPress={(e) => {
                                        if (e.key === 'Enter') {
                                            handleAddStock();
                                        }
                                    }}
                                    placeholder="e.g., AAPL, Tesla, Microsoft"
                                    className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                                    autoFocus
                                />
                                {/* Search Results Dropdown */}
                                {showSearchDropdown && searchResults.length > 0 && (
                                    <div className="absolute z-50 w-full mt-1 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg max-h-60 overflow-y-auto">
                                        {searchResults.map((stock) => (
                                            <div
                                                key={stock.symbol}
                                                onClick={() => handleSelectSearchResult(stock)}
                                                className="px-4 py-3 cursor-pointer hover:bg-blue-50 dark:hover:bg-gray-600 border-b border-gray-200 dark:border-gray-600 last:border-b-0 transition-colors"
                                            >
                                                <div className="flex justify-between items-start">
                                                    <div className="flex-1">
                                                        <div className="font-bold text-gray-900 dark:text-white">{stock.symbol}</div>
                                                        <div className="text-sm text-gray-600 dark:text-gray-300">{stock.name}</div>
                                                    </div>
                                                    <div className="text-xs text-gray-500 dark:text-gray-400 ml-2">{stock.exchange}</div>
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                )}
                                {addError && (
                                    <p className="mt-2 text-sm text-red-600 dark:text-red-400">{addError}</p>
                                )}
                            </div>
                            <div className="flex gap-3">
                                <button
                                    onClick={handleAddStock}
                                    className="flex-1 px-4 py-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white rounded-lg font-semibold transition-all shadow-md"
                                >
                                    Add Stock
                                </button>
                                <button
                                    onClick={() => {
                                        setShowAddModal(false);
                                        setNewSymbol('');
                                        setAddError('');
                                    }}
                                    className="px-4 py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-lg font-semibold transition-colors"
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

