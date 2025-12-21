'use client';

import React, { useEffect, useState } from 'react';
// ...existing code...
import { getApiBaseUrl } from '../config';

const StockTicker = ({ symbol, onSelect, isSelected, onRemove }: { symbol: string, onSelect: (symbol: string) => void, isSelected: boolean, onRemove?: () => void }) => {
    const [price, setPrice] = useState<number | null>(null);
    const [signal, setSignal] = useState<string>('Hold');
    const [debugInfo, setDebugInfo] = useState('');

    useEffect(() => {
        const fetchData = async () => {
            const token = localStorage.getItem('token');
            try {
                // Fetch true live price (tick)
                const [priceResponse, signalResponse] = await Promise.all([
                    fetch(`${getApiBaseUrl()}/api/stocks/price/${symbol}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    }),
                    fetch(`${getApiBaseUrl()}/api/signals/${symbol}`, {
                        headers: { Authorization: `Bearer ${token}` },
                    }),
                ]);
                if (priceResponse.ok) {
                    const priceData = await priceResponse.json();
                    if (typeof priceData.price === 'number') {
                        setPrice(priceData.price);
                    }
                }
                if (signalResponse.ok) {
                    const signalData = await signalResponse.json();
                    setSignal(signalData.signal);
                }
            } catch (error) {
                // Optionally handle error
            }
        };

        fetchData();
        const interval = setInterval(fetchData, 2000); // Fetch every 2 seconds

        return () => clearInterval(interval);
    }, [symbol]);

    const getSignalClasses = () => {
        switch (signal) {
            case 'Buy':
                return 'bg-green-50 dark:bg-green-900/20 text-[var(--color-success)] border-green-200 dark:border-green-800';
            case 'Sell':
                return 'bg-red-50 dark:bg-red-900/20 text-[var(--color-danger)] border-red-200 dark:border-red-800';
            default:
                return 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-400 border-yellow-200 dark:border-yellow-800';
        }
    };

    const selectedClasses = isSelected 
        ? 'bg-[var(--color-bg-tertiary)] border-[var(--color-accent)] shadow-md scale-[1.02]' 
        : 'bg-[var(--color-card)] border-[var(--color-border)] hover:shadow-sm hover:border-[var(--color-accent)]';

    return (
        <div 
            className={`flex flex-col items-center justify-between p-1 sm:p-2 rounded-md border shadow-sm cursor-pointer transition-all duration-200 w-full min-w-[90px] ${selectedClasses}`}
            onClick={() => onSelect(symbol)}
        >
            <div className="flex flex-row w-full items-center justify-between">
                <div className="flex flex-col items-start gap-0.5" style={{width: '48px'}}>
                    <h3 className="text-[11px] sm:text-xs font-bold text-[var(--color-text-primary)] leading-tight w-full truncate">{symbol}</h3>
                    <span className={`px-1 py-0.5 text-[8px] sm:text-[10px] font-semibold rounded border ${getSignalClasses()} leading-tight w-full truncate`}>{signal}</span>
                </div>
                {onRemove && (
                  <button
                    className="ml-1 text-red-500 hover:text-red-700 text-xs px-1 py-0.5 rounded focus:outline-none"
                    title="Remove from watchlist"
                    onClick={e => { e.stopPropagation(); onRemove(); }}
                  >
                    ✕
                  </button>
                )}
            </div>
            <div className="flex items-center justify-center w-full mt-1">
                <span className="bg-gray-900 text-green-300 text-xs px-2 py-1 rounded font-mono w-full text-center" style={{minHeight: '22px'}}>
                    {price !== null ? `$${price.toFixed(2)}` : <span className="text-gray-400">...</span>}
                </span>
            </div>
        </div>
    );
};

export default StockTicker;
