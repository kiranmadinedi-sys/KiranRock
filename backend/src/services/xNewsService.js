const axios = require('axios');

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '';
const X_NEWS_ENABLED = (process.env.X_NEWS_ENABLED || 'true').toLowerCase() === 'true';
const X_MAX_RESULTS = Math.max(5, Math.min(25, parseInt(process.env.X_NEWS_MAX_RESULTS || '10', 10)));
const X_TIMEOUT_MS = Math.max(2000, parseInt(process.env.X_NEWS_TIMEOUT_MS || '4500', 10));
const X_API_ENDPOINTS = [
    'https://api.x.com/2/tweets/search/recent',
    'https://api.twitter.com/2/tweets/search/recent'
];

function isXConfigured() {
    return X_NEWS_ENABLED && !!X_BEARER_TOKEN;
}

function buildSymbolQuery(symbol) {
    const upper = String(symbol || '').trim().toUpperCase();
    return `("$${upper}" OR "${upper} stock" OR "${upper} earnings" OR "${upper} guidance") lang:en -is:retweet -is:reply`;
}

function buildMarketQuery() {
    return '("stock market" OR "S&P 500" OR Nasdaq OR Dow OR "Federal Reserve") lang:en -is:retweet';
}

function formatXUrl(username, tweetId) {
    if (username) {
        return `https://x.com/${username}/status/${tweetId}`;
    }
    return `https://x.com/i/web/status/${tweetId}`;
}

function normalizeTweet(tweet, usersById) {
    const user = usersById.get(tweet.author_id) || {};
    const text = String(tweet.text || '').replace(/\s+/g, ' ').trim();
    const displayTitle = text.length > 160 ? `${text.slice(0, 157)}...` : text;
    const metrics = tweet.public_metrics || {};
    const engagement = (metrics.like_count || 0) + (metrics.retweet_count || 0) + (metrics.reply_count || 0) + (metrics.quote_count || 0);

    return {
        id: tweet.id,
        headline: displayTitle,
        summary: text,
        source: 'X',
        sourceType: 'social',
        publisher: user.name && user.username ? `${user.name} (@${user.username})` : 'X',
        published_at: tweet.created_at || new Date().toISOString(),
        publishedAt: tweet.created_at || new Date().toISOString(),
        url: formatXUrl(user.username, tweet.id),
        link: formatXUrl(user.username, tweet.id),
        thumbnail: null,
        author: user.name || null,
        username: user.username || null,
        verified: !!user.verified,
        engagement,
        public_metrics: metrics
    };
}

async function searchXPosts(query, options = {}) {
    if (!isXConfigured()) {
        return [];
    }

    const maxResults = Math.max(5, Math.min(25, options.maxResults || X_MAX_RESULTS));
    const params = {
        query,
        max_results: maxResults,
        expansions: 'author_id',
        'tweet.fields': 'created_at,lang,public_metrics',
        'user.fields': 'name,username,verified'
    };

    let lastError = null;

    for (const endpoint of X_API_ENDPOINTS) {
        try {
            const response = await axios.get(endpoint, {
                params,
                timeout: X_TIMEOUT_MS,
                headers: {
                    Authorization: `Bearer ${X_BEARER_TOKEN}`,
                    'User-Agent': 'KiranRock-NewsBot/1.0'
                }
            });

            const tweets = response.data?.data || [];
            const users = response.data?.includes?.users || [];
            const usersById = new Map(users.map(user => [user.id, user]));

            return tweets.map(tweet => normalizeTweet(tweet, usersById));
        } catch (error) {
            lastError = error;
            const status = error.response?.status;
            if (status === 404 || status === 410) {
                continue;
            }
            if (status === 401 || status === 403) {
                break;
            }
        }
    }

    if (lastError) {
        const status = lastError.response?.status;
        const message = lastError.response?.data?.title || lastError.message;
        console.warn(`[X News] Search failed${status ? ` (${status})` : ''}: ${message}`);
    }

    return [];
}

async function fetchXSymbolNews(symbol, options = {}) {
    const items = await searchXPosts(buildSymbolQuery(symbol), options);
    return items.map(item => ({
        ...item,
        tickers: [String(symbol || '').toUpperCase()],
        category: 'company',
        sentiment: 0
    }));
}

async function fetchXMarketNews(options = {}) {
    const items = await searchXPosts(buildMarketQuery(), options);
    return items.map(item => ({
        ...item,
        tickers: [],
        category: 'macro',
        sentiment: 0
    }));
}

module.exports = {
    isXConfigured,
    fetchXSymbolNews,
    fetchXMarketNews
};