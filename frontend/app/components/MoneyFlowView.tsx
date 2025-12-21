
'use client';
import { getApiBaseUrl } from '../config';
import React, { useState, useEffect } from 'react';

interface MoneyFlowProps {
    symbol: string;
}

const MoneyFlowView: React.FC<MoneyFlowProps> = ({ symbol }) => {
    const [moneyFlow, setMoneyFlow] = useState<any>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const fetchMoneyFlow = async () => {
            setLoading(true);
            const token = localStorage.getItem('token');
            try {
                const response = await fetch(`${getApiBaseUrl()}/api/moneyflow/${symbol}`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (response.ok) {
                    const data = await response.json();
                    setMoneyFlow(data);
                }
            } catch (error) {
                console.error('Error fetching money flow:', error);
            } finally {
                setLoading(false);
            }
        };

        if (symbol) {
            fetchMoneyFlow();
        }
    }, [symbol]);

    if (loading) {
        return (
            <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-center text-[var(--color-text-secondary)]">Loading money flow...</div>
            </div>
        );
    }

    if (!moneyFlow) {
        return (
            <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-center text-[var(--color-text-secondary)]">Money flow data unavailable</div>
            </div>
        );
    }

    const inflowPercent = (parseFloat(moneyFlow.totalInflow) / (parseFloat(moneyFlow.totalInflow) + parseFloat(moneyFlow.totalOutflow))) * 100;
    const outflowPercent = 100 - inflowPercent;

    return (
        <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] shadow-sm">
            <div className="px-4 py-3 border-b border-[var(--color-border)]">
                <h3 className="text-lg font-bold text-[var(--color-text-primary)] flex items-center">
                    <span className="mr-2">💰</span>
                    Trade Overview
                </h3>
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                    Institutional money flow analysis by order size
                </p>
            </div>

            <div className="p-6 space-y-6">
                {/* Pie Chart Representation */}
                <div className="flex flex-col md:flex-row items-center gap-6">
                    {/* Donut Chart */}
                    <div className="relative w-64 h-64">
                        <svg viewBox="0 0 200 200" className="transform -rotate-90">
                            {/* Outflow segments */}
                            <circle
                                cx="100"
                                cy="100"
                                r="80"
                                fill="none"
                                stroke="#00c805"
                                strokeWidth="40"
                                strokeDasharray={`${parseFloat(moneyFlow.breakdown.outflow.s.percent) * 5.027} 502.7`}
                                strokeDashoffset="0"
                            />
                            <circle
                                cx="100"
                                cy="100"
                                r="80"
                                fill="none"
                                stroke="#00c805"
                                strokeWidth="40"
                                strokeDasharray={`${parseFloat(moneyFlow.breakdown.outflow.m.percent) * 5.027} 502.7`}
                                strokeDashoffset={`-${parseFloat(moneyFlow.breakdown.outflow.s.percent) * 5.027}`}
                                opacity="0.8"
                            />
                            <circle
                                cx="100"
                                cy="100"
                                r="80"
                                fill="none"
                                stroke="#00c805"
                                strokeWidth="40"
                                strokeDasharray={`${parseFloat(moneyFlow.breakdown.outflow.l.percent) * 5.027} 502.7`}
                                strokeDashoffset={`-${(parseFloat(moneyFlow.breakdown.outflow.s.percent) + parseFloat(moneyFlow.breakdown.outflow.m.percent)) * 5.027}`}
                                opacity="0.6"
                            />
                            <circle
                                cx="100"
                                cy="100"
                                r="80"
                                fill="none"
                                stroke="#00c805"
                                strokeWidth="40"
                                strokeDasharray={`${parseFloat(moneyFlow.breakdown.outflow.xl.percent) * 5.027} 502.7`}
                                strokeDashoffset={`-${(parseFloat(moneyFlow.breakdown.outflow.s.percent) + parseFloat(moneyFlow.breakdown.outflow.m.percent) + parseFloat(moneyFlow.breakdown.outflow.l.percent)) * 5.027}`}
                                opacity="0.4"
                            />
                            {/* Inflow segments */}
                            <circle
                                cx="100"
                                cy="100"
                                r="80"
                                fill="none"
                                stroke="#ff5000"
                                strokeWidth="40"
                                strokeDasharray={`${parseFloat(moneyFlow.breakdown.inflow.s.percent) * 5.027} 502.7`}
                                strokeDashoffset={`-${outflowPercent * 5.027}`}
                            />
                            <circle
                                cx="100"
                                cy="100"
                                r="80"
                                fill="none"
                                stroke="#ff5000"
                                strokeWidth="40"
                                strokeDasharray={`${parseFloat(moneyFlow.breakdown.inflow.m.percent) * 5.027} 502.7`}
                                strokeDashoffset={`-${(outflowPercent + parseFloat(moneyFlow.breakdown.inflow.s.percent)) * 5.027}`}
                                opacity="0.8"
                            />
                            <circle
                                cx="100"
                                cy="100"
                                r="80"
                                fill="none"
                                stroke="#ff5000"
                                strokeWidth="40"
                                strokeDasharray={`${parseFloat(moneyFlow.breakdown.inflow.l.percent) * 5.027} 502.7`}
                                strokeDashoffset={`-${(outflowPercent + parseFloat(moneyFlow.breakdown.inflow.s.percent) + parseFloat(moneyFlow.breakdown.inflow.m.percent)) * 5.027}`}
                                opacity="0.6"
                            />
                            <circle
                                cx="100"
                                cy="100"
                                r="80"
                                fill="none"
                                stroke="#ff5000"
                                strokeWidth="40"
                                strokeDasharray={`${parseFloat(moneyFlow.breakdown.inflow.l.percent) * 5.027} 502.7`}
                                strokeDashoffset={`-${(outflowPercent + parseFloat(moneyFlow.breakdown.inflow.s.percent) + parseFloat(moneyFlow.breakdown.inflow.m.percent) + parseFloat(moneyFlow.breakdown.inflow.l.percent)) * 5.027}`}
                                opacity="0.4"
                            />
                        </svg>
                        {/* Center text */}
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            <div className="text-xs text-[var(--color-text-secondary)]">
                                {moneyFlow.trend.direction}
                            </div>
                            <div className="text-2xl font-bold text-[var(--color-text-primary)]">
                                {Math.abs(moneyFlow.netFlow).toFixed(2)}M
                            </div>
                        </div>
                    </div>

                    {/* Legend */}
                    <div className="flex-1 space-y-2">
                        <div className="text-sm font-semibold text-[var(--color-text-primary)] mb-3">
                            Inflow: <span className="text-[var(--color-danger)]">{moneyFlow.totalInflow}M</span>
                            {' '} | Outflow: <span className="text-[var(--color-success)]">{moneyFlow.totalOutflow}M</span>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-[var(--color-success)]"></div>
                                <span className="text-[var(--color-text-secondary)]">{moneyFlow.breakdown.outflow.xl.percent}%</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-[var(--color-danger)]"></div>
                                <span className="text-[var(--color-text-secondary)]">{moneyFlow.breakdown.inflow.xl.percent}%</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-[var(--color-success)] opacity-80"></div>
                                <span className="text-[var(--color-text-secondary)]">{moneyFlow.breakdown.outflow.l.percent}%</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-[var(--color-danger)] opacity-80"></div>
                                <span className="text-[var(--color-text-secondary)]">{moneyFlow.breakdown.inflow.l.percent}%</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-[var(--color-success)] opacity-60"></div>
                                <span className="text-[var(--color-text-secondary)]">{moneyFlow.breakdown.outflow.m.percent}%</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-[var(--color-danger)] opacity-60"></div>
                                <span className="text-[var(--color-text-secondary)]">{moneyFlow.breakdown.inflow.m.percent}%</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-[var(--color-success)] opacity-40"></div>
                                <span className="text-[var(--color-text-secondary)]">{moneyFlow.breakdown.outflow.s.percent}%</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-3 h-3 rounded-full bg-[var(--color-danger)] opacity-40"></div>
                                <span className="text-[var(--color-text-secondary)]">{moneyFlow.breakdown.inflow.s.percent}%</span>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Bar Chart */}
                <div className="space-y-2">
                    <div className="text-sm font-semibold text-[var(--color-text-secondary)]">Order Size Breakdown (M)</div>
                    {['xl', 'l', 'm', 's'].map((size) => (
                        <div key={size} className="flex items-center gap-2">
                            <div className="w-16 text-xs text-[var(--color-text-secondary)] font-medium uppercase">{size}</div>
                            <div className="flex-1 flex gap-1">
                                <div className="flex-1 flex justify-end items-center gap-2">
                                    <span className="text-xs text-[var(--color-text-secondary)]">
                                        {moneyFlow.breakdown.inflow[size].amount.toFixed(2)}
                                    </span>
                                    <div 
                                        className="h-6 bg-[var(--color-danger)] rounded"
                                        style={{ width: `${parseFloat(moneyFlow.breakdown.inflow[size].percent) * 3}%` }}
                                    />
                                </div>
                                <div className="flex-1 flex items-center gap-2">
                                    <div 
                                        className="h-6 bg-[var(--color-success)] rounded"
                                        style={{ width: `${parseFloat(moneyFlow.breakdown.outflow[size].percent) * 3}%` }}
                                    />
                                    <span className="text-xs text-[var(--color-text-secondary)]">
                                        {moneyFlow.breakdown.outflow[size].amount.toFixed(2)}
                                    </span>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                {/* Trend Summary */}
                <div className={`p-3 rounded-lg border ${
                    moneyFlow.trend.sentiment === 'Bullish'
                        ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-800'
                        : moneyFlow.trend.sentiment === 'Bearish'
                        ? 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800'
                        : 'bg-gray-50 dark:bg-gray-900/20 border-gray-300 dark:border-gray-800'
                }`}>
                    <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-[var(--color-text-primary)]">Trend Analysis</span>
                        <span className={`font-bold ${
                            moneyFlow.trend.sentiment === 'Bullish' ? 'text-[var(--color-success)]' :
                            moneyFlow.trend.sentiment === 'Bearish' ? 'text-[var(--color-danger)]' :
                            'text-[var(--color-text-secondary)]'
                        }`}>
                            {moneyFlow.trend.sentiment} ({moneyFlow.trend.strength})
                        </span>
                    </div>
                    <p className="text-sm text-[var(--color-text-secondary)]">{moneyFlow.trend.description}</p>
                </div>
            </div>
        </div>
    );
};

export default MoneyFlowView;
