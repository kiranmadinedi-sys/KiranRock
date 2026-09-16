// normalizeArticle/analyzeNewsImpact are pure functions with no dependency
// of their own on any of these — mocked purely so requiring
// newsMonitoringService.js (and transitively newsSentimentService.js, whose
// REAL analyzeSentiment is what's actually under test here) never touches a
// real cache file, HTTP call, or DB connection.
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/newsAggregationService', () => ({
    getAggregatedNews: jest.fn(),
    fetchAlphaVantageNews: jest.fn(),
}));
jest.mock('../src/services/stockSignalAnalysisService', () => ({ getTrackedSymbols: jest.fn() }));
jest.mock('../src/services/xNewsService', () => ({ isXConfigured: jest.fn(() => false), fetchXSymbolNews: jest.fn() }));
jest.mock('../src/services/polygonNewsService', () => ({ fetchPolygonNews: jest.fn() }));
jest.mock('../src/services/cacheService', () => ({
    get: jest.fn(), set: jest.fn(), has: jest.fn(() => false),
}));

const { normalizeArticle, analyzeNewsImpact } = require('../src/services/newsMonitoringService');

/**
 * Added 2026-09-16. Audited the news_alerts table and found ALL 8,731 rows
 * had sentiment_score: 0.0000 / "Neutral", exactly, including headlines that
 * plainly weren't neutral. Root cause: normalizeArticle() only ever read a
 * native `article.sentiment` field (Alpha Vantage-shaped), silently
 * defaulting to 0 for every other source — which is nearly all of them
 * (Motley Fool, Yahoo, MarketBeat, 24/7 Wall St, ...) — made worse by
 * Alpha Vantage's own news fetch itself failing (DNS error, found
 * 2026-09-13), so the one source this ever worked for wasn't reachable
 * either. Live trading was never affected — enhancedAITradingBot.js's
 * scoring uses a separate, already-working sentiment computation
 * (newsSentimentService.getNewsSentiment) — this bug was confined to the
 * news_alerts table / notification-feed display.
 *
 * Second, related bug in the same investigation: analyzeNewsImpact's
 * sentimentImpact classification compared the score against 0.3/0.6
 * thresholds as if it were on a -1..+1 scale, when it's actually -100..+100
 * — so any genuine non-zero score always breached those tiny thresholds,
 * collapsing every real signal into "Very Positive"/"Very Negative" with no
 * middle ground, even before the score-is-always-0 bug is accounted for.
 */
describe('newsMonitoringService — sentiment score fix', () => {
    describe('normalizeArticle', () => {
        test('computes a real, non-zero sentiment for a source with no native sentiment field (the common case)', () => {
            // Note: the underlying lexicon analyzer (pre-existing, already used
            // successfully by live trading) is a simple keyword-weight scorer —
            // it doesn't handle every negation pattern (e.g. "unable to recover"
            // reads as positive via "recover" alone, since "unable" isn't in its
            // negator list). That's a known limitation of the existing function,
            // not something this fix changes — picking a headline with an
            // unambiguous keyword match here instead.
            const article = normalizeArticle({
                title: 'Stock plunges after disappointing earnings miss',
                summary: 'Shares fell sharply on weak guidance',
                source: 'Stocktwits'
                // no `.sentiment` field — matches Motley Fool/Yahoo/MarketBeat/etc.
            });
            expect(article.sentimentScore).not.toBe(0);
            expect(article.sentimentScore).toBeLessThan(0);
        });

        test('a clearly positive headline scores positive', () => {
            const article = normalizeArticle({
                title: 'Nvidia stock surges to record high on stellar earnings beat',
                summary: '',
                source: 'Zacks'
            });
            expect(article.sentimentScore).toBeGreaterThan(0);
        });

        test('still prioritizes a native numeric sentiment field when a source actually provides one', () => {
            const article = normalizeArticle({
                title: 'Some headline text that would otherwise score differently',
                summary: '',
                sentiment: 42.5,
                source: 'Alpha Vantage'
            });
            expect(article.sentimentScore).toBe(42.5);
        });

        test('a genuinely neutral headline (no sentiment keywords) still scores exactly 0 — not every score should be non-zero', () => {
            const article = normalizeArticle({
                title: 'SEALSQ Corp Q2 2026 Earnings Call Summary',
                summary: '',
                source: 'Moby'
            });
            expect(article.sentimentScore).toBe(0);
        });
    });

    describe('analyzeNewsImpact — sentimentImpact thresholds match the real -100..100 scale', () => {
        test('a mildly negative score (-24.5) classifies as Negative, not Very Negative', () => {
            const result = analyzeNewsImpact({ title: 'x', summary: '' }, { score: -24.5 });
            expect(result.sentimentImpact).toBe('Negative');
        });

        test('a strongly negative score (-60) classifies as Very Negative', () => {
            const result = analyzeNewsImpact({ title: 'x', summary: '' }, { score: -60 });
            expect(result.sentimentImpact).toBe('Very Negative');
        });

        test('a small score within noise (-10) stays Neutral', () => {
            const result = analyzeNewsImpact({ title: 'x', summary: '' }, { score: -10 });
            expect(result.sentimentImpact).toBe('Neutral');
        });

        test('a mildly positive score (24.5) classifies as Positive, not Very Positive', () => {
            const result = analyzeNewsImpact({ title: 'x', summary: '' }, { score: 24.5 });
            expect(result.sentimentImpact).toBe('Positive');
        });
    });
});
