'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import StockSearch from './StockSearch';
import ThemeToggle from './ThemeToggle';

interface AppHeaderProps {
    onSelectStock?: (symbol: string) => void;
    showSearch?: boolean;
    symbols?: string[];
}

const AppHeader: React.FC<AppHeaderProps> = ({ onSelectStock, showSearch = true, symbols = [] }) => {
    const pathname = usePathname();
    const router = useRouter();
    const [user, setUser] = useState<any>(null);
    const [marketStatus, setMarketStatus] = useState<'open' | 'closed' | 'pre-market' | 'after-hours'>('closed');
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    useEffect(() => {
        const storedUser = localStorage.getItem('user');
        if (storedUser) {
            setUser(JSON.parse(storedUser));
        }

        // Check market status
        const checkMarketStatus = () => {
            const now = new Date();
            const day = now.getDay();
            const hour = now.getHours();
            const minute = now.getMinutes();
            const time = hour + minute / 60;

            if (day === 0 || day === 6) {
                setMarketStatus('closed');
            } else if (time >= 4 && time < 9.5) {
                setMarketStatus('pre-market');
            } else if (time >= 9.5 && time < 16) {
                setMarketStatus('open');
            } else if (time >= 16 && time < 20) {
                setMarketStatus('after-hours');
            } else {
                setMarketStatus('closed');
            }
        };

        checkMarketStatus();
        const interval = setInterval(checkMarketStatus, 60000);
        return () => clearInterval(interval);
    }, []);

    const handleLogout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        router.push('/login');
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

    const navItems = [
        { href: '/dashboard', label: 'Dashboard', icon: '📊' },
        { href: '/portfolio', label: 'Portfolio', icon: '💼' },
        { href: '/alerts', label: 'Alerts', icon: '🔔' },
        { href: '/weekly', label: 'Next Week', icon: '📅' },
        { href: '/ai-trading', label: 'AI Trading', icon: '🤖' },
        { href: '/swing-trading', label: 'Swing', icon: '📈' },
        { href: '/backtest', label: 'Backtest', icon: '📊' },
        { href: '/scalping', label: 'Scalping', icon: '⚡' },
        { href: '/scenarios', label: 'Scenarios', icon: '🎯' },
    ];

    return (
        <>
            {/* Professional Header - Mobile Optimized */}
            <header className="bg-gradient-to-r from-slate-900 via-gray-900 to-slate-900 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 border-b border-gray-700 shadow-2xl sticky top-0 z-50">
                <div className="max-w-full px-3 sm:px-6">
                    <div className="flex items-center justify-between h-14 gap-2 sm:gap-4">
                        {/* Logo and Branding */}
                        <div className="flex items-center space-x-2 sm:space-x-4">
                            <div className="flex items-center space-x-2 sm:space-x-3">
                                <div className="p-1.5 sm:p-2 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg">
                                    <span className="text-white text-base sm:text-lg font-bold">📈</span>
                                </div>
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h1 className="text-lg font-bold text-white">
                                            AI Trading Pro
                                        </h1>
                                        <span className="px-2 py-0.5 bg-green-500 text-white text-xs font-bold rounded animate-pulse">LIVE</span>
                                    </div>
                                    <p className="text-xs text-gray-400">
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
                                <div className="text-xs text-gray-400">Market Time</div>
                                <div className="text-sm font-bold text-white">
                                    {new Date().toLocaleTimeString()}
                                </div>
                            </div>
                        </div>

                        {/* Market Overview Bar */}
                        {symbols.length > 0 && (
                            <div className="hidden lg:flex items-center space-x-4">
                                {symbols.slice(0, 3).map((symbol) => (
                                    <div key={symbol} className="flex items-center space-x-2 px-3 py-1 bg-gray-100 dark:bg-gray-700 rounded-lg">
                                        <span className="text-sm font-medium text-gray-900 dark:text-white">{symbol}</span>
                                        <span className="text-xs text-green-600 dark:text-green-400">+1.2%</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        {/* Search Bar */}
                        {showSearch && onSelectStock && (
                            <div className="w-full md:w-64 relative" style={{ zIndex: 999999 }}>
                                <StockSearch onSelectStock={onSelectStock} />
                            </div>
                        )}

                        {/* User Actions */}
                        <div className="flex items-center space-x-3">
                            {/* User Info */}
                            {user && (
                                <div className="hidden md:flex items-center space-x-2 px-3 py-1.5 bg-gray-700 rounded-lg">
                                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white font-bold text-sm">
                                        {user.firstName ? user.firstName.charAt(0).toUpperCase() : user.username.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="text-left">
                                        <div className="text-sm font-semibold text-white">
                                            {user.firstName && user.lastName 
                                                ? `${user.firstName} ${user.lastName}` 
                                                : user.username}
                                        </div>
                                        <div className="text-xs text-gray-400">
                                            {user.email || 'Trader'}
                                        </div>
                                    </div>
                                </div>
                            )}
                            
                            <div className="flex items-center space-x-2">
                                <Link
                                    href="/profile"
                                    className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors"
                                    title="Profile Settings"
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
            <nav className="bg-gradient-to-r from-gray-800 to-gray-900 dark:from-gray-900 dark:to-gray-800 border-b border-gray-700 sticky top-0 z-40 shadow-xl">
                <div className="max-w-full px-6">
                    <div className="flex items-center space-x-1 overflow-x-auto scrollbar-hide py-2">
                        {navItems.map((item) => (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`flex items-center space-x-2 px-4 py-2 text-sm font-semibold whitespace-nowrap transition-all duration-200 border-b-2 ${
                                    pathname === item.href
                                        ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white border-blue-400 shadow-lg'
                                        : 'text-gray-300 hover:text-white hover:bg-gray-700/50 border-transparent hover:border-gray-600'
                                } rounded-t-lg`}
                            >
                                <span>{item.icon}</span>
                                <span>{item.label}</span>
                            </Link>
                        ))}
                    </div>
                </div>
            </nav>
        </>
    );
};

export default AppHeader;
