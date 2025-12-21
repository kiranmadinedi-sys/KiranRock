'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl } from '../config';
import AppHeader from '../components/AppHeader';
import { debounce } from 'lodash';

const AlertsPage = () => {
    const router = useRouter();
    const [alerts, setAlerts] = useState<any[]>([]);
    const [newsAlerts, setNewsAlerts] = useState<any[]>([]);
    const [newAlert, setNewAlert] = useState({ symbol: '', targetPrice: '' });
    const [token, setToken] = useState<string | null>(null);

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
                const response = fetch(`${getApiBaseUrl()}/api/news-alerts?limit=20`, {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (response.ok) {
                    const data = await response.json();
                    setNewsAlerts(data.alerts || []);
                }
            } catch (error) {
                console.error('Failed to fetch news alerts:', error);
            }
        };
        fetchAlerts();
        fetchNewsAlerts();
    }, [token]);

    // --- Stock Search and Price Fetching Logic ---

    const fetchSearchResults = async (query: string) => {
        if (query.length < 1) {
            setSearchResults([]);
            return;
        }
        setIsSearching(true);
        try {
            const response = fetch(`${getApiBaseUrl()}/api/stocks/search?query=${query}`, {
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
            const response = fetch(`${getApiBaseUrl()}/api/stocks/price/${symbol}`, {
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
            const response = fetch(`${getApiBaseUrl()}/api/alerts`, {
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
            const response = fetch(`${getApiBaseUrl()}/api/alerts/${id}`, {
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
    
    const handleLogout = () => {
        localStorage.removeItem('token');
        setToken(null);
        router.push('/login');
    };

    if (!token) {
        return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900">
            <AppHeader showSearch={false} />
            <main className="p-4 md:p-8">
                <div className="max-w-4xl mx-auto bg-white p-6 rounded-lg shadow">
                    <h2 className="text-2xl font-semibold mb-4">News Alerts</h2>
                    <div className="space-y-4 mb-8">
                        {newsAlerts.length === 0 && <div className="text-gray-500">No news alerts found.</div>}
                        {newsAlerts.map((alert: any) => (
                            <div key={alert.id || alert._id} className="flex flex-col p-4 border rounded-lg bg-yellow-50">
                                <div className="font-bold text-lg text-yellow-800">{alert.symbol || alert.ticker}</div>
                                <div className="text-gray-700 mt-1">{alert.headline || alert.title}</div>
                                {alert.severity && (
                                    <div className="text-xs text-red-600 mt-1">Severity: {alert.severity}</div>
                                )}
                                {alert.timestamp && (
                                    <div className="text-xs text-gray-500 mt-1">{new Date(alert.timestamp).toLocaleString()}</div>
                                )}
                            </div>
                        ))}
                    </div>
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
                </div>
            </main>
        </div>
    );
};

export default AlertsPage;
