'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

interface QuickStat {
    label: string;
    value: string | number;
    change?: number;
    icon: string;
    trend?: 'up' | 'down' | 'neutral';
}

interface QuickStatsProps {
    symbol: string;
}

export default function QuickStatsWidget({ symbol }: QuickStatsProps) {
    const [stats, setStats] = useState<QuickStat[]>([]);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const fetchQuickStats = async () => {
            if (!symbol) return;
            
            try {
                const token = localStorage.getItem('token');
                
                // Fetch multiple data sources in parallel
                const [priceRes, volumeRes, fundamentalsRes] = await Promise.all([
                    fetch(`${getApiBaseUrl()}/api/stocks/${symbol}?interval=1d`, {
                        headers: { Authorization: `Bearer ${token}` }
                    }),
                    fetch(`${getApiBaseUrl()}/api/volume/${symbol}`, {
                        headers: { Authorization: `Bearer ${token}` }
                    }),
                    fetch(`${getApiBaseUrl()}/api/fundamentals/${symbol}`, {
                        headers: { Authorization: `Bearer ${token}` }
                    })
                ]);

                const priceData = priceRes.ok ? await priceRes.json() : null;
                const volumeData = volumeRes.ok ? await volumeRes.json() : null;
                const fundamentalsData = fundamentalsRes.ok ? await fundamentalsRes.json() : null;

                // Calculate stats
                const currentPrice = priceData && priceData.length > 0 
                    ? priceData[priceData.length - 1].close 
                    : 0;
                
                const prevPrice = priceData && priceData.length > 1
                    ? priceData[priceData.length - 2].close
                    : currentPrice;
                
                const priceChange = ((currentPrice - prevPrice) / prevPrice) * 100;

                const quickStats: QuickStat[] = [
                    {
                        label: 'Current Price',
                        value: `$${currentPrice.toFixed(2)}`,
                        change: priceChange,
                        icon: '💵',
                        trend: priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : 'neutral'
                    },
                    {
                        label: 'Volume',
                        value: volumeData?.todayVolume 
                            ? `${(volumeData.todayVolume / 1000000).toFixed(1)}M`
                            : 'N/A',
                        change: volumeData?.volumeRatio,
                        icon: '📊',
                        trend: volumeData?.volumeRatio > 1 ? 'up' : 'down'
                    },
                    {
                        label: 'Market Cap',
                        value: fundamentalsData?.marketCap
                            ? `$${(fundamentalsData.marketCap / 1000000000).toFixed(1)}B`
                            : 'N/A',
                        icon: '🏢',
                        trend: 'neutral'
                    },
                    {
                        label: 'P/E Ratio',
                        value: fundamentalsData?.peRatio?.toFixed(2) || 'N/A',
                        icon: '📈',
                        trend: 'neutral'
                    },
                    {
                        label: '52W High',
                        value: fundamentalsData?.['52WeekHigh']
                            ? `$${fundamentalsData['52WeekHigh'].toFixed(2)}`
                            : 'N/A',
                        icon: '🔼',
                        trend: 'up'
                    },
                    {
                        label: '52W Low',
                        value: fundamentalsData?.['52WeekLow']
                            ? `$${fundamentalsData['52WeekLow'].toFixed(2)}`
                            : 'N/A',
                        icon: '🔽',
                        trend: 'down'
                    },
                    {
                        label: 'Avg Volume',
                        value: volumeData?.averageVolume
                            ? `${(volumeData.averageVolume / 1000000).toFixed(1)}M`
                            : 'N/A',
                        icon: '📉',
                        trend: 'neutral'
                    },
                    {
                        label: 'Beta',
                        value: fundamentalsData?.beta?.toFixed(2) || 'N/A',
                        icon: '⚡',
                        trend: 'neutral'
                    }
                ];

                setStats(quickStats);
            } catch (error) {
                console.error('Error fetching quick stats:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchQuickStats();
    }, [symbol]);

    if (loading) {
        return (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {[...Array(8)].map((_, i) => (
                    <div key={i} className="bg-gray-100 dark:bg-gray-700 rounded-lg p-4 animate-pulse">
                        <div className="h-4 bg-gray-200 dark:bg-gray-600 rounded w-3/4 mb-2"></div>
                        <div className="h-6 bg-gray-200 dark:bg-gray-600 rounded"></div>
                    </div>
                ))}
            </div>
        );
    }

    return (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {stats.map((stat, index) => (
                <div
                    key={index}
                    className="bg-gradient-to-br from-white to-gray-50 dark:from-gray-800 dark:to-gray-700 rounded-lg p-4 border border-gray-200 dark:border-gray-600 hover:shadow-lg transition-all duration-300 hover:scale-105 cursor-pointer"
                >
                    <div className="flex items-center justify-between mb-2">
                        <span className="text-2xl">{stat.icon}</span>
                        {stat.change !== undefined && (
                            <span className={`text-xs font-semibold px-2 py-1 rounded-full ${
                                stat.trend === 'up' 
                                    ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                    : stat.trend === 'down'
                                    ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                    : 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-400'
                            }`}>
                                {stat.change > 0 ? '+' : ''}{stat.change.toFixed(2)}%
                            </span>
                        )}
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-400 font-medium mb-1">
                        {stat.label}
                    </div>
                    <div className="text-lg font-bold text-gray-900 dark:text-white truncate">
                        {stat.value}
                    </div>
                </div>
            ))}
        </div>
    );
}
