'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl } from '../config';

import { debounce } from 'lodash';
import { useNotifications } from '../contexts/NotificationContext';

type PopupMode = 'off' | 'news' | 'swing' | 'both';

const popupModeOptions: Array<{ value: PopupMode; label: string }> = [
    { value: 'off', label: 'Off' },
    { value: 'news', label: 'News only' },
    { value: 'swing', label: 'Swing only' },
    { value: 'both', label: 'Both' }
];

const freshnessToneClasses: Record<string, string> = {
    fresh: 'bg-emerald-100 text-emerald-800',
    aging: 'bg-amber-100 text-amber-800',
    stale: 'bg-rose-100 text-rose-800',
    unknown: 'bg-slate-100 text-slate-700'
};

function formatFreshnessLabel(state?: string) {
    if (state === 'fresh') return 'Fresh';
    if (state === 'aging') return 'Aging';
    if (state === 'stale') return 'Stale';
    return 'Unknown';
}

function formatMonitorTimestamp(value?: string | null) {
    if (!value) return 'Not run yet';
    return new Date(value).toLocaleString();
}

function formatRunOutcome(run: any) {
    if (run?.error) return 'Error';
    if ((run?.savedAlerts || 0) > 0) return 'Saved alerts';
    return 'No new alerts';
}

function averageMetric(runs: any[], key: string) {
    if (!runs.length) return 0;
    const total = runs.reduce((sum, run) => sum + Number(run?.[key] || 0), 0);
    return total / runs.length;
}

function getTrendDirection(currentValue: number, previousValue: number, preferred: 'up' | 'down') {
    const delta = currentValue - previousValue;
    const threshold = Math.max(0.5, Math.abs(previousValue) * 0.15);

    if (Math.abs(delta) < threshold) {
        return 'flat';
    }

    if (preferred === 'up') {
        return delta > 0 ? 'improving' : 'degrading';
    }

    return delta < 0 ? 'improving' : 'degrading';
}

function getTrendClasses(direction: string) {
    if (direction === 'improving') return 'bg-emerald-100 text-emerald-800';
    if (direction === 'degrading') return 'bg-rose-100 text-rose-800';
    return 'bg-slate-100 text-slate-700';
}

function getRecentRunTrend(status: any) {
    const runs = Array.isArray(status?.recentRuns) ? status.recentRuns.slice(0, 7) : [];
    const newestRuns = runs.slice(0, Math.min(3, runs.length));
    const olderRuns = runs.slice(Math.min(3, runs.length), Math.min(6, runs.length));
    const totals = runs.reduce((acc: any, run: any) => {
        acc.savedAlerts += run.savedAlerts || 0;
        acc.duplicateSkips += run.duplicateSkips || 0;
        acc.qualitySkips += run.qualitySkips || 0;
        acc.rawArticles += run.rawArticles || 0;
        return acc;
    }, {
        savedAlerts: 0,
        duplicateSkips: 0,
        qualitySkips: 0,
        rawArticles: 0
    });

    const count = runs.length || 1;

    return {
        runs,
        averages: {
            savedAlerts: Math.round((totals.savedAlerts / count) * 10) / 10,
            duplicateSkips: Math.round((totals.duplicateSkips / count) * 10) / 10,
            qualitySkips: Math.round((totals.qualitySkips / count) * 10) / 10,
            rawArticles: Math.round((totals.rawArticles / count) * 10) / 10
        },
        direction: {
            savedAlerts: olderRuns.length > 0
                ? getTrendDirection(averageMetric(newestRuns, 'savedAlerts'), averageMetric(olderRuns, 'savedAlerts'), 'up')
                : 'flat',
            qualitySkips: olderRuns.length > 0
                ? getTrendDirection(averageMetric(newestRuns, 'qualitySkips'), averageMetric(olderRuns, 'qualitySkips'), 'down')
                : 'flat',
            duplicateSkips: olderRuns.length > 0
                ? getTrendDirection(averageMetric(newestRuns, 'duplicateSkips'), averageMetric(olderRuns, 'duplicateSkips'), 'down')
                : 'flat'
        },
        maxSavedAlerts: Math.max(1, ...runs.map((run: any) => run.savedAlerts || 0)),
        maxQualitySkips: Math.max(1, ...runs.map((run: any) => run.qualitySkips || 0))
    };
}

const AlertsPage = () => {
    const router = useRouter();
    const { popupPreferences, updatePopupPreferences } = useNotifications();
    const [alerts, setAlerts] = useState<any[]>([]);
    const [stockFeed, setStockFeed] = useState<any[]>([]);
    const [newAlert, setNewAlert] = useState({ symbol: '', targetPrice: '' });
    const [token, setToken] = useState<string | null>(null);
    const [popupMode, setPopupMode] = useState<PopupMode>('both');
    const [popupMinPriority, setPopupMinPriority] = useState(72);
    const [savingPopupPreferences, setSavingPopupPreferences] = useState(false);
    const [runningNewsMonitor, setRunningNewsMonitor] = useState(false);
    const [includeStaleNews, setIncludeStaleNews] = useState(false);
    const [newsMonitorStatus, setNewsMonitorStatus] = useState<any>(null);
    const [feedSummary, setFeedSummary] = useState<any>({
        total: 0,
        unread: 0,
        popupEligible: 0,
        actionableBuys: 0,
        fresh: 0,
        aging: 0,
        stale: 0,
        unknown: 0,
        hiddenStaleNewsCount: 0,
        includeStaleNews: false
    });
    const recentRunTrend = getRecentRunTrend(newsMonitorStatus);

    // State for stock search
    const [searchTerm, setSearchTerm] = useState('');
    const [searchResults, setSearchResults] = useState<string[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        if (!storedToken) {
            router.push('/login');
        } else {
            setToken(storedToken);
        }
    }, [router]);

    useEffect(() => {
        setPopupMode(popupPreferences.popupMode);
        setPopupMinPriority(popupPreferences.popupMinPriority);
    }, [popupPreferences]);

    useEffect(() => {
        if (!token) return;
        const fetchAlerts = async () => {
            try {
                const response = await fetch(`${getApiBaseUrl()}/api/alerts`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (response.ok) {
                    const data = await response.json();
                    setAlerts(data);
                }
            } catch (error) {
                console.error('Failed to fetch alerts:', error);
            }
        };
        const fetchNewsAlerts = async () => {
            try {
                const [feedResponse, statusResponse] = await Promise.all([
                    fetch(`${getApiBaseUrl()}/api/stock-feed?limit=30&includeStaleNews=${includeStaleNews ? 'true' : 'false'}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    }),
                    fetch(`${getApiBaseUrl()}/api/stock-feed/news-monitor/status`, {
                        headers: { Authorization: `Bearer ${token}` },
                    })
                ]);

                if (feedResponse.ok) {
                    const data = await feedResponse.json();
                    setStockFeed(data.items || []);
                    setFeedSummary(data.summary || {
                        total: 0,
                        unread: 0,
                        popupEligible: 0,
                        actionableBuys: 0,
                        fresh: 0,
                        aging: 0,
                        stale: 0,
                        unknown: 0,
                        hiddenStaleNewsCount: 0,
                        includeStaleNews: false
                    });
                    if (data.preferences) {
                        setPopupMode(data.preferences.popupMode);
                        setPopupMinPriority(data.preferences.popupMinPriority);
                    }
                }

                if (statusResponse.ok) {
                    const statusData = await statusResponse.json();
                    setNewsMonitorStatus(statusData.status || null);
                }
            } catch (error) {
                console.error('Failed to fetch stock feed:', error);
            }
        };
        fetchAlerts();
        fetchNewsAlerts();
        const interval = setInterval(() => {
            fetchAlerts();
            fetchNewsAlerts();
        }, 120000);

        return () => clearInterval(interval);
    }, [token, includeStaleNews]);

    // --- Stock Search and Price Fetching Logic ---

    const fetchSearchResults = async (query: string) => {
        if (query.length < 1) {
            setSearchResults([]);
            return;
        }
        setIsSearching(true);
            try {
                const response = await fetch(`${getApiBaseUrl()}/api/stocks/search?query=${query}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (response.ok) {
                const data = await response.json();
                setSearchResults(data);
            } else {
                setSearchResults([]);
            }
        } catch (error) {
            console.error('Failed to search stocks:', error);
            setSearchResults([]);
        } finally {
            setIsSearching(false);
        }
    };

    const savePopupPreferences = async () => {
        setSavingPopupPreferences(true);
        try {
            await updatePopupPreferences({ popupMode, popupMinPriority });
        } finally {
            setSavingPopupPreferences(false);
        }
    };

    const debouncedFetch = useCallback(debounce(fetchSearchResults, 300), [token]);

    useEffect(() => {
        if (token) {
            debouncedFetch(searchTerm);
        }
    }, [searchTerm, debouncedFetch, token]);

    const handleSymbolSelect = async (symbol: string) => {
        console.log(`[DIAGNOSTIC] handleSymbolSelect triggered for symbol: ${symbol}`);
        setSearchTerm(symbol);
        setSearchResults([]);

        if (!token) {
            console.error("[DIAGNOSTIC] No token available. Aborting price fetch.");
            return;
        }
            try {
                console.log(`[DIAGNOSTIC] Fetching price for ${symbol}...`);
                const response = await fetch(`${getApiBaseUrl()}/api/stocks/price/${symbol}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });

                console.log('[DIAGNOSTIC] Raw API response:', response);

                if (response.ok) {
                    const data = await response.json();
                console.log('[DIAGNOSTIC] Parsed JSON data:', data);

                if (data.price) {
                    console.log(`[DIAGNOSTIC] Price found: ${data.price}. Attempting to set state.`);
                    setNewAlert({ symbol: symbol.toUpperCase(), targetPrice: data.price.toString() });
                    console.log('[DIAGNOSTIC] setNewAlert has been called. The component should re-render.');
                } else {
                    console.log('[DIAGNOSTIC] API response OK, but no price in data. Clearing target price.');
                    setNewAlert({ symbol: symbol.toUpperCase(), targetPrice: '' });
                }
            } else {
                console.error(`[DIAGNOSTIC] API call failed with status: ${response.status}`);
            }
        } catch (error) {
            console.error('[DIAGNOSTIC] An error occurred during the fetch operation:', error);
            setNewAlert({ symbol: symbol.toUpperCase(), targetPrice: '' });
        }
    };

    // --- End of Search Logic ---

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const { name, value } = e.target;
        if (name === 'symbol') {
            setSearchTerm(value);
        }
        setNewAlert(prev => ({ ...prev, [name]: value }));
    };

    const handleAddAlert = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!token || !newAlert.symbol || !newAlert.targetPrice) return;
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/alerts`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    symbol: newAlert.symbol.toUpperCase(),
                    targetPrice: parseFloat(newAlert.targetPrice),
                }),
            });
            if (response.ok) {
                const addedAlert = await response.json();
                setAlerts(prev => [...prev, addedAlert]);
                setNewAlert({ symbol: '', targetPrice: '' });
                setSearchTerm('');
            }
        } catch (error) {
            console.error('Failed to add alert:', error);
        }
    };

    const handleDeleteAlert = async (id: string) => {
        if (!token) return;
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/alerts/${id}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
            });
            if (response.ok) {
                setAlerts(prev => prev.filter(alert => alert.id !== id));
            }
        } catch (error) {
            console.error('Failed to delete alert:', error);
        }
    };

    const handleMarkFeedRead = async (item: any) => {
        if (!token) return;
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/stock-feed/${encodeURIComponent(item.id)}/read`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({ type: item.type }),
            });

            if (response.ok) {
                setStockFeed(prev => prev.map((entry) => entry.id === item.id ? { ...entry, read: true } : entry));
            }
        } catch (error) {
            console.error('Failed to mark feed item as read:', error);
        }
    };

    const handleRunNewsMonitor = async () => {
        if (!token) return;

        setRunningNewsMonitor(true);
        try {
            const response = await fetch(`${getApiBaseUrl()}/api/stock-feed/news-monitor/run`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                }
            });

            if (response.ok) {
                const data = await response.json();
                if (data.status) {
                    setNewsMonitorStatus(data.status);
                }

                const feedResponse = await fetch(`${getApiBaseUrl()}/api/stock-feed?limit=30&includeStaleNews=${includeStaleNews ? 'true' : 'false'}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });

                if (feedResponse.ok) {
                    const feedData = await feedResponse.json();
                    setStockFeed(feedData.items || []);
                    setFeedSummary(feedData.summary || feedSummary);
                }
            }
        } catch (error) {
            console.error('Failed to run news monitor:', error);
        } finally {
            setRunningNewsMonitor(false);
        }
    };
    
    const handleLogout = () => {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        localStorage.removeItem('lastActivity');
        document.cookie = 'token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
        sessionStorage.setItem('justLoggedOut', 'true');
        setToken(null);
        window.location.replace('/login');
    };

    if (!token) {
        return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900">

            <main className="p-4 md:p-8">
                <div className="max-w-5xl mx-auto space-y-6">
                    <section className="bg-white p-6 rounded-2xl shadow">
                        <div className="flex items-start justify-between gap-4 mb-5">
                            <div>
                                <h2 className="text-2xl font-semibold text-gray-900">Stock Swing & News Feed</h2>
                                <p className="text-sm text-gray-500 mt-1">Live watchlist catalysts, swing setups, and popup-eligible alerts in one place.</p>
                            </div>
                            <div className="px-3 py-1 rounded-full bg-slate-100 text-slate-700 text-sm font-medium">
                                {stockFeed.length} items
                            </div>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5 mb-6">
                            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                                <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Fresh</div>
                                <div className="mt-1 text-2xl font-bold text-emerald-900">{feedSummary.fresh}</div>
                            </div>
                            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
                                <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">Aging</div>
                                <div className="mt-1 text-2xl font-bold text-amber-900">{feedSummary.aging}</div>
                            </div>
                            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
                                <div className="text-xs font-semibold uppercase tracking-wide text-rose-700">Stale</div>
                                <div className="mt-1 text-2xl font-bold text-rose-900">{feedSummary.stale}</div>
                            </div>
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                                <div className="text-xs font-semibold uppercase tracking-wide text-slate-700">Popup Ready</div>
                                <div className="mt-1 text-2xl font-bold text-slate-900">{feedSummary.popupEligible}</div>
                            </div>
                            <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3">
                                <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">Actionable Buys</div>
                                <div className="mt-1 text-2xl font-bold text-blue-900">{feedSummary.actionableBuys}</div>
                            </div>
                        </div>

                        <div className="mb-6 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/80 px-4 py-3 text-sm text-slate-700 md:flex-row md:items-center md:justify-between">
                            <div>
                                {includeStaleNews
                                    ? 'Archived stale news is visible in this view.'
                                    : `${feedSummary.hiddenStaleNewsCount || 0} stale news item(s) are hidden from the default feed.`}
                            </div>
                            <label className="inline-flex items-center gap-3 font-medium text-slate-800">
                                <input
                                    type="checkbox"
                                    checked={includeStaleNews}
                                    onChange={(e) => setIncludeStaleNews(e.target.checked)}
                                    className="h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-500"
                                />
                                Show archived stale news
                            </label>
                        </div>

                        <div className="mb-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                <div>
                                    <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">News Monitor Health</h3>
                                    <p className="mt-1 text-sm text-slate-600">Backend ingestion status for fresh catalyst alerts.</p>
                                </div>
                                <button
                                    onClick={handleRunNewsMonitor}
                                    disabled={runningNewsMonitor}
                                    className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                                >
                                    {runningNewsMonitor ? 'Running...' : 'Run monitor now'}
                                </button>
                            </div>

                            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4 text-sm">
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last Run</div>
                                    <div className="mt-1 font-semibold text-slate-900">{formatMonitorTimestamp(newsMonitorStatus?.lastRunFinishedAt)}</div>
                                </div>
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Fresh Alerts 24h</div>
                                    <div className="mt-1 font-semibold text-slate-900">{newsMonitorStatus?.recentAlerts24h ?? 0}</div>
                                </div>
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Unread 24h</div>
                                    <div className="mt-1 font-semibold text-slate-900">{newsMonitorStatus?.unreadAlerts24h ?? 0}</div>
                                </div>
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Monitored Symbols</div>
                                    <div className="mt-1 font-semibold text-slate-900">{newsMonitorStatus?.lastRunSummary?.monitoredSymbols ?? newsMonitorStatus?.watchedSymbolCount ?? 0}</div>
                                </div>
                            </div>

                            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4 text-sm">
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Saved Last Run</div>
                                    <div className="mt-1 font-semibold text-slate-900">{newsMonitorStatus?.lastRunSummary?.savedAlerts ?? 0}</div>
                                </div>
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Duplicates Skipped</div>
                                    <div className="mt-1 font-semibold text-slate-900">{newsMonitorStatus?.lastRunSummary?.duplicateSkips ?? 0}</div>
                                </div>
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Quality Skips</div>
                                    <div className="mt-1 font-semibold text-slate-900">{newsMonitorStatus?.lastRunSummary?.qualitySkips ?? 0}</div>
                                </div>
                                <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Raw Articles</div>
                                    <div className="mt-1 font-semibold text-slate-900">{newsMonitorStatus?.lastRunSummary?.rawArticles ?? 0}</div>
                                </div>
                            </div>

                            <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                                <span className={`rounded-full px-2.5 py-1 font-semibold ${newsMonitorStatus?.sources?.yahoo ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>Yahoo</span>
                                <span className={`rounded-full px-2.5 py-1 font-semibold ${newsMonitorStatus?.sources?.alphaVantage ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>Alpha Vantage</span>
                                <span className={`rounded-full px-2.5 py-1 font-semibold ${newsMonitorStatus?.sources?.finnhub ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>Finnhub</span>
                                <span className={`rounded-full px-2.5 py-1 font-semibold ${newsMonitorStatus?.sources?.newsApi ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>NewsAPI</span>
                                <span className={`rounded-full px-2.5 py-1 font-semibold ${newsMonitorStatus?.sources?.x ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>X</span>
                                <span className="ml-1">Cycle every {newsMonitorStatus?.checkIntervalMinutes ?? 5} min</span>
                            </div>

                            {newsMonitorStatus?.lastRunError && (
                                <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                    Last error: {newsMonitorStatus.lastRunError}
                                </div>
                            )}

                            <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4">
                                <div className="flex items-center justify-between gap-3">
                                    <h4 className="text-sm font-semibold text-slate-900">Recent Runs</h4>
                                    <span className="text-xs text-slate-500">{newsMonitorStatus?.totalRuns ?? 0} total</span>
                                </div>

                                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
                                    <span className={`rounded-full px-2.5 py-1 font-semibold ${getTrendClasses(recentRunTrend.direction.savedAlerts)}`}>
                                        Saved alerts: {recentRunTrend.direction.savedAlerts}
                                    </span>
                                    <span className={`rounded-full px-2.5 py-1 font-semibold ${getTrendClasses(recentRunTrend.direction.qualitySkips)}`}>
                                        Quality filter: {recentRunTrend.direction.qualitySkips}
                                    </span>
                                    <span className={`rounded-full px-2.5 py-1 font-semibold ${getTrendClasses(recentRunTrend.direction.duplicateSkips)}`}>
                                        Dedupe load: {recentRunTrend.direction.duplicateSkips}
                                    </span>
                                </div>

                                <div className="mt-4 grid gap-3 md:grid-cols-4">
                                    <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
                                        <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Avg Saved</div>
                                        <div className="mt-1 text-xl font-bold text-emerald-900">{recentRunTrend.averages.savedAlerts}</div>
                                    </div>
                                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-700">Avg Raw</div>
                                        <div className="mt-1 text-xl font-bold text-slate-900">{recentRunTrend.averages.rawArticles}</div>
                                    </div>
                                    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                                        <div className="text-xs font-semibold uppercase tracking-wide text-amber-700">Avg Quality Skips</div>
                                        <div className="mt-1 text-xl font-bold text-amber-900">{recentRunTrend.averages.qualitySkips}</div>
                                    </div>
                                    <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3">
                                        <div className="text-xs font-semibold uppercase tracking-wide text-blue-700">Avg Dupes</div>
                                        <div className="mt-1 text-xl font-bold text-blue-900">{recentRunTrend.averages.duplicateSkips}</div>
                                    </div>
                                </div>

                                {recentRunTrend.runs.length > 0 && (
                                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                                            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Saved Alerts Trend</div>
                                            <div className="mt-3 flex items-end gap-2 h-24">
                                                {recentRunTrend.runs.map((run: any) => {
                                                    const height = Math.max(12, Math.round(((run.savedAlerts || 0) / recentRunTrend.maxSavedAlerts) * 100));
                                                    return (
                                                        <div key={`saved-${run.id}`} className="flex-1 flex flex-col items-center justify-end gap-2">
                                                            <div className="text-[11px] font-semibold text-slate-600">{run.savedAlerts || 0}</div>
                                                            <div className="w-full rounded-t-md bg-emerald-400" style={{ height: `${height}%` }} />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>

                                        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                                            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Quality Filter Trend</div>
                                            <div className="mt-3 flex items-end gap-2 h-24">
                                                {recentRunTrend.runs.map((run: any) => {
                                                    const height = Math.max(12, Math.round(((run.qualitySkips || 0) / recentRunTrend.maxQualitySkips) * 100));
                                                    return (
                                                        <div key={`quality-${run.id}`} className="flex-1 flex flex-col items-center justify-end gap-2">
                                                            <div className="text-[11px] font-semibold text-slate-600">{run.qualitySkips || 0}</div>
                                                            <div className="w-full rounded-t-md bg-amber-400" style={{ height: `${height}%` }} />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                <div className="mt-3 space-y-3">
                                    {Array.isArray(newsMonitorStatus?.recentRuns) && newsMonitorStatus.recentRuns.length > 0 ? newsMonitorStatus.recentRuns.map((run: any) => (
                                        <div key={run.id} className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                                            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                                                <div>
                                                    <div className="text-sm font-semibold text-slate-900">{formatRunOutcome(run)}</div>
                                                    <div className="text-xs text-slate-500">{formatMonitorTimestamp(run.finishedAt)}</div>
                                                </div>
                                                <div className="flex flex-wrap items-center gap-2 text-xs">
                                                    <span className="rounded-full bg-emerald-100 px-2.5 py-1 font-semibold text-emerald-800">Saved {run.savedAlerts}</span>
                                                    <span className="rounded-full bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">Dupes {run.duplicateSkips}</span>
                                                    <span className="rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-800">Quality {run.qualitySkips}</span>
                                                    <span className="rounded-full bg-blue-100 px-2.5 py-1 font-semibold text-blue-800">Raw {run.rawArticles}</span>
                                                </div>
                                            </div>
                                            {run.error && (
                                                <div className="mt-2 text-xs text-rose-700">{run.error}</div>
                                            )}
                                        </div>
                                    )) : (
                                        <div className="text-sm text-slate-500">No monitor history recorded yet.</div>
                                    )}
                                </div>
                            </div>
                        </div>

                        <div className="grid gap-4 md:grid-cols-[1.2fr,1fr,auto] mb-6 p-4 rounded-2xl border border-slate-200 bg-slate-50">
                            <label className="block">
                                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Popup mode</span>
                                <select
                                    value={popupMode}
                                    onChange={(e) => setPopupMode(e.target.value as PopupMode)}
                                    className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm text-slate-900"
                                >
                                    {popupModeOptions.map((option) => (
                                        <option key={option.value} value={option.value}>{option.label}</option>
                                    ))}
                                </select>
                            </label>

                            <label className="block">
                                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Minimum popup priority</span>
                                <div className="mt-2 flex items-center gap-3">
                                    <input
                                        type="range"
                                        min="50"
                                        max="95"
                                        step="1"
                                        value={popupMinPriority}
                                        onChange={(e) => setPopupMinPriority(Number(e.target.value))}
                                        className="w-full"
                                    />
                                    <div className="w-14 rounded-lg bg-white border border-slate-300 px-3 py-2 text-center text-sm font-semibold text-slate-900">
                                        {popupMinPriority}
                                    </div>
                                </div>
                            </label>

                            <button
                                onClick={savePopupPreferences}
                                disabled={savingPopupPreferences}
                                className="self-end rounded-xl bg-slate-900 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                            >
                                {savingPopupPreferences ? 'Saving...' : 'Save popup rules'}
                            </button>
                        </div>

                        <div className="space-y-4 mb-2">
                            {stockFeed.length === 0 && <div className="text-gray-500">No stock swing or news alerts found.</div>}
                            {stockFeed.map((item: any) => (
                                <div
                                    key={item.id}
                                    className={`rounded-2xl border p-4 transition ${
                                        item.type === 'swing'
                                            ? 'border-emerald-200 bg-emerald-50/70'
                                            : item.severity === 'High'
                                                ? 'border-red-200 bg-red-50/80'
                                                : 'border-amber-200 bg-amber-50/80'
                                    } ${item.read ? 'opacity-75' : ''}`}
                                >
                                    <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-2 mb-2">
                                                <span className="text-lg font-bold text-gray-900">{item.symbol}</span>
                                                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                                                    item.type === 'swing'
                                                        ? 'bg-emerald-100 text-emerald-800'
                                                        : item.severity === 'High'
                                                            ? 'bg-red-100 text-red-800'
                                                            : 'bg-amber-100 text-amber-800'
                                                }`}>
                                                    {item.type === 'swing' ? (item.signal || 'Swing') : `${item.severity || 'News'} News`}
                                                </span>
                                                {item.popupEligible && (
                                                    <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-slate-900 text-white">Popup</span>
                                                )}
                                                <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${freshnessToneClasses[item.meta?.freshnessState || 'unknown'] || freshnessToneClasses.unknown}`}>
                                                    {formatFreshnessLabel(item.meta?.freshnessState)}
                                                </span>
                                                {item.meta?.qualityTier && (
                                                    <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                                                        item.meta.qualityTier === 'Confirmed' || item.meta.qualityTier === 'High'
                                                            ? 'bg-blue-100 text-blue-800'
                                                            : item.meta.qualityTier === 'Medium'
                                                                ? 'bg-slate-100 text-slate-700'
                                                                : 'bg-gray-100 text-gray-600'
                                                    }`}>
                                                        {item.meta.qualityTier} quality
                                                    </span>
                                                )}
                                                <span className="text-xs text-gray-500">{item.sourceLabel}</span>
                                            </div>
                                            <h3 className="text-base font-semibold text-gray-900">{item.title}</h3>
                                            <p className="text-sm text-gray-600 mt-2">{item.summary}</p>
                                            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-gray-500">
                                                <span>{new Date(item.createdAt).toLocaleString()}</span>
                                                {typeof item.meta?.freshnessMinutes === 'number' && (
                                                    <span>{item.meta.freshnessMinutes}m old</span>
                                                )}
                                                {typeof item.meta?.qualityScore === 'number' && (
                                                    <span>Quality {item.meta.qualityScore}/100</span>
                                                )}
                                                {item.type === 'news' && item.source && (
                                                    <span>Source: {item.source}</span>
                                                )}
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-2 shrink-0">
                                            {item.link && (
                                                <a
                                                    href={item.link}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="px-3 py-2 rounded-lg bg-white border text-sm font-medium text-gray-700 hover:bg-gray-50"
                                                    onClick={() => handleMarkFeedRead(item)}
                                                >
                                                    Open
                                                </a>
                                            )}
                                            {!item.read && (
                                                <button
                                                    onClick={() => handleMarkFeedRead(item)}
                                                    className="px-3 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800"
                                                >
                                                    Mark read
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section className="bg-white p-6 rounded-2xl shadow">
                    <h2 className="text-2xl font-semibold mb-4">Price Alerts</h2>
                    <form onSubmit={handleAddAlert} className="mb-6 flex items-center space-x-4">
                        <div className="relative w-1/3">
                            <input
                                type="text"
                                name="symbol"
                                value={searchTerm}
                                onChange={handleInputChange}
                                placeholder="Stock Symbol (e.g., AAPL)"
                                className="p-2 border rounded w-full"
                                required
                                autoComplete="off"
                            />
                            {isSearching && <div className="absolute z-10 w-full mt-1 text-center">Searching...</div>}
                            {searchResults.length > 0 && (
                                <ul className="absolute z-10 w-full mt-1 bg-white border border-gray-300 rounded-md shadow-lg">
                                    {searchResults.map((symbol) => (
                                        <li
                                            key={symbol}
                                            onClick={() => handleSymbolSelect(symbol)}
                                            className="p-2 cursor-pointer hover:bg-gray-100"
                                        >
                                            {symbol}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <input
                            type="number"
                            name="targetPrice"
                            value={newAlert.targetPrice}
                            onChange={handleInputChange}
                            placeholder="Target Price"
                            className="p-2 border rounded w-1/3"
                            required
                            step="0.01"
                        />
                        <button type="submit" className="bg-blue-500 text-white p-2 rounded hover:bg-blue-600">
                            Add Alert
                        </button>
                    </form>
                    <div className="space-y-4">
                        {alerts.map((alert: any) => (
                            <div key={alert.id} className="flex justify-between items-center p-4 border rounded-lg">
                                <div>
                                    <span className="font-bold text-lg">{alert.symbol}</span>
                                    <span className="ml-4 text-gray-600">Target: ${alert.targetPrice.toFixed(2)}</span>
                                </div>
                                <button
                                    onClick={() => handleDeleteAlert(alert.id)}
                                    className="text-red-500 hover:text-red-700"
                                >
                                    Delete
                                </button>
                            </div>
                        ))}
                    </div>
                    </section>
                </div>
            </main>
        </div>
    );
};

export default AlertsPage;
