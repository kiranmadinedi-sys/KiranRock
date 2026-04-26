const fs = require('fs');
const path = require('path');
const yfClient = require('../utils/yfClient');
const cacheService = require('./cacheService');
const { fetchAlphaVantageNews } = require('./newsAggregationService');
const { fetchXSymbolNews, isXConfigured } = require('./xNewsService');

const NEWS_SENTIMENT_CACHE_FILE = path.join(__dirname, '../storage/newsSentimentCache.json');
const NEWS_SENTIMENT_CACHE_MS = Math.max(5 * 60 * 1000, parseInt(process.env.NEWS_SENTIMENT_CACHE_MS || `${30 * 60 * 1000}`, 10));
const NEWS_SENTIMENT_STALE_MS = Math.max(NEWS_SENTIMENT_CACHE_MS, parseInt(process.env.NEWS_SENTIMENT_STALE_MS || `${6 * 60 * 60 * 1000}`, 10));
const NEWS_SENTIMENT_MAX_ARTICLES = Math.max(6, Math.min(20, parseInt(process.env.NEWS_SENTIMENT_MAX_ARTICLES || '12', 10)));

function readPersistedCache() {
    try {
        if (fs.existsSync(NEWS_SENTIMENT_CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(NEWS_SENTIMENT_CACHE_FILE, 'utf8'));
        }
    } catch (error) {
        console.error('Error reading news sentiment cache:', error.message);
    }
    return {};
}

function writePersistedCache(data) {
    try {
        fs.writeFileSync(NEWS_SENTIMENT_CACHE_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error('Error writing news sentiment cache:', error.message);
    }
}

function getPersistedCacheEntry(symbol) {
    const cache = readPersistedCache();
    return cache[symbol] || null;
}

function setPersistedCacheEntry(symbol, payload) {
    const cache = readPersistedCache();
    cache[symbol] = {
        updatedAt: Date.now(),
        payload
    };
    writePersistedCache(cache);
}

function normalizeYahooArticles(symbol, news) {
    const items = news?.news || [];
    return items.map(article => ({
        symbol,
        title: article.title,
        summary: article.summary || '',
        publisher: article.publisher || 'Yahoo Finance',
        source: 'Yahoo Finance',
        sourceType: 'news',
        link: article.link,
        publishedAt: article.providerPublishTime
            ? new Date(article.providerPublishTime * 1000).toISOString()
            : new Date().toISOString(),
        weight: 1.0
    }));
}

function normalizeAlphaVantageArticles(symbol, items = []) {
    return items.map(article => ({
        symbol,
        title: article.headline,
        summary: article.summary || '',
        publisher: article.source || 'Alpha Vantage',
        source: article.source || 'Alpha Vantage',
        sourceType: 'news',
        link: article.url,
        publishedAt: article.published_at || new Date().toISOString(),
        weight: 1.15,
        providedSentiment: typeof article.sentiment === 'number' ? article.sentiment : null
    }));
}

function normalizeXArticles(symbol, items = []) {
    return items.map(article => ({
        symbol,
        title: article.headline || article.summary || 'X post',
        summary: article.summary || article.headline || '',
        publisher: article.publisher || 'X',
        source: 'X',
        sourceType: 'social',
        link: article.url || article.link,
        publishedAt: article.publishedAt || article.published_at || new Date().toISOString(),
        engagement: article.engagement || 0,
        weight: 0.65
    }));
}

function deduplicateArticles(articles) {
    const seen = new Set();
    return articles.filter(article => {
        const key = `${article.link || ''}|${String(article.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').slice(0, 120)}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
}

function getArticleWeight(article) {
    let weight = article.weight || 1;
    const publishedAtMs = article.publishedAt ? new Date(article.publishedAt).getTime() : Date.now();
    const ageHours = Number.isFinite(publishedAtMs) ? (Date.now() - publishedAtMs) / (1000 * 60 * 60) : 0;

    if (ageHours <= 6) weight *= 1.15;
    else if (ageHours <= 24) weight *= 1.05;
    else if (ageHours > 72) weight *= 0.85;

    if (article.sourceType === 'social' && article.engagement) {
        weight *= Math.min(1.35, 0.85 + Math.log10(article.engagement + 1) * 0.15);
    }

    return Math.max(0.35, Math.min(1.5, weight));
}

function buildNeutralResult(message, meta = {}) {
    return {
        error: message,
        articles: [],
        sentiment: { score: 0, label: 'Neutral', confidence: 'Low', breakdown: {} },
        summary: 'Sentiment data unavailable',
        meta
    };
}

/**
 * Fetches and analyzes news sentiment for a stock.
 * @param {string} symbol - Stock symbol
 * @returns {Promise<Object>} News and sentiment analysis
 */
const getNewsSentiment = async (symbol) => {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    const cacheKey = `news_sentiment_${normalizedSymbol}`;
    const inMemory = cacheService.get(cacheKey);
    if (inMemory) {
        return {
            ...inMemory,
            meta: {
                ...(inMemory.meta || {}),
                cache: 'memory',
                stale: false
            }
        };
    }

    const persisted = getPersistedCacheEntry(normalizedSymbol);
    const persistedAge = persisted ? Date.now() - persisted.updatedAt : Number.POSITIVE_INFINITY;

    if (persisted && persistedAge <= NEWS_SENTIMENT_CACHE_MS) {
        cacheService.set(cacheKey, persisted.payload, NEWS_SENTIMENT_CACHE_MS);
        return {
            ...persisted.payload,
            meta: {
                ...(persisted.payload.meta || {}),
                cache: 'disk',
                stale: false
            }
        };
    }

    try {
        const [news, alphaVantageNews, xNews] = await Promise.all([
            yfClient.search(normalizedSymbol, { newsCount: 10 }).catch(() => null),
            fetchAlphaVantageNews(normalizedSymbol).catch(() => []),
            isXConfigured() ? fetchXSymbolNews(normalizedSymbol, { maxResults: 8 }).catch(() => []) : Promise.resolve([])
        ]);

        let articles = deduplicateArticles([
            ...normalizeYahooArticles(normalizedSymbol, news),
            ...normalizeAlphaVantageArticles(normalizedSymbol, alphaVantageNews),
            ...normalizeXArticles(normalizedSymbol, xNews)
        ]).map(article => ({
            ...article,
            weight: getArticleWeight(article),
            sentiment: analyzeSentiment(`${article.title || ''} ${article.summary || ''}`)
        }));

        articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
        articles = articles.slice(0, NEWS_SENTIMENT_MAX_ARTICLES);

        if (articles.length === 0) {
            if (persisted && persistedAge <= NEWS_SENTIMENT_STALE_MS) {
                return {
                    ...persisted.payload,
                    meta: {
                        ...(persisted.payload.meta || {}),
                        cache: 'stale-disk',
                        stale: true,
                        staleReason: 'No fresh news available'
                    }
                };
            }

            return buildNeutralResult('No news available', {
                symbol: normalizedSymbol,
                xEnabled: isXConfigured(),
                cache: 'miss',
                stale: false
            });
        }

        // Calculate overall sentiment
        const overallSentiment = calculateOverallSentiment(articles);
        
        // Get analyst ratings if available
        const analystRatings = await getAnalystRatings(normalizedSymbol);
        
        // Get historical sentiment trend
        const historicalSentiment = getHistoricalSentiment(articles);

        const sourceBreakdown = articles.reduce((acc, article) => {
            const key = article.source || 'Unknown';
            acc[key] = (acc[key] || 0) + 1;
            return acc;
        }, {});

        const xPostCount = articles.filter(article => article.sourceType === 'social').length;

        const result = {
            articles: articles.slice(0, 10),
            sentiment: overallSentiment,
            analystRatings,
            historicalSentiment,
            summary: generateSentimentSummary(overallSentiment, analystRatings, { xPostCount, sourceBreakdown }),
            meta: {
                symbol: normalizedSymbol,
                articleCount: articles.length,
                sourceBreakdown,
                xEnabled: isXConfigured(),
                xPostCount,
                cache: 'fresh',
                stale: false,
                refreshedAt: new Date().toISOString()
            }
        };

        cacheService.set(cacheKey, result, NEWS_SENTIMENT_CACHE_MS);
        setPersistedCacheEntry(normalizedSymbol, result);

        return result;
    } catch (error) {
        console.error(`Error fetching news sentiment for ${symbol}:`, error.message);

        if (persisted && persistedAge <= NEWS_SENTIMENT_STALE_MS) {
            return {
                ...persisted.payload,
                meta: {
                    ...(persisted.payload.meta || {}),
                    cache: 'stale-disk',
                    stale: true,
                    staleReason: error.message
                }
            };
        }

        return buildNeutralResult('Unable to fetch news data', {
            symbol: normalizedSymbol,
            xEnabled: isXConfigured(),
            cache: 'error',
            stale: false
        });
    }
};

/**
 * Analyzes sentiment of text using advanced NLP-based scoring.
 * Implements weighted keyword matching with context awareness.
 */
const analyzeSentiment = (text) => {
    const lowerText = text.toLowerCase();
    
    // Strong positive indicators (weight: 3)
    const strongPositive = [
        'surge', 'soar', 'skyrocket', 'breakout', 'record high', 'stellar',
        'exceptional', 'breakthrough', 'revolutionize', 'dominate', 'outperform'
    ];
    
    // Moderate positive indicators (weight: 2)
    const moderatePositive = [
        'rally', 'gain', 'rise', 'jump', 'climb', 'bullish', 'upgrade',
        'beat', 'exceed', 'growth', 'profit', 'strong', 'positive',
        'optimistic', 'success', 'win', 'boost', 'expansion', 'buy'
    ];
    
    // Mild positive indicators (weight: 1)
    const mildPositive = [
        'improve', 'increase', 'advance', 'recover', 'momentum', 'potential',
        'opportunity', 'favorable', 'promising', 'upside'
    ];
    
    // Strong negative indicators (weight: -3)
    const strongNegative = [
        'plunge', 'crash', 'collapse', 'devastate', 'disaster', 'crisis',
        'bankruptcy', 'fraud', 'scandal', 'terminate', 'shutdown'
    ];
    
    // Moderate negative indicators (weight: -2)
    const moderateNegative = [
        'fall', 'drop', 'decline', 'sink', 'bearish', 'downgrade',
        'miss', 'loss', 'weak', 'negative', 'concern', 'warning',
        'risk', 'trouble', 'layoff', 'cut', 'sell', 'underperform'
    ];
    
    // Mild negative indicators (weight: -1)
    const mildNegative = [
        'slow', 'decrease', 'caution', 'challenge', 'uncertainty', 'pressure',
        'struggle', 'difficulty', 'slip', 'ease'
    ];
    
    // Context modifiers
    const intensifiers = ['very', 'extremely', 'significantly', 'substantially', 'dramatically'];
    const diminishers = ['slightly', 'marginally', 'somewhat', 'barely', 'moderately'];
    const negators = ['not', 'no', 'never', 'without', 'lack'];
    
    let weightedScore = 0;
    let totalWeight = 0;
    let positiveCount = 0;
    let negativeCount = 0;
    
    // Helper function to check with context
    const checkKeywords = (keywords, weight) => {
        keywords.forEach(keyword => {
            const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
            const matches = lowerText.match(regex);
            if (matches) {
                matches.forEach(() => {
                    let adjustedWeight = weight;
                    
                    // Check for intensifiers nearby
                    intensifiers.forEach(intensifier => {
                        if (lowerText.includes(intensifier + ' ' + keyword)) {
                            adjustedWeight *= 1.5;
                        }
                    });
                    
                    // Check for diminishers nearby
                    diminishers.forEach(diminisher => {
                        if (lowerText.includes(diminisher + ' ' + keyword)) {
                            adjustedWeight *= 0.5;
                        }
                    });
                    
                    // Check for negators (flip sentiment)
                    negators.forEach(negator => {
                        if (lowerText.includes(negator + ' ' + keyword)) {
                            adjustedWeight *= -1;
                        }
                    });
                    
                    weightedScore += adjustedWeight;
                    totalWeight += Math.abs(weight);
                    
                    if (adjustedWeight > 0) positiveCount++;
                    else if (adjustedWeight < 0) negativeCount++;
                });
            }
        });
    };
    
    // Calculate weighted scores
    checkKeywords(strongPositive, 3);
    checkKeywords(moderatePositive, 2);
    checkKeywords(mildPositive, 1);
    checkKeywords(strongNegative, -3);
    checkKeywords(moderateNegative, -2);
    checkKeywords(mildNegative, -1);
    
    // Normalize score to -100 to +100 range
    const normalizedScore = totalWeight > 0 
        ? (weightedScore / totalWeight) * 100 
        : 0;
    
    // Determine confidence based on total matches
    let confidence = 'Low';
    if (totalWeight >= 6) confidence = 'High';
    else if (totalWeight >= 3) confidence = 'Medium';
    
    // Determine label
    let label = 'Neutral';
    if (normalizedScore > 50) label = 'Very Positive';
    else if (normalizedScore > 20) label = 'Positive';
    else if (normalizedScore > 5) label = 'Slightly Positive';
    else if (normalizedScore < -50) label = 'Very Negative';
    else if (normalizedScore < -20) label = 'Negative';
    else if (normalizedScore < -5) label = 'Slightly Negative';
    
    return {
        score: normalizedScore.toFixed(1),
        label,
        positiveCount,
        negativeCount
    };
};

/**
 * Calculates overall sentiment from multiple articles.
 */
const calculateOverallSentiment = (articles) => {
    if (articles.length === 0) {
        return { score: 0, label: 'Neutral', confidence: 'Low', breakdown: {} };
    }

    const weightedTotal = articles.reduce((sum, article) => {
        const score = parseFloat(article.sentiment.score) || 0;
        const weight = article.weight || 1;
        return sum + (score * weight);
    }, 0);
    const totalWeight = articles.reduce((sum, article) => sum + (article.weight || 1), 0) || 1;
    const avgScore = weightedTotal / totalWeight;
    
    const positive = articles.filter(a => a.sentiment.label.includes('Positive')).length;
    const negative = articles.filter(a => a.sentiment.label.includes('Negative')).length;
    const neutral = articles.length - positive - negative;
    const uniqueSources = new Set(articles.map(article => article.source || 'Unknown')).size;
    
    let label = 'Neutral';
    if (avgScore > 20) label = 'Very Positive';
    else if (avgScore > 5) label = 'Positive';
    else if (avgScore < -20) label = 'Very Negative';
    else if (avgScore < -5) label = 'Negative';
    
    let confidence = 'Low';
    if (Math.abs(avgScore) >= 20 || totalWeight >= 8 || uniqueSources >= 3) confidence = 'High';
    else if (positive + negative >= Math.max(2, neutral)) confidence = 'Medium';
    
    return {
        score: avgScore.toFixed(1),
        label,
        confidence,
        breakdown: {
            positive: `${((positive / articles.length) * 100).toFixed(0)}%`,
            negative: `${((negative / articles.length) * 100).toFixed(0)}%`,
            neutral: `${((neutral / articles.length) * 100).toFixed(0)}%`
        },
        sourceCount: uniqueSources
    };
};

/**
 * Fetches analyst ratings.
 */
const getAnalystRatings = async (symbol) => {
    try {
        const quoteSummary = await yfClient.quoteSummary(symbol, {
            modules: ['recommendationTrend', 'financialData'],
            ttl: 60 * 60 * 1000
        });

        const recommendation = quoteSummary.financialData?.recommendationKey;
        const trend = quoteSummary.recommendationTrend?.trend?.[0];
        
        if (!recommendation && !trend) {
            return null;
        }

        return {
            currentRating: recommendation ? recommendation.toUpperCase() : 'N/A',
            strongBuy: trend?.strongBuy || 0,
            buy: trend?.buy || 0,
            hold: trend?.hold || 0,
            sell: trend?.sell || 0,
            strongSell: trend?.strongSell || 0,
            consensus: deriveConsensus(trend)
        };
    } catch (error) {
        console.error('Error fetching analyst ratings:', error.message);
        return null;
    }
};

/**
 * Derives consensus from analyst ratings.
 */
const deriveConsensus = (trend) => {
    if (!trend) return 'N/A';
    
    const total = (trend.strongBuy || 0) + (trend.buy || 0) + (trend.hold || 0) + 
                  (trend.sell || 0) + (trend.strongSell || 0);
    
    if (total === 0) return 'N/A';
    
    const buyRatio = ((trend.strongBuy || 0) + (trend.buy || 0)) / total;
    const sellRatio = ((trend.strongSell || 0) + (trend.sell || 0)) / total;
    
    if (buyRatio > 0.6) return 'Strong Buy';
    if (buyRatio > 0.4) return 'Buy';
    if (sellRatio > 0.4) return 'Sell';
    return 'Hold';
};

/**
 * Generates sentiment summary with AI-based insights.
 */
const generateSentimentSummary = (sentiment, analystRatings, meta = {}) => {
    const sentimentText = sentiment.label;
    const analystText = analystRatings?.consensus || 'No analyst data';
    
    let summary = `📊 News sentiment is ${sentimentText.toLowerCase()} with ${sentiment.confidence.toLowerCase()} confidence. `;
    
    // Add sentiment interpretation
    if (parseFloat(sentiment.score) > 20) {
        summary += '🚀 Strong positive media coverage suggests bullish market perception. ';
    } else if (parseFloat(sentiment.score) > 5) {
        summary += '📈 Positive news flow indicates favorable market sentiment. ';
    } else if (parseFloat(sentiment.score) < -20) {
        summary += '⚠️ Negative media coverage may indicate market concerns. ';
    } else if (parseFloat(sentiment.score) < -5) {
        summary += '📉 Cautious sentiment in recent news coverage. ';
    }
    
    if (analystRatings) {
        summary += `\n\n👥 Analysts consensus: ${analystText}. `;
        
        const totalAnalysts = analystRatings.strongBuy + analystRatings.buy + 
                             analystRatings.hold + analystRatings.sell + analystRatings.strongSell;
        
        if (totalAnalysts > 0) {
            const buyPercent = ((analystRatings.strongBuy + analystRatings.buy) / totalAnalysts * 100).toFixed(0);
            summary += `${buyPercent}% recommend buy (${totalAnalysts} analysts).`;
        }
    }

    if (meta.xPostCount) {
        summary += `\n\n📣 Social signal: ${meta.xPostCount} recent X posts were blended into the score with reduced weight.`;
    }

    if (meta.sourceBreakdown) {
        const sourceSummary = Object.entries(meta.sourceBreakdown)
            .map(([source, count]) => `${source}: ${count}`)
            .slice(0, 4)
            .join(', ');
        if (sourceSummary) {
            summary += `\n\n🗞️ Sources used: ${sourceSummary}.`;
        }
    }
    
    return summary;
};

/**
 * Gets historical sentiment trend from recent articles.
 */
const getHistoricalSentiment = (articles) => {
    if (articles.length === 0) return [];
    
    // Group articles by day
    const sentimentByDay = {};
    
    articles.forEach(article => {
        const date = new Date(article.publishedAt);
        const dayKey = date.toISOString().split('T')[0]; // YYYY-MM-DD
        
        if (!sentimentByDay[dayKey]) {
            sentimentByDay[dayKey] = {
                date: dayKey,
                scores: [],
                count: 0
            };
        }
        
        sentimentByDay[dayKey].scores.push(parseFloat(article.sentiment.score));
        sentimentByDay[dayKey].count++;
    });
    
    // Calculate average sentiment per day
    const historicalData = Object.values(sentimentByDay).map(day => ({
        date: day.date,
        sentiment: (day.scores.reduce((a, b) => a + b, 0) / day.scores.length).toFixed(1),
        articleCount: day.count
    }));
    
    // Sort by date
    historicalData.sort((a, b) => new Date(a.date) - new Date(b.date));
    
    return historicalData;
};

module.exports = {
    getNewsSentiment,
    getHistoricalSentiment
};
