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
        { href: '/news', label: 'News', icon: '📰' },
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
            <header className="bg-gradient-to-r from-slate-900 via-gray-900 to-slate-900 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 md:border-b border-gray-700 shadow-2xl sticky top-0 z-50">
                <div className="max-w-full px-3 sm:px-4 lg:px-6">
                    <div className="flex items-center justify-between h-14 sm:h-16 gap-2">
                        {/* Logo - Always Visible */}
                        <div className="flex items-center gap-2">
                            <div className="p-1.5 sm:p-2 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-lg">
                                <span className="text-white text-base sm:text-lg font-bold">📈</span>
                            </div>
                            <div>
                                <div className="flex items-center gap-1.5 sm:gap-2">
                                    <h1 className="text-sm sm:text-base lg:text-lg font-bold text-white">AI Trading Pro</h1>
                                    <span className="px-1.5 py-0.5 bg-green-500 text-white text-[10px] sm:text-xs font-bold rounded animate-pulse">LIVE</span>
                                </div>
                                <p className="text-[10px] sm:text-xs text-gray-400 hidden sm:block">Professional Trading</p>
                            </div>
                        </div>

                        {/* Market Status - Visible on Mobile */}
                        <div className="flex items-center gap-2">
                            <div className={`flex items-center gap-1.5 px-2 sm:px-3 py-1 sm:py-1.5 rounded-full text-[10px] sm:text-xs font-medium ${getMarketStatusColor()}`}>
                                <div className={`w-1.5 sm:w-2 h-1.5 sm:h-2 rounded-full ${marketStatus === 'open' ? 'bg-green-400 animate-pulse' : 'bg-gray-400'}`}></div>
                                <span className="hidden sm:inline">{getMarketStatusText()}</span>
                                <span className="sm:hidden">{marketStatus === 'open' ? 'Open' : 'Closed'}</span>
                            </div>
                        </div>

                        {/* Search Bar - Desktop */}
                        {showSearch && onSelectStock && (
                            <div className="hidden md:block flex-1 max-w-md" style={{ zIndex: 999999 }}>
                                <StockSearch onSelectStock={onSelectStock} />
                            </div>
                        )}

                        {/* Desktop Actions */}
                        <div className="hidden lg:flex items-center gap-3">
                            {user && (
                                <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-700 rounded-lg">
                                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-indigo-500 flex items-center justify-center text-white font-bold text-sm">
                                        {user.firstName ? user.firstName.charAt(0).toUpperCase() : user.username?.charAt(0).toUpperCase()}
                                    </div>
                                    <div className="hidden xl:block text-left">
                                        <div className="text-sm font-semibold text-white">
                                            {user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.username}
                                        </div>
                                    </div>
                                </div>
                            )}
                            <Link href="/profile" className="p-2 text-gray-400 hover:text-white hover:bg-gray-700 rounded-lg transition-colors" title="Settings">
                                ⚙️
                            </Link>
                            <ThemeToggle />
                            <button onClick={handleLogout} className="px-3 py-1.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors">
                                Logout
                            </button>
                        </div>

                        {/* Mobile Menu Button */}
                        <button
                            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
                            className="lg:hidden p-2 text-white hover:bg-gray-700 rounded-lg transition-colors touch-manipulation"
                            aria-label="Toggle menu"
                        >
                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                {mobileMenuOpen ? (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                ) : (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                                )}
                            </svg>
                        </button>
                    </div>
                </div>
            </header>

            {/* Desktop Navigation */}
            <nav className="hidden lg:block bg-gradient-to-r from-gray-800 to-gray-900 border-b border-gray-700 sticky top-14 sm:top-16 z-40">
                <div className="max-w-full px-6">
                    <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide py-1">
                        {navItems.map((item) => (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`flex items-center gap-2 px-4 py-2 text-sm font-semibold whitespace-nowrap transition-all rounded-t-lg border-b-2 ${
                                    pathname === item.href
                                        ? 'bg-gradient-to-r from-blue-600 to-indigo-600 text-white border-blue-400'
                                        : 'text-gray-300 hover:text-white hover:bg-gray-700/50 border-transparent'
                                }`}
                            >
                                <span>{item.icon}</span>
                                <span>{item.label}</span>
                            </Link>
                        ))}
                    </div>
                </div>
            </nav>

            {/* Mobile Bottom Navigation */}
            <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-gray-900 border-t border-gray-700 z-50 safe-area-inset-bottom">
                <div className="flex justify-around items-center h-16">
                    {navItems.slice(0, 5).map((item) => (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={`flex flex-col items-center justify-center flex-1 h-full gap-1 transition-colors touch-manipulation ${
                                pathname === item.href
                                    ? 'text-blue-400 bg-gray-800'
                                    : 'text-gray-400 active:bg-gray-800'
                            }`}
                        >
                            <span className="text-xl">{item.icon}</span>
                            <span className="text-[10px] font-medium">{item.label.split(' ')[0]}</span>
                        </Link>
                    ))}
                </div>
            </nav>

            {/* Mobile Slide-out Menu */}
            {mobileMenuOpen && (
                <>
                    <div className="lg:hidden fixed inset-0 z-50 bg-black bg-opacity-50 touch-manipulation" onClick={() => setMobileMenuOpen(false)} />
                    <div className="lg:hidden fixed right-0 top-0 bottom-0 w-80 max-w-[85vw] bg-gray-900 shadow-2xl overflow-y-auto z-50 touch-manipulation">
                        <div className="p-4">
                            {/* Mobile Menu Header */}
                            <div className="flex items-center justify-between mb-6">
                                <h2 className="text-xl font-bold text-white">Menu</h2>
                                <button onClick={() => setMobileMenuOpen(false)} className="p-2 text-gray-400 hover:text-white rounded-lg hover:bg-gray-800 touch-manipulation">
                                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                                    </svg>
                                </button>
                            </div>

                            {/* User Info */}
                            {user && (
                                <div className="mb-6 p-4 bg-gray-800 rounded-lg">
                                    <div className="flex items-center gap-3">
                                        <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white font-semibold text-lg">
                                            {user.firstName ? user.firstName.charAt(0).toUpperCase() : user.username?.charAt(0).toUpperCase()}
                                        </div>
                                        <div>
                                            <div className="text-white font-medium">
                                                {user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : user.username}
                                            </div>
                                            <div className="text-gray-400 text-sm">{user.email || 'Trader'}</div>
                                        </div>
                                    </div>
                                    <div className={`mt-3 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium ${getMarketStatusColor()}`}>
                                        <div className={`w-2 h-2 rounded-full ${marketStatus === 'open' ? 'bg-green-400 animate-pulse' : 'bg-gray-400'}`}></div>
                                        <span>{getMarketStatusText()}</span>
                                    </div>
                                </div>
                            )}

                            {/* Search Bar - Mobile */}
                            {showSearch && onSelectStock && (
                                <div className="mb-6">
                                    <StockSearch onSelectStock={(symbol) => {
                                        onSelectStock(symbol);
                                        setMobileMenuOpen(false);
                                    }} />
                                </div>
                            )}

                            {/* All Navigation Links */}
                            <nav className="space-y-1 mb-6">
                                {navItems.map((item) => (
                                    <Link
                                        key={item.href}
                                        href={item.href}
                                        onClick={() => setMobileMenuOpen(false)}
                                        className={`flex items-center gap-3 px-4 py-3 rounded-lg font-medium transition-all touch-manipulation min-h-[44px] ${
                                            pathname === item.href
                                                ? 'bg-blue-600 text-white'
                                                : 'text-gray-300 hover:bg-gray-800 hover:text-white active:bg-gray-700'
                                        }`}
                                    >
                                        <span className="text-xl">{item.icon}</span>
                                        <span>{item.label}</span>
                                    </Link>
                                ))}
                            </nav>

                            {/* Bottom Actions */}
                            <div className="pt-4 border-t border-gray-700 space-y-3">
                                <Link
                                    href="/profile"
                                    onClick={() => setMobileMenuOpen(false)}
                                    className="flex items-center gap-3 px-4 py-3 text-gray-300 hover:bg-gray-800 hover:text-white rounded-lg transition-colors touch-manipulation min-h-[44px]"
                                >
                                    <span className="text-xl">⚙️</span>
                                    <span>Settings</span>
                                </Link>
                                <div className="flex items-center justify-between px-4 py-2">
                                    <span className="text-gray-300">Dark Mode</span>
                                    <ThemeToggle />
                                </div>
                                <button
                                    onClick={() => {
                                        handleLogout();
                                        setMobileMenuOpen(false);
                                    }}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-red-400 hover:bg-red-900/20 active:bg-red-900/30 rounded-lg transition-colors touch-manipulation min-h-[44px]"
                                >
                                    <span className="text-xl">🚪</span>
                                    <span>Logout</span>
                                </button>
                            </div>
                        </div>
                    </div>
                </>
            )}

            {/* Spacer for mobile bottom nav */}
            <div className="lg:hidden h-16" />
        </>
    );
};

export default AppHeader;
