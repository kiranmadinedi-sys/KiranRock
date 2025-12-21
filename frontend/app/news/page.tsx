'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import AppHeader from '../components/AppHeader';
import { getApiBaseUrl } from '../config';

interface NewsItem {
  headline: string;
  source: string;
  published_at: string;
  url: string;
  description?: string;
  summary?: string;
  tickers: string[];
  category: string;
  sentiment: number;
  sentiment_label?: string;
  market_impact: number;
  thumbnail?: string;
}

const categories = [
  { id: 'all', label: 'All', emoji: '📰' },
  { id: 'macro', label: 'Economics', emoji: '🌍' },
  { id: 'company', label: 'Stocks', emoji: '📈' },
  { id: 'market', label: 'Markets', emoji: '💹' }
];

const providers = [
  { id: 'all', label: 'All Sources' },
  { id: 'yahoo', label: 'Yahoo Finance' },
  { id: 'alphavantage', label: 'Alpha Vantage' },
  { id: 'finnhub', label: 'Finnhub' },
  { id: 'newsapi', label: 'NewsAPI' }
];

export default function NewsPage() {
  const [news, setNews] = useState<NewsItem[]>([]);
  const [filteredNews, setFilteredNews] = useState<NewsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState('all');
  const [selectedProvider, setSelectedProvider] = useState('all');
  const [searchTicker, setSearchTicker] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'time' | 'impact' | 'sentiment'>('time');

  useEffect(() => {
    fetchNews();
  }, []);

  useEffect(() => {
    filterAndSortNews();
  }, [news, selectedCategory, selectedProvider, searchTicker, searchQuery, sortBy]);

  const fetchNews = async (forceRefresh = false) => {
    setLoading(true);
    try {
      const apiBaseUrl = getApiBaseUrl();
      console.log('Fetching news from API:', apiBaseUrl);
      
      // Get token, but don't fail if it's not there (news should be public)
      const token = localStorage.getItem('token');
      const headers: HeadersInit = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }
      
      const response = await fetch(
        `${apiBaseUrl}/api/news-aggregation/aggregate?refresh=${forceRefresh}`,
        { headers }
      );
      
      console.log('Response status:', response.status);
      
      if (!response.ok) {
        console.error('Response not OK:', response.status, response.statusText);
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const data = await response.json();
      console.log('Response data:', data);
      
      if (data.success && data.news) {
        console.log(`Loaded ${data.news.length} news items`);
        setNews(data.news);
      } else {
        console.warn('No news data in response or success=false:', data);
        // Even if success is false, try to use the news if it exists
        if (data.news && Array.isArray(data.news)) {
          console.log('Using news array despite success=false');
          setNews(data.news);
        }
      }
    } catch (error) {
      console.error('Error fetching news:', error);
      // Show error in UI
      alert('Failed to load news. Please check console for details.');
    } finally {
      setLoading(false);
    }
  };

  const filterAndSortNews = () => {
    let filtered = news;

    // Filter by category
    if (selectedCategory !== 'all') {
      filtered = filtered.filter(item => item.category === selectedCategory);
    }

    // Filter by provider/source
    if (selectedProvider !== 'all') {
      filtered = filtered.filter(item => 
        item.source.toLowerCase().includes(selectedProvider.toLowerCase())
      );
    }

    // Filter by ticker
    if (searchTicker.trim()) {
      const ticker = searchTicker.trim().toUpperCase();
      filtered = filtered.filter(item => 
        item.tickers.some(t => t.includes(ticker))
      );
    }

    // Filter by search query
    if (searchQuery.trim()) {
      const query = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(item => 
        item.headline.toLowerCase().includes(query) ||
        item.description?.toLowerCase().includes(query) ||
        item.summary?.toLowerCase().includes(query)
      );
    }

    // Sort news
    if (sortBy === 'time') {
      filtered.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
    } else if (sortBy === 'impact') {
      filtered.sort((a, b) => b.market_impact - a.market_impact);
    } else if (sortBy === 'sentiment') {
      filtered.sort((a, b) => Math.abs(b.sentiment) - Math.abs(a.sentiment));
    }

    setFilteredNews(filtered);
  };

  const getSentimentColor = (sentiment: number) => {
    if (sentiment > 0.2) return 'text-green-400';
    if (sentiment < -0.2) return 'text-red-400';
    return 'text-gray-400';
  };

  const getSentimentEmoji = (sentiment: number) => {
    if (sentiment > 0.2) return '📈';
    if (sentiment < -0.2) return '📉';
    return '➡️';
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (seconds < 60) return 'Just now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <>
      <AppHeader showSearch={false} />
      <div className="min-h-screen bg-gray-900 text-white pt-32 pb-20">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {/* TradingView-style Header */}
          <div className="mb-6">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h1 className="text-2xl font-bold text-white flex items-center gap-2">
                  News Flow
                </h1>
                <p className="text-sm text-gray-400 mt-1">
                  Real-time market news from multiple providers
                </p>
              </div>
              <button
                onClick={() => fetchNews(true)}
                disabled={loading}
                className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded-lg transition disabled:opacity-50 text-sm font-medium"
              >
                {loading ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>Loading...</span>
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <span>Refresh</span>
                  </>
                )}
              </button>
            </div>

            {/* TradingView-style Filters */}
            <div className="flex flex-wrap items-center gap-2 mb-4">
              {/* Category Pills */}
              <div className="flex items-center gap-2">
                {categories.map(cat => (
                  <button
                    key={cat.id}
                    onClick={() => setSelectedCategory(cat.id)}
                    className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                      selectedCategory === cat.id
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                    }`}
                  >
                    {cat.emoji} {cat.label}
                  </button>
                ))}
              </div>

              <div className="h-6 w-px bg-gray-700" />

              {/* Provider Filter */}
              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                {providers.map(provider => (
                  <option key={provider.id} value={provider.id}>
                    {provider.label}
                  </option>
                ))}
              </select>

              <div className="h-6 w-px bg-gray-700" />

              {/* Sort */}
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-blue-500"
              >
                <option value="time">Latest First</option>
                <option value="impact">Highest Impact</option>
                <option value="sentiment">Strongest Sentiment</option>
              </select>

              <div className="h-6 w-px bg-gray-700" />

              {/* Reset Filters */}
              <button
                onClick={() => {
                  setSelectedCategory('all');
                  setSelectedProvider('all');
                  setSearchTicker('');
                  setSearchQuery('');
                  setSortBy('time');
                }}
                className="text-sm text-blue-400 hover:text-blue-300 transition"
              >
                Reset filters
              </button>
            </div>

            {/* Search Bars */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="relative">
                <input
                  type="text"
                  value={searchTicker}
                  onChange={(e) => setSearchTicker(e.target.value)}
                  placeholder="Filter by ticker (e.g., AAPL, TSLA)"
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <svg className="absolute left-3 top-2.5 w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search headlines and content..."
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg pl-10 pr-4 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                />
                <svg className="absolute left-3 top-2.5 w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
            </div>

            {/* Quick Stats */}
            <div className="mt-4 flex items-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-gray-400">Total:</span>
                <span className="font-medium text-white">{filteredNews.length}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-400">Bullish:</span>
                <span className="font-medium text-green-400">{filteredNews.filter(n => n.sentiment > 0.2).length}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-400">Bearish:</span>
                <span className="font-medium text-red-400">{filteredNews.filter(n => n.sentiment < -0.2).length}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-400">High Impact:</span>
                <span className="font-medium text-yellow-400">{filteredNews.filter(n => n.market_impact >= 3).length}</span>
              </div>
            </div>
          </div>
        </div>

        {/* TradingView-style News Table */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          {loading ? (
            <div className="flex items-center justify-center py-20">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
            </div>
          ) : filteredNews.length === 0 ? (
            <div className="text-center py-20">
              <svg className="w-16 h-16 text-gray-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z" />
              </svg>
              <p className="text-gray-400 text-lg">No news found matching your filters</p>
            </div>
          ) : (
            <div className="bg-gray-800 rounded-lg border border-gray-700 overflow-hidden">
              {/* Table Header */}
              <div className="hidden lg:grid grid-cols-12 gap-4 px-4 py-3 bg-gray-800/50 border-b border-gray-700 text-xs font-semibold text-gray-400 uppercase tracking-wider">
                <div className="col-span-1">Time</div>
                <div className="col-span-1">Source</div>
                <div className="col-span-7">Headline</div>
                <div className="col-span-2">Tickers</div>
                <div className="col-span-1 text-right">Impact</div>
              </div>

              {/* News Items */}
              <div className="divide-y divide-gray-700">
                <AnimatePresence>
                  {filteredNews.map((item, index) => {
                    const impactColor = item.market_impact >= 4 ? 'text-red-400' : 
                                      item.market_impact >= 3 ? 'text-yellow-400' : 
                                      item.market_impact >= 2 ? 'text-blue-400' : 'text-gray-500';
                    
                    const sentimentIcon = item.sentiment > 0.2 ? '📈' : item.sentiment < -0.2 ? '📉' : '';
                    const sentimentColor = item.sentiment > 0.2 ? 'text-green-400' : 
                                         item.sentiment < -0.2 ? 'text-red-400' : 'text-gray-400';

                    return (
                      <motion.a
                        key={index}
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="block hover:bg-gray-700/30 transition-colors"
                      >
                        {/* Desktop Layout */}
                        <div className="hidden lg:grid grid-cols-12 gap-4 px-4 py-4 items-start">
                          {/* Time */}
                          <div className="col-span-1 text-xs text-gray-400 pt-0.5">
                            {formatTimeAgo(item.published_at)}
                          </div>

                          {/* Source Icon */}
                          <div className="col-span-1">
                            <div className="w-8 h-8 rounded-full bg-gray-700 flex items-center justify-center text-xs font-medium">
                              {item.source.charAt(0).toUpperCase()}
                            </div>
                          </div>

                          {/* Headline */}
                          <div className="col-span-7">
                            <h3 className="text-sm font-medium text-white hover:text-blue-400 transition line-clamp-2 mb-1">
                              {sentimentIcon && <span className="mr-1">{sentimentIcon}</span>}
                              {item.headline}
                            </h3>
                            {item.description && (
                              <p className="text-xs text-gray-500 line-clamp-1">{item.description}</p>
                            )}
                          </div>

                          {/* Tickers */}
                          <div className="col-span-2 flex flex-wrap gap-1">
                            {item.tickers.slice(0, 3).map(ticker => (
                              <span key={ticker} className="px-2 py-0.5 bg-blue-500/10 text-blue-400 rounded text-xs font-medium">
                                {ticker}
                              </span>
                            ))}
                            {item.tickers.length > 3 && (
                              <span className="px-2 py-0.5 text-gray-500 text-xs">+{item.tickers.length - 3}</span>
                            )}
                          </div>

                          {/* Impact */}
                          <div className="col-span-1 text-right">
                            <div className="flex items-center justify-end gap-1">
                              {item.sentiment !== 0 && (
                                <span className={`text-xs ${sentimentColor}`}>
                                  {item.sentiment > 0 ? '+' : ''}{(item.sentiment * 100).toFixed(0)}%
                                </span>
                              )}
                              <span className={`text-lg ${impactColor}`}>
                                {item.market_impact >= 4 ? '🔥' : item.market_impact >= 3 ? '⚡' : item.market_impact >= 2 ? '📊' : '·'}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Mobile Layout */}
                        <div className="lg:hidden px-4 py-4">
                          <div className="flex items-start gap-3">
                            {/* Icon + Time */}
                            <div className="flex-shrink-0">
                              <div className="w-10 h-10 rounded-full bg-gray-700 flex items-center justify-center text-sm font-medium mb-1">
                                {item.source.charAt(0).toUpperCase()}
                              </div>
                              <div className="text-[10px] text-gray-500 text-center">
                                {formatTimeAgo(item.published_at).split(' ')[0]}
                              </div>
                            </div>

                            {/* Content */}
                            <div className="flex-1 min-w-0">
                              <h3 className="text-sm font-medium text-white line-clamp-2 mb-2">
                                {sentimentIcon && <span className="mr-1">{sentimentIcon}</span>}
                                {item.headline}
                              </h3>
                              
                              {/* Meta */}
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span className="text-gray-500">{item.source}</span>
                                {item.tickers.length > 0 && (
                                  <>
                                    <span className="text-gray-600">·</span>
                                    <div className="flex gap-1">
                                      {item.tickers.slice(0, 2).map(ticker => (
                                        <span key={ticker} className="px-1.5 py-0.5 bg-blue-500/10 text-blue-400 rounded">
                                          {ticker}
                                        </span>
                                      ))}
                                    </div>
                                  </>
                                )}
                                <span className="text-gray-600">·</span>
                                <span className={impactColor}>
                                  {item.market_impact >= 4 ? '🔥' : item.market_impact >= 3 ? '⚡' : '📊'}
                                </span>
                                {item.sentiment !== 0 && (
                                  <>
                                    <span className="text-gray-600">·</span>
                                    <span className={sentimentColor}>
                                      {item.sentiment > 0 ? '+' : ''}{(item.sentiment * 100).toFixed(0)}%
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </motion.a>
                    );
                  })}
                </AnimatePresence>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
