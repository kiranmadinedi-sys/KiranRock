'use client';

import React, { useEffect, useState } from 'react';
import { API_BASE_URL } from '../config/apiConfig';

interface QuickStatsProps {
    symbol: string;
}

interface StatsData {
    price: number;
    change: number;
    changePercent: number;
    volume: number;
    avgVolume: number;
    marketCap: string;
    peRatio: number;
    high52Week: number;
    low52Week: number;
    beta: number;
    eps: number;
    dividendYield: number;
}

export default function QuickStats({ symbol }: QuickStatsProps) {
    const [stats, setStats] = useState<StatsData | null>(null);
    const [loading, setLoading] = useState(true);
    const [prevPrice, setPrevPrice] = useState<number | null>(null);
    const [priceAnimation, setPriceAnimation] = useState(false);

    useEffect(() => {
        const fetchStats = async () => {
            try {
                const token = localStorage.getItem('token');
                const response = await fetch(`${API_BASE_URL}/api/stocks/price/${symbol}`, {
                    headers: { Authorization: `Bearer ${token}` },
                });

                if (response.ok) {
                    const data = await response.json();
                    
                    if (prevPrice !== null && data.price !== prevPrice) {
                        setPriceAnimation(true);
                        setTimeout(() => setPriceAnimation(false), 500);
                    }
                    
                    setPrevPrice(data.price);
                    setStats(data);
                }
            } catch (error) {
                console.error('Error fetching stats:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchStats();
        const interval = setInterval(fetchStats, 5000);

        return () => clearInterval(interval);
    }, [symbol, prevPrice]);

    if (loading) {
        return (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {[...Array(8)].map((_, i) => (
                    <div key={i} className="skeleton h-24 rounded-lg"></div>
                ))}
            </div>
        );
    }

    if (!stats) return null;

    const statCards = [
        {
            label: 'Current Price',
            value: `$${stats.price?.toFixed(2) || 'N/A'}`,
            change: stats.changePercent,
            icon: '💵',
            gradient: 'from-blue-500 to-cyan-500',
            animate: priceAnimation,
        },
        {
            label: 'Volume',
            value: stats.volume ? `${(stats.volume / 1000000).toFixed(2)}M` : 'N/A',
            subtitle: `Avg: ${stats.avgVolume ? (stats.avgVolume / 1000000).toFixed(2) + 'M' : 'N/A'}`,
            icon: '📊',
            gradient: 'from-purple-500 to-pink-500',
        },
        {
            label: 'Market Cap',
            value: stats.marketCap || 'N/A',
            icon: '🏢',
            gradient: 'from-green-500 to-emerald-500',
        },
        {
            label: 'P/E Ratio',
            value: stats.peRatio?.toFixed(2) || 'N/A',
            icon: '📈',
            gradient: 'from-orange-500 to-red-500',
        },
        {
            label: '52W High',
            value: `$${stats.high52Week?.toFixed(2) || 'N/A'}`,
            icon: '⬆️',
            gradient: 'from-teal-500 to-cyan-500',
        },
        {
            label: '52W Low',
            value: `$${stats.low52Week?.toFixed(2) || 'N/A'}`,
            icon: '⬇️',
            gradient: 'from-indigo-500 to-purple-500',
        },
        {
            label: 'Beta',
            value: stats.beta?.toFixed(2) || 'N/A',
            icon: '📉',
            gradient: 'from-pink-500 to-rose-500',
        },
        {
            label: 'EPS',
            value: stats.eps?.toFixed(2) || 'N/A',
            icon: '💰',
            gradient: 'from-yellow-500 to-amber-500',
        },
    ];

    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {statCards.map((card, index) => (
                <div
                    key={card.label}
                    className="card-hover bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-lg transition-all duration-300"
                    style={{ animationDelay: `${index * 50}ms` }}
                >
                    <div className="flex items-start justify-between mb-2">
                        <div className={`p-2 rounded-lg bg-gradient-to-br ${card.gradient} shadow-md`}>
                            <span className="text-xl">{card.icon}</span>
                        </div>
                        {card.change !== undefined && (
                            <span
                                className={`text-xs font-semibold px-2 py-1 rounded-full ${
                                    card.change >= 0
                                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                                        : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                                }`}
                            >
                                {card.change >= 0 ? '+' : ''}
                                {card.change.toFixed(2)}%
                            </span>
                        )}
                    </div>
                    <div className="text-xs text-gray-600 dark:text-gray-400 mb-1 font-medium">
                        {card.label}
                    </div>
                    <div
                        className={`text-xl font-bold text-gray-900 dark:text-white ${
                            card.animate ? 'number-change' : ''
                        }`}
                    >
                        {card.value}
                    </div>
                    {card.subtitle && (
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                            {card.subtitle}
                        </div>
                    )}
                </div>
            ))}
        </div>
    );
}
