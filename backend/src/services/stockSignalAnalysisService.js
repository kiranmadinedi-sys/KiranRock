const { query } = require('../config/database');
const swingTradingService = require('./swingTradingService');
const watchlistService = require('./watchlistService');
const { getMultiTimeframeAnalysis } = require('./enhancedSignalService');

const DEFAULT_SYMBOLS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'NVDA'];
const MAX_TRACKED_SYMBOLS = 6;

function uniqueSymbols(symbols) {
    return [...new Set((symbols || []).filter(Boolean).map((symbol) => String(symbol).toUpperCase()))];
}

function parseConfidence(value) {
    const parsed = Number.parseFloat(String(value || '0'));
    return Number.isFinite(parsed) ? parsed : 0;
}

function buildQualityProfile({ overallSignal, alignmentStrength, cupConfidence, dailyConfidence }) {
    const signalBoost = overallSignal === 'STRONG BUY' ? 12 : overallSignal === 'BUY' ? 8 : 0;
    const qualityScore = Math.min(
        100,
        Math.round((alignmentStrength * 0.45) + (cupConfidence * 0.35) + (dailyConfidence * 0.20) + signalBoost)
    );

    let qualityTier = 'Low';
    if (qualityScore >= 85) {
        qualityTier = 'Confirmed';
    } else if (qualityScore >= 75) {
        qualityTier = 'High';
    } else if (qualityScore >= 65) {
        qualityTier = 'Medium';
    }

    return { qualityScore, qualityTier };
}

async function getTrackedSymbols(userId) {
    const watchlistSymbols = watchlistService.getUserWatchlist(userId) || [];
    let alertSymbols = [];

    try {
        const result = await query(`
            SELECT DISTINCT symbol
            FROM alerts
            WHERE user_id = $1
            ORDER BY symbol ASC
            LIMIT 10
        `, [userId]);
        alertSymbols = result.rows.map((row) => row.symbol);
    } catch (error) {
        console.warn('[Stock Signal Analysis] Unable to load alert symbols:', error.message);
    }

    return uniqueSymbols([...watchlistSymbols, ...alertSymbols, ...DEFAULT_SYMBOLS]).slice(0, MAX_TRACKED_SYMBOLS);
}

async function buildSwingFeedItem(symbol) {
    try {
        const [swingAnalysis, mtfAnalysis] = await Promise.all([
            swingTradingService.getSwingTradingAnalysis(symbol),
            getMultiTimeframeAnalysis(symbol)
        ]);

        const overallSignal = swingAnalysis?.overallSignal || 'NEUTRAL';
        const alignmentStrength = Number(mtfAnalysis?.alignmentStrength || 0);
        const shouldShow = ['BUY', 'STRONG BUY', 'WATCH'].includes(overallSignal) || alignmentStrength >= 70;

        if (!shouldShow) {
            return null;
        }

        const cupConfidence = Number(swingAnalysis?.cupAndHandleAnalysis?.confidence || 0);
        const dailyConfidence = parseConfidence(mtfAnalysis?.timeframes?.['1d']?.confidence);
        const { qualityScore, qualityTier } = buildQualityProfile({
            overallSignal,
            alignmentStrength,
            cupConfidence,
            dailyConfidence
        });
        const priorityScore = Math.max(alignmentStrength, cupConfidence, overallSignal === 'STRONG BUY' ? 84 : 68);
        const isActionableBuy = ['BUY', 'STRONG BUY'].includes(overallSignal)
            && (alignmentStrength >= 70 || cupConfidence >= 60)
            && qualityScore >= 75;
        const reasons = Array.isArray(swingAnalysis?.reasons) ? swingAnalysis.reasons.filter(Boolean) : [];
        const distance = swingAnalysis?.emaAnalysis?.distance || swingAnalysis?.cupAndHandleAnalysis?.patternDetails?.distanceFromBreakout;
        const summaryParts = [];

        if (reasons.length > 0) {
            summaryParts.push(reasons[0]);
        }

        if (mtfAnalysis?.alignment && mtfAnalysis.alignment !== 'MIXED') {
            summaryParts.push(`Multi-timeframe ${mtfAnalysis.alignment.toLowerCase()}`);
        }

        if (distance && distance !== 'N/A') {
            summaryParts.push(`Price distance ${distance}`);
        }

        const alignment = mtfAnalysis?.alignment || 'MIXED';
        const dismissalKey = `${symbol}:${overallSignal}:${alignment}`;

        return {
            id: `swing:${dismissalKey}`,
            type: 'swing',
            symbol,
            title: overallSignal === 'STRONG BUY'
                ? `${symbol} swing setup is aligning across signals`
                : overallSignal === 'BUY'
                    ? `${symbol} is showing a fresh swing entry setup`
                    : `${symbol} is forming a swing watch setup`,
            summary: summaryParts.join(' | ') || 'Swing pattern and momentum conditions are worth monitoring.',
            link: null,
            sourceLabel: 'Swing setup',
            signal: overallSignal,
            severity: null,
            impact: null,
            sentimentImpact: null,
            sentimentScore: dailyConfidence,
            priorityScore,
            popupEligible: isActionableBuy && (priorityScore >= 75 || overallSignal === 'STRONG BUY'),
            read: false,
            createdAt: swingAnalysis?.timestamp || new Date().toISOString(),
            dismissalKey,
            recommendation: isActionableBuy ? 'BUY' : 'WATCH',
            meta: {
                alignment,
                alignmentStrength,
                dailyConfidence,
                holdingPeriod: swingAnalysis?.recommendedHoldingPeriod || '2-4 weeks',
                strategy: swingAnalysis?.strategy || 'Swing Trading',
                currentPrice: swingAnalysis?.emaAnalysis?.currentPrice || null,
                ema9: swingAnalysis?.emaAnalysis?.ema9 || null,
                distanceFromEma: swingAnalysis?.emaAnalysis?.distance || null,
                breakoutPrice: swingAnalysis?.cupAndHandleAnalysis?.patternDetails?.breakoutPrice || null,
                reasons,
                actionable: isActionableBuy,
                cupConfidence,
                qualityScore,
                qualityTier
            }
        };
    } catch (error) {
        console.warn(`[Stock Signal Analysis] Swing analysis skipped for ${symbol}:`, error.message);
        return null;
    }
}

module.exports = {
    buildSwingFeedItem,
    getTrackedSymbols
};