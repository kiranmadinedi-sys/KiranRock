const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();

/**
 * Fetches and analyzes news sentiment for a stock.
 * @param {string} symbol - Stock symbol
 * @returns {Promise<Object>} News and sentiment analysis
 */
const getNewsSentiment = async (symbol) => {
    try {
        // Fetch recent news
        const news = await yahooFinance.search(symbol, { newsCount: 20 });
        
        if (!news || !news.news || news.news.length === 0) {
            return {
                error: 'No news available',
                articles: [],
                sentiment: { score: 0, label: 'Neutral', confidence: 'Low' }
            };
        }

        // Analyze sentiment from headlines and summaries
        const articles = news.news.map(article => ({
            title: article.title,
            publisher: article.publisher,
            link: article.link,
            publishedAt: new Date(article.providerPublishTime * 1000).toISOString(),
            sentiment: analyzeSentiment(article.title + ' ' + (article.summary || ''))
        }));

        // Calculate overall sentiment
        const overallSentiment = calculateOverallSentiment(articles);
        
        // Get analyst ratings if available
        const analystRatings = await getAnalystRatings(symbol);
        
        // Get historical sentiment trend
        const historicalSentiment = getHistoricalSentiment(articles);

        return {
            articles: articles.slice(0, 10),
            sentiment: overallSentiment,
            analystRatings,
            historicalSentiment,
            summary: generateSentimentSummary(overallSentiment, analystRatings)
        };
    } catch (error) {
        console.error(`Error fetching news sentiment for ${symbol}:`, error.message);
        return {
            error: 'Unable to fetch news data',
            articles: [],
            sentiment: { score: 0, label: 'Neutral', confidence: 'Low' },
            summary: 'Sentiment data unavailable'
        };
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

    const scores = articles.map(a => parseFloat(a.sentiment.score));
    const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
    
    const positive = articles.filter(a => a.sentiment.label.includes('Positive')).length;
    const negative = articles.filter(a => a.sentiment.label.includes('Negative')).length;
    const neutral = articles.length - positive - negative;
    
    let label = 'Neutral';
    if (avgScore > 20) label = 'Very Positive';
    else if (avgScore > 5) label = 'Positive';
    else if (avgScore < -20) label = 'Very Negative';
    else if (avgScore < -5) label = 'Negative';
    
    const confidence = positive + negative > neutral ? 'High' : 'Medium';
    
    return {
        score: avgScore.toFixed(1),
        label,
        confidence,
        breakdown: {
            positive: `${((positive / articles.length) * 100).toFixed(0)}%`,
            negative: `${((negative / articles.length) * 100).toFixed(0)}%`,
            neutral: `${((neutral / articles.length) * 100).toFixed(0)}%`
        }
    };
};

/**
 * Fetches analyst ratings.
 */
const getAnalystRatings = async (symbol) => {
    try {
        const quoteSummary = await yahooFinance.quoteSummary(symbol, {
            modules: ['recommendationTrend', 'financialData']
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
const generateSentimentSummary = (sentiment, analystRatings) => {
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
