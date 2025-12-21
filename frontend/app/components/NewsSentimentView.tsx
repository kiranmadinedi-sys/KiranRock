
'use client';
import { getApiBaseUrl } from '../config';
import React, { useState, useEffect } from 'react';

interface NewsSentimentProps {
    symbol: string;
}

const NewsSentimentView: React.FC<NewsSentimentProps> = ({ symbol }) => {
    const [newsData, setNewsData] = useState<any>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        const fetchNews = async () => {
            setLoading(true);
            const token = localStorage.getItem('token');
            try {
                const response = await fetch(`${getApiBaseUrl()}/api/news/${symbol}`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (response.ok) {
                    const data = await response.json();
                    setNewsData(data);
                }
            } catch (error) {
                console.error('Error fetching news:', error);
            } finally {
                setLoading(false);
            }
        };

        if (symbol) {
            fetchNews();
        }
    }, [symbol]);

    if (loading) {
        return (
            <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-center text-[var(--color-text-secondary)]">Loading news...</div>
            </div>
        );
    }

    if (!newsData || newsData.error) {
        return (
            <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] p-4">
                <div className="text-center text-[var(--color-text-secondary)]">News unavailable</div>
            </div>
        );
    }

    const getSentimentColor = (label: string) => {
        if (label.includes('Positive')) return 'text-[var(--color-success)]';
        if (label.includes('Negative')) return 'text-[var(--color-danger)]';
        return 'text-yellow-600 dark:text-yellow-400';
    };

    const getSentimentBg = (label: string) => {
        if (label.includes('Positive')) return 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-800';
        if (label.includes('Negative')) return 'bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800';
        return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-300 dark:border-yellow-800';
    };

    return (
        <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] shadow-sm">
            <div className="px-4 py-3 border-b border-[var(--color-border)]">
                <h3 className="text-lg font-bold text-[var(--color-text-primary)] flex items-center">
                    <span className="mr-2">📰</span>
                    News & Sentiment
                </h3>
            </div>

            <div className="p-4 space-y-4">
                {/* Overall Sentiment */}
                {newsData.sentiment && (
                    <div className={`p-4 rounded-lg border ${getSentimentBg(newsData.sentiment.label)}`}>
                        <div className="flex items-center justify-between mb-2">
                            <span className="font-bold text-[var(--color-text-primary)]">Overall Sentiment</span>
                            <span className={`font-bold text-lg ${getSentimentColor(newsData.sentiment.label)}`}>
                                {newsData.sentiment.label}
                            </span>
                        </div>
                        <div className="text-sm text-[var(--color-text-secondary)] mb-2">
                            Score: {newsData.sentiment.score} | Confidence: {newsData.sentiment.confidence}
                        </div>
                        {newsData.sentiment.breakdown && (
                            <div className="flex gap-4 text-xs mt-3">
                                <span className="text-green-600 dark:text-green-400">✓ Positive: {newsData.sentiment.breakdown.positive}</span>
                                <span className="text-red-600 dark:text-red-400">✗ Negative: {newsData.sentiment.breakdown.negative}</span>
                                <span className="text-yellow-600 dark:text-yellow-400">○ Neutral: {newsData.sentiment.breakdown.neutral}</span>
                            </div>
                        )}
                    </div>
                )}

                {/* Historical Sentiment Trend Chart */}
                {newsData.historicalSentiment && newsData.historicalSentiment.length > 0 && (
                    <div className="bg-[var(--color-bg-tertiary)] p-4 rounded-lg border border-[var(--color-border)]">
                        <h4 className="font-semibold text-[var(--color-text-primary)] mb-3">📊 Sentiment Trend</h4>
                        <div className="space-y-2">
                            {newsData.historicalSentiment.map((day: any, index: number) => {
                                const sentiment = parseFloat(day.sentiment);
                                const maxWidth = Math.abs(sentiment);
                                const isPositive = sentiment >= 0;
                                
                                return (
                                    <div key={index} className="flex items-center gap-2">
                                        <div className="text-xs text-[var(--color-text-secondary)] w-24">
                                            {new Date(day.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                                        </div>
                                        <div className="flex-1 flex items-center">
                                            <div className="flex-1 flex justify-end pr-1">
                                                {!isPositive && (
                                                    <div 
                                                        className="h-6 bg-[var(--color-danger)] rounded-l"
                                                        style={{ width: `${maxWidth}%` }}
                                                    />
                                                )}
                                            </div>
                                            <div className="w-px h-6 bg-[var(--color-border)]"></div>
                                            <div className="flex-1 pl-1">
                                                {isPositive && (
                                                    <div 
                                                        className="h-6 bg-[var(--color-success)] rounded-r"
                                                        style={{ width: `${maxWidth}%` }}
                                                    />
                                                )}
                                            </div>
                                        </div>
                                        <div className={`text-xs font-semibold w-12 text-right ${
                                            isPositive ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'
                                        }`}>
                                            {sentiment > 0 ? '+' : ''}{sentiment}
                                        </div>
                                        <div className="text-xs text-[var(--color-text-secondary)] w-16">
                                            ({day.articleCount} {day.articleCount === 1 ? 'article' : 'articles'})
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <div className="mt-3 flex justify-center gap-4 text-xs text-[var(--color-text-secondary)]">
                            <span className="flex items-center gap-1">
                                <div className="w-3 h-3 bg-[var(--color-success)] rounded"></div>
                                Positive
                            </span>
                            <span className="flex items-center gap-1">
                                <div className="w-3 h-3 bg-[var(--color-danger)] rounded"></div>
                                Negative
                            </span>
                        </div>
                    </div>
                )}

                {/* Analyst Ratings */}
                {newsData.analystRatings && (
                    <div className="bg-[var(--color-bg-tertiary)] p-4 rounded-lg border border-[var(--color-border)]">
                        <div className="flex items-center justify-between mb-3">
                            <span className="font-semibold text-[var(--color-text-primary)]">Analyst Consensus</span>
                            <span className="font-bold text-[var(--color-text-primary)]">{newsData.analystRatings.consensus}</span>
                        </div>
                        <div className="grid grid-cols-5 gap-2 text-center text-xs">
                            <div>
                                <div className="text-[var(--color-success)] font-bold">{newsData.analystRatings.strongBuy}</div>
                                <div className="text-[var(--color-text-secondary)]">Strong Buy</div>
                            </div>
                            <div>
                                <div className="text-green-500 font-bold">{newsData.analystRatings.buy}</div>
                                <div className="text-[var(--color-text-secondary)]">Buy</div>
                            </div>
                            <div>
                                <div className="text-yellow-600 dark:text-yellow-400 font-bold">{newsData.analystRatings.hold}</div>
                                <div className="text-[var(--color-text-secondary)]">Hold</div>
                            </div>
                            <div>
                                <div className="text-red-500 font-bold">{newsData.analystRatings.sell}</div>
                                <div className="text-[var(--color-text-secondary)]">Sell</div>
                            </div>
                            <div>
                                <div className="text-[var(--color-danger)] font-bold">{newsData.analystRatings.strongSell}</div>
                                <div className="text-[var(--color-text-secondary)]">Strong Sell</div>
                            </div>
                        </div>
                    </div>
                )}

                {/* Recent Articles */}
                {newsData.articles && newsData.articles.length > 0 && (
                    <div>
                        <h4 className="font-semibold text-[var(--color-text-primary)] mb-2">Recent Articles</h4>
                        <div className="space-y-2 max-h-64 overflow-y-auto">
                            {newsData.articles.slice(0, 5).map((article: any, index: number) => (
                                <a
                                    key={index}
                                    href={article.link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="block bg-[var(--color-bg-tertiary)] p-3 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)] transition-colors"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="flex-1 min-w-0">
                                            <h5 className="text-sm font-medium text-[var(--color-text-primary)] line-clamp-2 mb-1">
                                                {article.title}
                                            </h5>
                                            <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                                                <span>{article.publisher}</span>
                                                <span>•</span>
                                                <span>{new Date(article.publishedAt).toLocaleDateString()}</span>
                                            </div>
                                        </div>
                                        {article.sentiment && (
                                            <div className={`text-xs font-semibold whitespace-nowrap ${getSentimentColor(article.sentiment.label)}`}>
                                                {article.sentiment.label}
                                            </div>
                                        )}
                                    </div>
                                </a>
                            ))}
                        </div>
                    </div>
                )}

                {/* Summary */}
                {newsData.summary && (
                    <div className="text-sm text-[var(--color-text-secondary)] italic border-l-4 border-[var(--color-accent)] pl-3">
                        {newsData.summary}
                    </div>
                )}
            </div>
        </div>
    );
};

export default NewsSentimentView;
