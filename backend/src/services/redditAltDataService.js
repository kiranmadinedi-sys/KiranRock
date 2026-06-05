/**
 * Reddit Alt Data Service — SONAR retail sentiment enhancement (PANTHEON)
 *
 * Tracks mention volume and sentiment for a ticker across wallstreetbets,
 * stocks and investing subreddits.  Gracefully disabled when Reddit OAuth
 * credentials are absent.
 *
 * Set in .env:
 *   REDDIT_CLIENT_ID=your_app_client_id
 *   REDDIT_SECRET=your_app_secret
 *   REDDIT_USER_AGENT=KiranRockBot/1.0 (optional)
 *
 * Register a free "script" app at https://www.reddit.com/prefs/apps
 */

const axios        = require('axios');
const cacheService = require('./cacheService');
const { logger }   = require('../utils/logger');

const REDDIT_CLIENT_ID  = process.env.REDDIT_CLIENT_ID  || '';
const REDDIT_SECRET     = process.env.REDDIT_SECRET     || '';
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'KiranRockBot/1.0';
const CACHE_TTL         = 15 * 60 * 1000; // 15 min — wsb moves fast

const SUBREDDITS = ['wallstreetbets', 'stocks', 'investing'];

const NEUTRAL_RESULT = { mentions: 0, sentimentScore: 0, scoreAdj: 0, source: 'disabled' };

if (!REDDIT_CLIENT_ID || !REDDIT_SECRET) {
    logger.warn('[Reddit] REDDIT_CLIENT_ID/REDDIT_SECRET not configured — Reddit alt data disabled');
}

// Cached OAuth token
let _token       = '';
let _tokenExpiry = 0;

async function fetchAccessToken() {
    if (_token && Date.now() < _tokenExpiry) return _token;

    const resp = await axios.post(
        'https://www.reddit.com/api/v1/access_token',
        'grant_type=client_credentials',
        {
            auth:    { username: REDDIT_CLIENT_ID, password: REDDIT_SECRET },
            headers: {
                'User-Agent':   REDDIT_USER_AGENT,
                'Content-Type': 'application/x-www-form-urlencoded'
            },
            timeout: 10000
        }
    );

    _token       = resp.data.access_token;
    _tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
    return _token;
}

/**
 * Get Reddit mention score for a symbol over the last 24 hours.
 *
 * @param {string} symbol
 * @returns {Promise<{mentions:number, sentimentScore:number, scoreAdj:number, source:string}|null>}
 *   scoreAdj: -6 to +6 for ORACLE use.  null on auth error.
 *   Returns NEUTRAL_RESULT when credentials not configured.
 */
async function getMentionScore(symbol) {
    if (!REDDIT_CLIENT_ID || !REDDIT_SECRET) return NEUTRAL_RESULT;

    const cacheKey = `reddit_mentions_${symbol}`;
    const cached   = cacheService.get(cacheKey);
    if (cached) return cached;

    try {
        const token   = await fetchAccessToken();
        const cutoff  = Math.floor((Date.now() - 86400000) / 1000); // 24h ago (unix)
        let totalMentions = 0;
        let totalScore    = 0;

        for (const sub of SUBREDDITS) {
            try {
                const resp = await axios.get(
                    `https://oauth.reddit.com/r/${sub}/search`,
                    {
                        params: { q: symbol, sort: 'new', limit: 25, t: 'day', restrict_sr: 1 },
                        headers: { Authorization: `Bearer ${token}`, 'User-Agent': REDDIT_USER_AGENT },
                        timeout: 8000
                    }
                );

                const posts = resp.data?.data?.children || [];
                for (const { data: p } of posts) {
                    if (p.created_utc < cutoff) continue;
                    totalMentions++;
                    // Normalize reddit post score to [-1, 1]; cap at 100 upvotes for scale
                    totalScore += Math.max(-1, Math.min(1, (p.score - 1) / 100));
                }
            } catch { /* one subreddit failing should not break others */ }

            // Rate-limit gap between subreddits (Reddit allows 60 req/min for OAuth)
            await new Promise(r => setTimeout(r, 600));
        }

        const avgSentiment = totalMentions > 0 ? totalScore / totalMentions : 0;  // -1 to 1

        // scoreAdj: scale by mention volume (more mentions = stronger signal), cap ±6
        const volumeFactor = Math.min(1, totalMentions / 10); // saturates at 10 mentions
        const scoreAdj     = Math.round(6 * volumeFactor * (avgSentiment > 0 ? 1 : avgSentiment < 0 ? -1 : 0));

        const result = {
            mentions:       totalMentions,
            sentimentScore: Number(avgSentiment.toFixed(3)),
            scoreAdj,
            source:         'reddit'
        };

        cacheService.set(cacheKey, result, CACHE_TTL);
        logger.info(`[Reddit] ${symbol}: mentions=${totalMentions} adj=${scoreAdj}`);
        return result;

    } catch (err) {
        logger.warn(`[Reddit] ${symbol} fetch failed: ${err.message}`);
        return null;
    }
}

module.exports = {
    getMentionScore,
    isEnabled: () => !!(REDDIT_CLIENT_ID && REDDIT_SECRET)
};
