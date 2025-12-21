const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Cache file for news to avoid hitting rate limits
const NEWS_CACHE_FILE = path.join(__dirname, '../storage/newsCache.json');
const CACHE_DURATION = 15 * 60 * 1000; // 15 minutes

// Ensure storage directory exists
const storageDir = path.dirname(NEWS_CACHE_FILE);
if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
}

/**
 * Read cached news
 */
function readCache() {
    try {
        if (fs.existsSync(NEWS_CACHE_FILE)) {
            const data = fs.readFileSync(NEWS_CACHE_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) {
        console.error('Error reading news cache:', error);
    }
    return { timestamp: 0, news: [] };
}

/**
 * Write news to cache
 */
function writeCache(news) {
    try {
        fs.writeFileSync(NEWS_CACHE_FILE, JSON.stringify({
            timestamp: Date.now(),
            news
        }, null, 2));
    } catch (error) {
        console.error('Error writing news cache:', error);
    }
}

/**
 * Check if cache is valid
 */
function isCacheValid(cache) {
    return cache.timestamp && (Date.now() - cache.timestamp < CACHE_DURATION);
}

/**
 * Fetch news from Yahoo Finance for a specific ticker
 */
async function fetchYahooNews(symbol) {
    try {
        const response = await axios.get(`https://query1.finance.yahoo.com/v1/finance/search`, {
            params: {
                q: symbol,
                quotesCount: 0,
                newsCount: 20 // Increased from 10
            },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 5000
        });

        if (response.data && response.data.news) {
            return response.data.news.map(item => ({
                headline: item.title,
                source: item.publisher || 'Yahoo Finance',
                published_at: new Date(item.providerPublishTime * 1000).toISOString(),
                url: item.link,
                tickers: [symbol],
                category: 'company',
                sentiment: 0, // Neutral by default
                thumbnail: item.thumbnail?.resolutions?.[0]?.url || null
            }));
        }
    } catch (error) {
        console.error(`Error fetching Yahoo Finance news for ${symbol}:`, error.message);
    }
    return [];
}

/**
 * Fetch general market news from Yahoo Finance
 */
async function fetchYahooMarketNews() {
    try {
        const marketKeywords = ['stock market', 'S&P 500', 'Nasdaq', 'Dow Jones', 'Federal Reserve'];
        const allNews = [];

        for (const keyword of marketKeywords) {
            try {
                const response = await axios.get(`https://query1.finance.yahoo.com/v1/finance/search`, {
                    params: {
                        q: keyword,
                        quotesCount: 0,
                        newsCount: 10
                    },
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    },
                    timeout: 5000
                });

                if (response.data && response.data.news) {
                    const news = response.data.news.map(item => ({
                        headline: item.title,
                        source: item.publisher || 'Yahoo Finance',
                        published_at: new Date(item.providerPublishTime * 1000).toISOString(),
                        url: item.link,
                        tickers: [],
                        category: 'macro',
                        sentiment: 0,
                        thumbnail: item.thumbnail?.resolutions?.[0]?.url || null
                    }));
                    allNews.push(...news);
                }
                
                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (err) {
                console.error(`Error fetching Yahoo news for ${keyword}:`, err.message);
            }
        }

        return allNews;
    } catch (error) {
        console.error('Error fetching Yahoo market news:', error.message);
    }
    return [];
}

/**
 * Fetch general market news from NewsAPI (Free tier)
 * Note: Get your free API key from https://newsapi.org/
 */
async function fetchNewsAPIMarketNews() {
    const API_KEY = process.env.NEWSAPI_KEY || 'demo'; // User needs to set this
    
    if (API_KEY === 'demo') {
        console.warn('⚠️  NewsAPI key not configured. Using demo data.');
        return [];
    }

    try {
        const response = await axios.get('https://newsapi.org/v2/everything', {
            params: {
                q: 'stock market OR Federal Reserve OR interest rates OR inflation OR economy',
                language: 'en',
                sortBy: 'publishedAt',
                pageSize: 20,
                apiKey: API_KEY
            }
        });

        if (response.data && response.data.articles) {
            return response.data.articles.map(article => ({
                headline: article.title,
                source: article.source.name,
                published_at: article.publishedAt,
                url: article.url,
                description: article.description,
                tickers: [],
                category: 'macro',
                sentiment: 0,
                thumbnail: article.urlToImage
            }));
        }
    } catch (error) {
        if (error.response?.status === 401) {
            console.error('⚠️  NewsAPI authentication failed. Please set NEWSAPI_KEY environment variable.');
        } else {
            console.error('Error fetching NewsAPI data:', error.message);
        }
    }
    return [];
}

/**
 * Fetch news from Alpha Vantage News & Sentiment API (Free tier)
 * Get your free API key from https://www.alphavantage.co/support/#api-key
 */
async function fetchAlphaVantageNews(tickers = null) {
    const API_KEY = process.env.ALPHA_VANTAGE_KEY || 'demo';
    
    if (API_KEY === 'demo') {
        console.warn('⚠️  Alpha Vantage key not configured. Using demo data.');
        return [];
    }

    try {
        const params = {
            function: 'NEWS_SENTIMENT',
            apikey: API_KEY,
            limit: 50
        };

        if (tickers) {
            params.tickers = Array.isArray(tickers) ? tickers.join(',') : tickers;
        }

        const response = await axios.get('https://www.alphavantage.co/query', { params });

        if (response.data && response.data.feed) {
            return response.data.feed.map(item => {
                // Calculate average sentiment
                const sentimentScore = parseFloat(item.overall_sentiment_score) || 0;
                
                // Extract relevant tickers
                const relevantTickers = item.ticker_sentiment
                    ?.filter(t => parseFloat(t.relevance_score) > 0.3)
                    .map(t => t.ticker) || [];

                return {
                    headline: item.title,
                    source: item.source,
                    published_at: item.time_published,
                    url: item.url,
                    summary: item.summary,
                    tickers: relevantTickers,
                    category: relevantTickers.length > 0 ? 'company' : 'macro',
                    sentiment: sentimentScore, // -1 to +1
                    sentiment_label: item.overall_sentiment_label,
                    thumbnail: item.banner_image
                };
            });
        }
    } catch (error) {
        if (error.response?.status === 401) {
            console.error('⚠️  Alpha Vantage authentication failed. Please set ALPHA_VANTAGE_KEY environment variable.');
        } else {
            console.error('Error fetching Alpha Vantage news:', error.message);
        }
    }
    return [];
}

/**
 * Fetch news from Finnhub (Free tier)
 * Get your free API key from https://finnhub.io/
 */
async function fetchFinnhubNews(category = 'general') {
    const API_KEY = process.env.FINNHUB_KEY || 'demo';
    
    if (API_KEY === 'demo') {
        console.warn('⚠️  Finnhub key not configured. Using demo data.');
        return [];
    }

    try {
        const response = await axios.get('https://finnhub.io/api/v1/news', {
            params: {
                category: category, // general, forex, crypto, merger
                token: API_KEY
            }
        });

        if (response.data && Array.isArray(response.data)) {
            return response.data.map(item => ({
                headline: item.headline,
                source: item.source,
                published_at: new Date(item.datetime * 1000).toISOString(),
                url: item.url,
                summary: item.summary,
                tickers: item.related ? [item.related] : [],
                category: 'market',
                sentiment: 0,
                thumbnail: item.image
            }));
        }
    } catch (error) {
        if (error.response?.status === 401) {
            console.error('⚠️  Finnhub authentication failed. Please set FINNHUB_KEY environment variable.');
        } else {
            console.error('Error fetching Finnhub news:', error.message);
        }
    }
    return [];
}

/**
 * Calculate market impact weight
 */
function calculateMarketImpact(newsItem) {
    let impact = 1; // Default medium impact

    // High impact categories
    if (newsItem.category === 'macro' || newsItem.category === 'rates') {
        impact = 3;
    }

    // Earnings-related news
    if (newsItem.headline.toLowerCase().includes('earnings') || 
        newsItem.headline.toLowerCase().includes('revenue')) {
        impact = 3;
    }

    // Fed/interest rate news
    if (newsItem.headline.toLowerCase().includes('federal reserve') ||
        newsItem.headline.toLowerCase().includes('interest rate') ||
        newsItem.headline.toLowerCase().includes('inflation')) {
        impact = 4;
    }

    // War/geopolitical
    if (newsItem.headline.toLowerCase().includes('war') ||
        newsItem.headline.toLowerCase().includes('sanction') ||
        newsItem.headline.toLowerCase().includes('election')) {
        impact = 4;
    }

    // Analyst upgrades/downgrades
    if (newsItem.headline.toLowerCase().includes('upgrade') ||
        newsItem.headline.toLowerCase().includes('downgrade') ||
        newsItem.headline.toLowerCase().includes('rating')) {
        impact = 2;
    }

    return impact;
}

/**
 * Deduplicate news by headline similarity
 */
function deduplicateNews(newsArray) {
    const seen = new Map();
    
    return newsArray.filter(item => {
        // Create a simple key from headline
        const key = item.headline.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .slice(0, 5)
            .join(' ');
        
        if (seen.has(key)) {
            return false;
        }
        seen.set(key, true);
        return true;
    });
}

/**
 * Aggregate news from all sources with intelligent prioritization
 */
async function aggregateAllNews(tickers = null) {
    console.log('[News Aggregation] Fetching from multiple sources...');
    
    try {
        const fetchPromises = [];

        // Always fetch Yahoo market news (no API key needed)
        fetchPromises.push(fetchYahooMarketNews());

        // Fetch ticker-specific Yahoo news
        if (tickers && Array.isArray(tickers)) {
            // Get news for top 10 tickers to avoid overwhelming the API
            const topTickers = tickers.slice(0, 10);
            topTickers.forEach(ticker => {
                fetchPromises.push(fetchYahooNews(ticker));
            });
        } else {
            // If no tickers provided, fetch for popular stocks
            const popularStocks = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'TSLA', 'NVDA', 'META'];
            popularStocks.forEach(ticker => {
                fetchPromises.push(fetchYahooNews(ticker));
            });
        }

        // Fetch from paid APIs if configured
        fetchPromises.push(fetchAlphaVantageNews(tickers));
        fetchPromises.push(fetchFinnhubNews('general'));
        fetchPromises.push(fetchNewsAPIMarketNews());

        // Wait for all promises to settle (not fail if one fails)
        const results = await Promise.allSettled(fetchPromises);
        
        // Combine all successful results
        let allNews = results
            .filter(r => r.status === 'fulfilled')
            .flatMap(r => r.value || [])
            .filter(item => item && item.headline); // Remove null/undefined

        console.log(`[News Aggregation] Collected ${allNews.length} raw news items`);

        // Deduplicate
        allNews = deduplicateNews(allNews);
        console.log(`[News Aggregation] ${allNews.length} unique items after deduplication`);

        // Calculate market impact for each
        allNews = allNews.map(item => ({
            ...item,
            market_impact: calculateMarketImpact(item)
        }));

        // Intelligent sorting: High impact first, then by time
        allNews.sort((a, b) => {
            // First sort by impact
            if (a.market_impact !== b.market_impact) {
                return b.market_impact - a.market_impact;
            }
            // Then by time
            return new Date(b.published_at).getTime() - new Date(a.published_at).getTime();
        });

        // Limit to most relevant 100 news items to keep UI responsive
        allNews = allNews.slice(0, 100);

        console.log(`[News Aggregation] ✓ Returning ${allNews.length} prioritized news items`);
        
        return allNews;
    } catch (error) {
        console.error('[News Aggregation] Error:', error.message);
        return [];
    }
}

/**
 * Get aggregated news with caching
 */
async function getAggregatedNews(tickers = null, forceRefresh = false) {
    // Check cache first
    if (!forceRefresh) {
        const cache = readCache();
        if (isCacheValid(cache) && cache.news.length > 0) {
            console.log('[News Aggregation] Using cached data');
            return cache.news;
        }
    }

    // Fetch fresh data
    const news = await aggregateAllNews(tickers);
    
    // Cache it
    if (news.length > 0) {
        writeCache(news);
    }

    return news;
}

/**
 * Get news filtered by category
 */
async function getNewsByCategory(category) {
    const allNews = await getAggregatedNews();
    
    if (category === 'all') {
        return allNews;
    }

    return allNews.filter(item => item.category === category);
}

/**
 * Get news filtered by ticker
 */
async function getNewsByTicker(ticker) {
    const allNews = await getAggregatedNews([ticker]);
    
    return allNews.filter(item => 
        item.tickers && item.tickers.includes(ticker.toUpperCase())
    );
}

/**
 * Get high-impact market news only
 */
async function getHighImpactNews() {
    const allNews = await getAggregatedNews();
    
    return allNews.filter(item => item.market_impact >= 3);
}

module.exports = {
    getAggregatedNews,
    getNewsByCategory,
    getNewsByTicker,
    getHighImpactNews,
    fetchYahooNews,
    fetchYahooMarketNews,
    fetchAlphaVantageNews,
    fetchFinnhubNews,
    fetchNewsAPIMarketNews
};
