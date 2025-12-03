
'use client';
import { API_BASE_URL } from '../config/apiConfig';
import React, { useState, useEffect } from 'react';

interface PatternDetectionProps {
    symbol: string;
    interval?: string;
}

const PatternDetectionView: React.FC<PatternDetectionProps> = ({ symbol, interval = '1d' }) => {
    const [patternData, setPatternData] = useState<any>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const fetchPatterns = async () => {
            setLoading(true);
            const token = localStorage.getItem('token');
            try {
                const response = await fetch(
                    `${API_BASE_URL}/api/patterns/${symbol}?interval=${interval}`,
                    { headers: { Authorization: `Bearer ${token}` } }
                );
                if (response.ok) {
                    const data = await response.json();
                    setPatternData(data);
                }
            } catch (error) {
                console.error('Error fetching patterns:', error);
            } finally {
                setLoading(false);
            }
        };

        if (symbol) {
            fetchPatterns();
        }
    }, [symbol, interval]);

    if (loading || !patternData) {
        return (
            <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-sm text-[var(--color-text-secondary)]">Detecting patterns...</div>
            </div>
        );
    }

    const getSignalColor = (signal: string) => {
        if (signal === 'Bullish') return 'text-[var(--color-success)]';
        if (signal === 'Bearish') return 'text-[var(--color-danger)]';
        return 'text-yellow-600 dark:text-yellow-400';
    };

    const getSignalBg = (signal: string) => {
        if (signal === 'Bullish') return 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-800';
        if (signal === 'Bearish') return 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800';
        return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-300 dark:border-yellow-800';
    };

    return (
        <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] shadow-sm">
            <div className="px-4 py-3 border-b border-[var(--color-border)]">
                <h3 className="text-lg font-bold text-[var(--color-text-primary)] flex items-center">
                    <span className="mr-2">📉</span>
                    Pattern Detection
                </h3>
            </div>

            <div className="p-4 space-y-4">
                {/* Summary */}
                {patternData.summary && (
                    <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                        <div className="grid grid-cols-3 gap-2 text-center mb-2">
                            <div>
                                <div className="text-xs text-[var(--color-text-secondary)]">Total</div>
                                <div className="text-lg font-bold text-[var(--color-text-primary)]">{patternData.summary.total}</div>
                            </div>
                            <div>
                                <div className="text-xs text-[var(--color-text-secondary)]">Bullish</div>
                                <div className="text-lg font-bold text-[var(--color-success)]">{patternData.summary.bullish}</div>
                            </div>
                            <div>
                                <div className="text-xs text-[var(--color-text-secondary)]">Bearish</div>
                                <div className="text-lg font-bold text-[var(--color-danger)]">{patternData.summary.bearish}</div>
                            </div>
                        </div>
                        <div className="text-center pt-2 border-t border-[var(--color-border)]">
                            <span className="text-sm text-[var(--color-text-secondary)]">Overall: </span>
                            <span className={`font-bold ${getSignalColor(patternData.summary.overall)}`}>
                                {patternData.summary.overall}
                            </span>
                        </div>
                    </div>
                )}

                {/* Alerts */}
                {patternData.alerts && patternData.alerts.length > 0 && (
                    <div>
                        <h4 className="font-semibold text-[var(--color-text-primary)] mb-2 text-sm">🚨 Active Alerts</h4>
                        <div className="space-y-2">
                            {patternData.alerts.map((alert: any, index: number) => (
                                <div
                                    key={index}
                                    className={`p-3 rounded-lg border ${getSignalBg(alert.signal)}`}
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="flex-1">
                                            <div className="font-semibold text-sm text-[var(--color-text-primary)] mb-1">
                                                {alert.type}
                                            </div>
                                            <div className="text-xs text-[var(--color-text-secondary)]">
                                                {alert.message}
                                            </div>
                                        </div>
                                        <div className={`px-2 py-1 rounded text-xs font-semibold ${
                                            alert.urgency === 'High' 
                                                ? 'bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400' 
                                                : 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-600 dark:text-yellow-400'
                                        }`}>
                                            {alert.urgency}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Recent Patterns */}
                {patternData.patterns && patternData.patterns.length > 0 && (
                    <div>
                        <h4 className="font-semibold text-[var(--color-text-primary)] mb-2 text-sm">Recent Patterns</h4>
                        <div className="space-y-2 max-h-48 overflow-y-auto">
                            {patternData.patterns.map((pattern: any, index: number) => (
                                <div
                                    key={index}
                                    className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]"
                                >
                                    <div className="flex items-start justify-between gap-2 mb-1">
                                        <span className="font-semibold text-sm text-[var(--color-text-primary)]">
                                            {pattern.type}
                                        </span>
                                        <span className={`text-xs font-bold ${getSignalColor(pattern.signal)}`}>
                                            {pattern.signal}
                                        </span>
                                    </div>
                                    <div className="text-xs text-[var(--color-text-secondary)] mb-1">
                                        {pattern.description}
                                    </div>
                                    <div className="flex items-center justify-between text-xs">
                                        <span className="text-[var(--color-text-secondary)]">
                                            {new Date(pattern.time * 1000).toLocaleDateString()}
                                        </span>
                                        <span className="text-[var(--color-text-secondary)]">
                                            Confidence: {pattern.confidence}%
                                        </span>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {patternData.patterns && patternData.patterns.length === 0 && (
                    <div className="text-center text-sm text-[var(--color-text-secondary)] py-4">
                        No patterns detected in current timeframe
                    </div>
                )}
            </div>
        </div>
    );
};

export default PatternDetectionView;
