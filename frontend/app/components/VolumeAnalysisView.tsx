
'use client';
import { API_BASE_URL } from '../config/apiConfig';
import React, { useState, useEffect } from 'react';

interface VolumeAnalysisProps {
    symbol: string;
    interval?: string;
}

const VolumeAnalysisView: React.FC<VolumeAnalysisProps> = ({ symbol, interval = '1d' }) => {
    const [volumeData, setVolumeData] = useState<any>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const fetchVolumeAnalysis = async () => {
            setLoading(true);
            const token = localStorage.getItem('token');
            try {
                const response = await fetch(
                    `${API_BASE_URL}/api/volume/${symbol}?interval=${interval}`,
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                if (response.ok) {
                    const data = await response.json();
                    setVolumeData(data);
                }
            } catch (error) {
                console.error('Error fetching volume analysis:', error);
            } finally {
                setLoading(false);
            }
        };

        if (symbol) {
            fetchVolumeAnalysis();
        }
    }, [symbol, interval]);

    if (loading || !volumeData) {
        return (
            <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-sm text-[var(--color-text-secondary)]">Loading volume data...</div>
            </div>
        );
    }

    const getTrendColor = (trend: string) => {
        if (trend === 'Increasing') return 'text-[var(--color-success)]';
        if (trend === 'Decreasing') return 'text-[var(--color-danger)]';
        return 'text-yellow-600 dark:text-yellow-400';
    };

    const getStatusBg = (status: string) => {
        if (status === 'High') return 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-800';
        if (status === 'Low') return 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800';
        return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-300 dark:border-yellow-800';
    };

    return (
        <div className="space-y-3">
            {/* Volume Status */}
            <div className={`p-3 rounded-lg border ${getStatusBg(volumeData.volumeStatus)}`}>
                <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-semibold text-[var(--color-text-primary)]">Volume Status</span>
                    <span className="font-bold text-[var(--color-text-primary)]">{volumeData.volumeStatus}</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                        <div className="text-[var(--color-text-secondary)]">Current</div>
                        <div className="font-semibold text-[var(--color-text-primary)]">
                            {(volumeData.currentVolume / 1000000).toFixed(2)}M
                        </div>
                    </div>
                    <div>
                        <div className="text-[var(--color-text-secondary)]">Avg</div>
                        <div className="font-semibold text-[var(--color-text-primary)]">
                            {(volumeData.averageVolume / 1000000).toFixed(2)}M
                        </div>
                    </div>
                </div>
            </div>

            {/* Volume Trend */}
            <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                <div className="flex items-center justify-between">
                    <span className="text-sm text-[var(--color-text-secondary)]">Trend</span>
                    <span className={`font-bold ${getTrendColor(volumeData.volumeTrend)}`}>
                        {volumeData.volumeTrend} ({volumeData.volumeChange}%)
                    </span>
                </div>
            </div>

            {/* Interpretation */}
            {volumeData.interpretation && (
                <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                    <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-semibold text-[var(--color-text-primary)]">Signal</span>
                        <span className={`text-sm font-bold ${
                            volumeData.interpretation.sentiment === 'Bullish' 
                                ? 'text-[var(--color-success)]' 
                                : volumeData.interpretation.sentiment === 'Bearish'
                                ? 'text-[var(--color-danger)]'
                                : 'text-yellow-600 dark:text-yellow-400'
                        }`}>
                            {volumeData.interpretation.sentiment}
                        </span>
                    </div>
                    <p className="text-xs text-[var(--color-text-secondary)]">
                        {volumeData.interpretation.description}
                    </p>
                </div>
            )}
        </div>
    );
};

export default VolumeAnalysisView;
