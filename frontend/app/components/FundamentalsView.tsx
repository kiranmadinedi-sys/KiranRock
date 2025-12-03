
'use client';
import { API_BASE_URL } from '../config/apiConfig';
import React, { useState, useEffect } from 'react';

interface FundamentalsProps {
    symbol: string;
}

const FundamentalsView: React.FC<FundamentalsProps> = ({ symbol }) => {
    const [fundamentals, setFundamentals] = useState<any>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const fetchFundamentals = async () => {
            setLoading(true);
            const token = localStorage.getItem('token');
            try {
                console.log(`Fetching fundamentals for ${symbol}...`);
                const response = await fetch(`${API_BASE_URL}/api/fundamentals/${symbol}`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                console.log('Response status:', response.status);
                if (response.ok) {
                    const data = await response.json();
                    console.log('Fundamentals data:', data);
                    setFundamentals(data);
                } else {
                    console.error('Response not OK:', response.status, response.statusText);
                }
            } catch (error) {
                console.error('Error fetching fundamentals:', error);
            } finally {
                setLoading(false);
            }
        };

        if (symbol) {
            fetchFundamentals();
        }
    }, [symbol]);

    if (loading) {
        return (
            <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-center text-[var(--color-text-secondary)]">Loading fundamentals...</div>
            </div>
        );
    }

    if (!fundamentals || fundamentals.error) {
        return (
            <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-center text-[var(--color-text-secondary)]">Fundamental data unavailable</div>
            </div>
        );
    }

    const getValuationColor = () => {
        if (!fundamentals.valuation) return 'text-[var(--color-text-secondary)]';
        if (fundamentals.valuation.signal === 'Bullish') return 'text-[var(--color-success)]';
        if (fundamentals.valuation.signal === 'Bearish') return 'text-[var(--color-danger)]';
        return 'text-yellow-600 dark:text-yellow-400';
    };

    const getGrowthColor = () => {
        if (!fundamentals.growth) return 'text-[var(--color-text-secondary)]';
        if (fundamentals.growth.signal === 'Bullish') return 'text-[var(--color-success)]';
        if (fundamentals.growth.signal === 'Bearish') return 'text-[var(--color-danger)]';
        return 'text-yellow-600 dark:text-yellow-400';
    };

    return (
        <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] shadow-sm">
            <div className="px-4 py-3 border-b border-[var(--color-border)]">
                <h3 className="text-lg font-bold text-[var(--color-text-primary)] flex items-center">
                    <span className="mr-2">📊</span>
                    Fundamentals
                </h3>
            </div>

            <div className="p-4 space-y-4">
                {/* Key Metrics */}
                <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                        <div className="text-xs text-[var(--color-text-secondary)] mb-1">P/E Ratio</div>
                        <div className="text-lg font-bold text-[var(--color-text-primary)]">{fundamentals.metrics.peRatio}</div>
                    </div>
                    <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                        <div className="text-xs text-[var(--color-text-secondary)] mb-1">PEG Ratio</div>
                        <div className="text-lg font-bold text-[var(--color-text-primary)]">{fundamentals.metrics.pegRatio}</div>
                    </div>
                    <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                        <div className="text-xs text-[var(--color-text-secondary)] mb-1">EPS</div>
                        <div className="text-lg font-bold text-[var(--color-text-primary)]">{fundamentals.metrics.eps}</div>
                    </div>
                    <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                        <div className="text-xs text-[var(--color-text-secondary)] mb-1">Revenue Growth</div>
                        <div className="text-lg font-bold text-[var(--color-text-primary)]">{fundamentals.metrics.revenueGrowth}</div>
                    </div>
                    <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                        <div className="text-xs text-[var(--color-text-secondary)] mb-1">Market Cap</div>
                        <div className="text-lg font-bold text-[var(--color-text-primary)]">{fundamentals.metrics.marketCap}</div>
                    </div>
                    <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                        <div className="text-xs text-[var(--color-text-secondary)] mb-1">Dividend</div>
                        <div className="text-lg font-bold text-[var(--color-text-primary)]">{fundamentals.metrics.dividend}</div>
                    </div>
                </div>

                {/* Analyst Ratings */}
                {fundamentals.analystRatings && (
                    <div className="bg-[var(--color-bg-tertiary)] p-4 rounded-lg border border-[var(--color-border)]">
                        <h4 className="font-semibold text-[var(--color-text-primary)] mb-3">Analyst Ratings & Estimates</h4>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <div className="space-y-2">
                                    <div className="flex justify-between items-center">
                                        <span className="text-sm text-[var(--color-text-secondary)]">Buy</span>
                                        <span className="text-sm font-semibold text-[var(--color-success)]">
                                            {((fundamentals.analystRatings.buy / 
                                              (fundamentals.analystRatings.strongBuy + fundamentals.analystRatings.buy + 
                                               fundamentals.analystRatings.hold + fundamentals.analystRatings.sell + 
                                               fundamentals.analystRatings.strongSell || 1)) * 100).toFixed(1)}%
                                        </span>
                                    </div>
                                    <div className="w-full bg-[var(--color-bg-secondary)] rounded-full h-2">
                                        <div 
                                            className="bg-[var(--color-success)] h-2 rounded-full" 
                                            style={{width: `${(fundamentals.analystRatings.buy / 
                                                (fundamentals.analystRatings.strongBuy + fundamentals.analystRatings.buy + 
                                                 fundamentals.analystRatings.hold + fundamentals.analystRatings.sell + 
                                                 fundamentals.analystRatings.strongSell || 1)) * 100}%`}}
                                        />
                                    </div>
                                    <div className="flex justify-between items-center">
                                        <span className="text-sm text-[var(--color-text-secondary)]">Hold</span>
                                        <span className="text-sm font-semibold text-yellow-600 dark:text-yellow-400">
                                            {((fundamentals.analystRatings.hold / 
                                              (fundamentals.analystRatings.strongBuy + fundamentals.analystRatings.buy + 
                                               fundamentals.analystRatings.hold + fundamentals.analystRatings.sell + 
                                               fundamentals.analystRatings.strongSell || 1)) * 100).toFixed(1)}%
                                        </span>
                                    </div>
                                    <div className="w-full bg-[var(--color-bg-secondary)] rounded-full h-2">
                                        <div 
                                            className="bg-yellow-500 h-2 rounded-full" 
                                            style={{width: `${(fundamentals.analystRatings.hold / 
                                                (fundamentals.analystRatings.strongBuy + fundamentals.analystRatings.buy + 
                                                 fundamentals.analystRatings.hold + fundamentals.analystRatings.sell + 
                                                 fundamentals.analystRatings.strongSell || 1)) * 100}%`}}
                                        />
                                    </div>
                                    <div className="flex justify-between items-center">
                                        <span className="text-sm text-[var(--color-text-secondary)]">Sell</span>
                                        <span className="text-sm font-semibold text-[var(--color-danger)]">
                                            {((fundamentals.analystRatings.sell / 
                                              (fundamentals.analystRatings.strongBuy + fundamentals.analystRatings.buy + 
                                               fundamentals.analystRatings.hold + fundamentals.analystRatings.sell + 
                                               fundamentals.analystRatings.strongSell || 1)) * 100).toFixed(1)}%
                                        </span>
                                    </div>
                                    <div className="w-full bg-[var(--color-bg-secondary)] rounded-full h-2">
                                        <div 
                                            className="bg-[var(--color-danger)] h-2 rounded-full" 
                                            style={{width: `${(fundamentals.analystRatings.sell / 
                                                (fundamentals.analystRatings.strongBuy + fundamentals.analystRatings.buy + 
                                                 fundamentals.analystRatings.hold + fundamentals.analystRatings.sell + 
                                                 fundamentals.analystRatings.strongSell || 1)) * 100}%`}}
                                        />
                                    </div>
                                </div>
                            </div>
                            <div className="flex flex-col justify-center items-center">
                                <div className="w-24 h-24 rounded-full flex items-center justify-center bg-[var(--color-bg-secondary)] border-4 border-[var(--color-success)]">
                                    <span className="text-2xl font-bold text-[var(--color-text-primary)]">
                                        {fundamentals.analystRatings.consensus}
                                    </span>
                                </div>
                                <div className="mt-2 text-xs text-[var(--color-text-secondary)] text-center">
                                    Based on {fundamentals.analystRatings.strongBuy + fundamentals.analystRatings.buy + 
                                             fundamentals.analystRatings.hold + fundamentals.analystRatings.sell + 
                                             fundamentals.analystRatings.strongSell} analysts
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Price Targets */}
                {fundamentals.priceTargets && (
                    <div className="bg-[var(--color-bg-tertiary)] p-4 rounded-lg border border-[var(--color-border)]">
                        <h4 className="font-semibold text-[var(--color-text-primary)] mb-3">Price Target for Next 12 Months</h4>
                        <div className="space-y-3">
                            <div className="flex justify-between items-center">
                                <span className="text-sm text-[var(--color-text-secondary)]">Current Price</span>
                                <span className="text-lg font-bold text-[var(--color-text-primary)]">${fundamentals.priceTargets.current}</span>
                            </div>
                            <div className="relative h-8 bg-gradient-to-r from-[var(--color-danger)] via-yellow-500 to-[var(--color-success)] rounded-full">
                                <div className="absolute inset-0 flex items-center justify-between px-2 text-xs font-semibold text-white">
                                    <span>Min ${fundamentals.priceTargets.low}</span>
                                    <span>Avg ${fundamentals.priceTargets.average}</span>
                                    <span>Max ${fundamentals.priceTargets.high}</span>
                                </div>
                            </div>
                            <div className="flex justify-between text-xs text-[var(--color-text-secondary)]">
                                <div>
                                    <div className="font-semibold">Upside Potential</div>
                                    <div className="text-[var(--color-success)]">
                                        +{(((parseFloat(fundamentals.priceTargets.high) - parseFloat(fundamentals.priceTargets.current)) / 
                                           parseFloat(fundamentals.priceTargets.current)) * 100).toFixed(1)}%
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className="font-semibold">Downside Risk</div>
                                    <div className="text-[var(--color-danger)]">
                                        {(((parseFloat(fundamentals.priceTargets.low) - parseFloat(fundamentals.priceTargets.current)) / 
                                          parseFloat(fundamentals.priceTargets.current)) * 100).toFixed(1)}%
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Valuation */}
                {fundamentals.valuation && (
                    <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                        <div className="flex items-center justify-between mb-2">
                            <span className="font-semibold text-[var(--color-text-primary)]">Valuation</span>
                            <span className={`font-bold ${getValuationColor()}`}>{fundamentals.valuation.status}</span>
                        </div>
                        <p className="text-sm text-[var(--color-text-secondary)]">{fundamentals.valuation.description}</p>
                    </div>
                )}

                {/* Growth */}
                {fundamentals.growth && (
                    <div className="bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)]">
                        <div className="flex items-center justify-between mb-2">
                            <span className="font-semibold text-[var(--color-text-primary)]">Growth</span>
                            <span className={`font-bold ${getGrowthColor()}`}>{fundamentals.growth.status}</span>
                        </div>
                        <p className="text-sm text-[var(--color-text-secondary)]">{fundamentals.growth.description}</p>
                    </div>
                )}

                {/* Recommendation */}
                {fundamentals.recommendation && (
                    <div className={`p-3 rounded-lg border ${
                        fundamentals.recommendation.rating?.includes('Buy') 
                            ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-800' 
                            : fundamentals.recommendation.rating?.includes('Sell')
                            ? 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800'
                            : 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-300 dark:border-yellow-800'
                    }`}>
                        <div className="flex items-center justify-between mb-2">
                            <span className="font-bold text-[var(--color-text-primary)]">Recommendation</span>
                            <span className="font-bold text-[var(--color-text-primary)]">{fundamentals.recommendation.rating}</span>
                        </div>
                        <p className="text-sm text-[var(--color-text-secondary)]">{fundamentals.recommendation.rationale}</p>
                        <div className="mt-2 text-xs text-[var(--color-text-secondary)]">
                            Confidence: {fundamentals.recommendation.confidence}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default FundamentalsView;
