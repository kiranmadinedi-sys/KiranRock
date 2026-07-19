const axios = require('axios');

const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN || process.env.TWITTER_BEARER_TOKEN || '';
const X_NEWS_ENABLED = (process.env.X_NEWS_ENABLED || 'true').toLowerCase() === 'true';
const X_MAX_RESULTS = Math.max(5, Math.min(25, parseInt(process.env.X_NEWS_MAX_RESULTS || '10', 10)));
const X_TIMEOUT_MS = Math.max(2000, parseInt(process.env.X_NEWS_TIMEOUT_MS || '4500', 10));
// Free tier: 1 search per 15 min per app. Basic tier: 60/15min. Adjust via X_RATE_LIMIT_MS.
const X_RATE_LIMIT_MS = parseInt(process.env.X_RATE_LIMIT_MS || '900000', 10);
const X_API_ENDPOINTS = [
    'https://api.x.com/2/tweets/search/recent',
    'https://api.twitter.com/2/tweets/search/recent'
];

// In-process rate-limit state — reset on restart (safe: just means one extra attempt)
let _rateLimitedUntil = 0;

function isXConfigured() {
    return X_NEWS_ENABLED && !!X_BEARER_TOKEN;
}

function isRateLimited() {
    return Date.now() < _rateLimitedUntil;
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
    if (!isXConfigured()) return [];

    if (isRateLimited()) {
        const waitSec = Math.ceil((_rateLimitedUntil - Date.now()) / 1000);
        console.log(`[X News] Rate-limited — skipping (retry in ${waitSec}s)`);
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

            // Successful call — reset rate limit state
            _rateLimitedUntil = 0;

            const tweets = response.data?.data || [];
            const users = response.data?.includes?.users || [];
            const usersById = new Map(users.map(user => [user.id, user]));
            return tweets.map(tweet => normalizeTweet(tweet, usersById));

        } catch (error) {
            lastError = error;
            const status = error.response?.status;

            if (status === 429) {
                // Respect Retry-After header if present, else use configured window
                const retryAfter = parseInt(error.response?.headers?.['retry-after'] || '0', 10);
                const cooldown = retryAfter > 0 ? retryAfter * 1000 : X_RATE_LIMIT_MS;
                _rateLimitedUntil = Date.now() + cooldown;
                console.warn(`[X News] Rate limited (429) — pausing for ${Math.round(cooldown / 60000)} min`);
                break;
            }
            if (status === 401 || status === 403) {
                console.warn(`[X News] Auth error (${status}) — check X_BEARER_TOKEN`);
                break;
            }
            if (status === 402) {
                // Payment Required — the token's current plan doesn't include this
                // endpoint at all (X's free tier doesn't cover search/recent). Unlike
                // 429 this will never clear on its own, so without a cooldown every
                // future call retries and fails the same way forever. Long cooldown
                // (1hr) so it stops hammering an endpoint that needs a plan upgrade,
                // while still noticing automatically if the plan changes later.
                _rateLimitedUntil = Date.now() + 60 * 60 * 1000;
                console.warn('[X News] Payment required (402) — current plan does not include this endpoint. Pausing 1hr. Upgrade the X API plan or set X_NEWS_ENABLED=false.');
                break;
            }
            if (status === 404 || status === 410) {
                continue; // Try next endpoint
            }
        }
    }

    if (lastError && lastError.response?.status !== 429) {
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