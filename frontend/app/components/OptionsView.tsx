'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

interface GreeksData {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
    impliedVolatility: number;
}

interface OptionContract {
    strike: number;
    lastPrice: number;
    bid: number;
    ask: number;
    volume: number;
    openInterest: number;
    change: number;
    percentChange: number;
    inTheMoney: boolean;
    greeks?: GreeksData;
    expirationDate: string;
    contractSymbol: string;
}

interface OptionsData {
    symbol: string;
    currentPrice: number;
    expirationDates: string[];
    calls: OptionContract[];
    puts: OptionContract[];
}

interface OptionsViewProps {
    symbol: string;
}

export default function OptionsView({ symbol }: OptionsViewProps) {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [optionsData, setOptionsData] = useState<OptionsData | null>(null);
    const [selectedExpiration, setSelectedExpiration] = useState<string>('');
    const [filterType, setFilterType] = useState<'all' | 'itm' | 'otm'>('all');
    const [sortBy, setSortBy] = useState<'strike' | 'volume' | 'delta'>('strike');

    useEffect(() => {
        const fetchOptionsData = async () => {
            if (!symbol) return;
            
            setLoading(true);
            setError(null);
            
            try {
                const token = localStorage.getItem('token');
                const response = fetch(`${getApiBaseUrl()}/api/options/${symbol}`, {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                });

                if (!response.ok) {
                    throw new Error(`Failed to fetch options data (${response.status})`);
                }

                const data = await response.json();
                
                // Check if the response contains an error field
                if (data.error) {
                    setError(data.error);
                    setOptionsData(null);
                } else {
                    setOptionsData(data);
                    
                    if (data.expirationDates && data.expirationDates.length > 0 && !selectedExpiration) {
                        setSelectedExpiration(data.expirationDates[0]);
                    }
                }
            } catch (err) {
                console.error('[OptionsView] Error:', err);
                setError(err instanceof Error ? err.message : 'Unknown error');
                setOptionsData(null);
            } finally {
                setLoading(false);
            }
        };

        fetchOptionsData();
    }, [symbol, selectedExpiration]);

    const filterOptions = (options: OptionContract[]) => {
        let filtered = options;

        // Filter by ITM/OTM
        if (filterType === 'itm') {
            filtered = filtered.filter(opt => opt.inTheMoney);
        } else if (filterType === 'otm') {
            filtered = filtered.filter(opt => !opt.inTheMoney);
        }

        // Sort
        filtered.sort((a, b) => {
            switch (sortBy) {
                case 'volume':
                    return (b.volume || 0) - (a.volume || 0);
                case 'delta':
                    return Math.abs(b.greeks?.delta || 0) - Math.abs(a.greeks?.delta || 0);
                default:
                    return a.strike - b.strike;
            }
        });

        return filtered;
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-96">
                <div className="text-center">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
                    <p className="text-gray-600 dark:text-gray-400">Loading options data...</p>
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center justify-center h-96">
                <div className="text-center max-w-md mx-auto p-6">
                    <div className="text-yellow-500 text-5xl mb-4">📊</div>
                    <p className="text-gray-900 dark:text-gray-100 font-semibold mb-2">Options Data Unavailable</p>
                    <p className="text-gray-600 dark:text-gray-400 text-sm">{error}</p>
                    <p className="text-gray-500 dark:text-gray-500 text-xs mt-3">
                        Options data may not be available for all symbols or during certain market hours.
                    </p>
                </div>
            </div>
        );
    }

    if (!optionsData) {
        return (
            <div className="flex items-center justify-center h-96">
                <p className="text-gray-600 dark:text-gray-400">No options data available</p>
            </div>
        );
    }

    const filteredCalls = filterOptions(optionsData.calls || []);
    const filteredPuts = filterOptions(optionsData.puts || []);

    return (
        <div className="space-y-6">
            {/* Header with Current Price */}
            <div className="bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 rounded-xl p-6 border border-purple-200 dark:border-purple-800">
                <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                    <div>
                        <h3 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                            {symbol} Options Chain
                        </h3>
                        <div className="flex items-center space-x-4">
                            <div>
                                <span className="text-sm text-gray-600 dark:text-gray-400">Current Price:</span>
                                <span className="ml-2 text-2xl font-bold text-purple-600 dark:text-purple-400">
                                    ${optionsData.currentPrice?.toFixed(2) || 'N/A'}
                                </span>
                            </div>
                        </div>
                    </div>
                    
                    {/* Expiration Selector */}
                    <div className="flex flex-col space-y-2">
                        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                            Expiration Date
                        </label>
                        <select
                            value={selectedExpiration}
                            onChange={(e) => setSelectedExpiration(e.target.value)}
                            className="px-4 py-2 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-gray-900 dark:text-white"
                        >
                            {optionsData.expirationDates?.map((date) => (
                                <option key={date} value={date}>
                                    {new Date(date).toLocaleDateString()}
                                </option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            {/* Filters and Controls */}
            <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
                <div className="flex flex-col md:flex-row md:items-center gap-4">
                    <div className="flex items-center space-x-2">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Filter:</span>
                        <div className="flex space-x-1">
                            {['all', 'itm', 'otm'].map((type) => (
                                <button
                                    key={type}
                                    onClick={() => setFilterType(type as any)}
                                    className={`px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                                        filterType === type
                                            ? 'bg-purple-600 text-white'
                                            : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                                    }`}
                                >
                                    {type.toUpperCase()}
                                </button>
                            ))}
                        </div>
                    </div>
                    
                    <div className="flex items-center space-x-2">
                        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Sort by:</span>
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value as any)}
                            className="px-3 py-1.5 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                        >
                            <option value="strike">Strike</option>
                            <option value="volume">Volume</option>
                            <option value="delta">Delta</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* Options Tables */}
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
                {/* Calls */}
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                    <div className="px-6 py-4 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 border-b border-gray-200 dark:border-gray-700">
                        <h4 className="text-lg font-bold text-green-700 dark:text-green-400 flex items-center">
                            <span className="mr-2">📞</span>
                            Call Options
                        </h4>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-gray-50 dark:bg-gray-700 text-xs font-semibold text-gray-600 dark:text-gray-300">
                                <tr>
                                    <th className="px-4 py-3 text-left">Strike</th>
                                    <th className="px-4 py-3 text-right">Last</th>
                                    <th className="px-4 py-3 text-right">Bid/Ask</th>
                                    <th className="px-4 py-3 text-right">Vol</th>
                                    <th className="px-4 py-3 text-right">OI</th>
                                    <th className="px-4 py-3 text-right">Delta</th>
                                    <th className="px-4 py-3 text-right">IV</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                                {filteredCalls.slice(0, 15).map((call) => (
                                    <tr
                                        key={call.contractSymbol}
                                        className={`hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                                            call.inTheMoney ? 'bg-green-50 dark:bg-green-900/10' : ''
                                        }`}
                                    >
                                        <td className="px-4 py-3 font-bold text-gray-900 dark:text-white">
                                            ${call.strike}
                                        </td>
                                        <td className="px-4 py-3 text-right text-gray-900 dark:text-white">
                                            ${call.lastPrice?.toFixed(2) || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                                            ${call.bid?.toFixed(2) || '-'}/${call.ask?.toFixed(2) || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                                            {call.volume?.toLocaleString() || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                                            {call.openInterest?.toLocaleString() || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right font-medium text-green-600 dark:text-green-400">
                                            {call.greeks?.delta?.toFixed(3) || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                                            {call.greeks?.impliedVolatility ? `${(call.greeks.impliedVolatility * 100).toFixed(1)}%` : '-'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* Puts */}
                <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                    <div className="px-6 py-4 bg-gradient-to-r from-red-50 to-pink-50 dark:from-red-900/20 dark:to-pink-900/20 border-b border-gray-200 dark:border-gray-700">
                        <h4 className="text-lg font-bold text-red-700 dark:text-red-400 flex items-center">
                            <span className="mr-2">📉</span>
                            Put Options
                        </h4>
                    </div>
                    <div className="overflow-x-auto">
                        <table className="w-full">
                            <thead className="bg-gray-50 dark:bg-gray-700 text-xs font-semibold text-gray-600 dark:text-gray-300">
                                <tr>
                                    <th className="px-4 py-3 text-left">Strike</th>
                                    <th className="px-4 py-3 text-right">Last</th>
                                    <th className="px-4 py-3 text-right">Bid/Ask</th>
                                    <th className="px-4 py-3 text-right">Vol</th>
                                    <th className="px-4 py-3 text-right">OI</th>
                                    <th className="px-4 py-3 text-right">Delta</th>
                                    <th className="px-4 py-3 text-right">IV</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                                {filteredPuts.slice(0, 15).map((put) => (
                                    <tr
                                        key={put.contractSymbol}
                                        className={`hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors ${
                                            put.inTheMoney ? 'bg-red-50 dark:bg-red-900/10' : ''
                                        }`}
                                    >
                                        <td className="px-4 py-3 font-bold text-gray-900 dark:text-white">
                                            ${put.strike}
                                        </td>
                                        <td className="px-4 py-3 text-right text-gray-900 dark:text-white">
                                            ${put.lastPrice?.toFixed(2) || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                                            ${put.bid?.toFixed(2) || '-'}/${put.ask?.toFixed(2) || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                                            {put.volume?.toLocaleString() || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                                            {put.openInterest?.toLocaleString() || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right font-medium text-red-600 dark:text-red-400">
                                            {put.greeks?.delta?.toFixed(3) || '-'}
                                        </td>
                                        <td className="px-4 py-3 text-right text-sm text-gray-600 dark:text-gray-400">
                                            {put.greeks?.impliedVolatility ? `${(put.greeks.impliedVolatility * 100).toFixed(1)}%` : '-'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {/* Greeks Explanation */}
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 rounded-xl p-6 border border-blue-200 dark:border-blue-800">
                <h4 className="text-lg font-bold text-gray-900 dark:text-white mb-4">📚 Understanding Greeks</h4>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div>
                        <h5 className="font-semibold text-blue-700 dark:text-blue-400 mb-1">Delta (Δ)</h5>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            Rate of change in option price per $1 change in stock price
                        </p>
                    </div>
                    <div>
                        <h5 className="font-semibold text-blue-700 dark:text-blue-400 mb-1">Gamma (Γ)</h5>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            Rate of change in delta per $1 change in stock price
                        </p>
                    </div>
                    <div>
                        <h5 className="font-semibold text-blue-700 dark:text-blue-400 mb-1">Theta (Θ)</h5>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            Time decay - option value loss per day
                        </p>
                    </div>
                    <div>
                        <h5 className="font-semibold text-blue-700 dark:text-blue-400 mb-1">Vega (ν)</h5>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            Sensitivity to implied volatility changes
                        </p>
                    </div>
                    <div>
                        <h5 className="font-semibold text-blue-700 dark:text-blue-400 mb-1">Implied Volatility (IV)</h5>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            Expected price movement percentage
                        </p>
                    </div>
                    <div>
                        <h5 className="font-semibold text-blue-700 dark:text-blue-400 mb-1">Open Interest (OI)</h5>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                            Total number of outstanding contracts
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
