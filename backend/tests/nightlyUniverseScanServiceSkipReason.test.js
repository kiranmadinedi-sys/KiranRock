jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/services/marketScreenerService', () => ({}));
jest.mock('../src/services/marketRegimeService', () => ({ getMarketRegime: jest.fn() }));
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/precomputedUniverseService', () => ({}));
jest.mock('../src/services/enhancedAITradingBot', () => ({
    analyzeStockWithAI: jest.fn(),
    getVixLevel: jest.fn().mockResolvedValue(15),
    getSkipReasonFamily: jest.fn((code) => {
        const m = { WEINSTEIN_STAGE_3: 'STRATEGY', WEINSTEIN_STAGE_4: 'STRATEGY', RISK_FLAG_HARD_SKIP: 'RISK', NO_QUOTE_DATA: 'DATA', INSUFFICIENT_HISTORY: 'DATA', INTERNAL_ERROR: 'SYSTEM' };
        return m[code] || 'RELIABILITY';
    }),
}));

const { query } = require('../src/config/database');
const { analyzeStockWithAI } = require('../src/services/enhancedAITradingBot');
const marketRegimeService = require('../src/services/marketRegimeService');
const { rescanSymbol, rescanFailedSymbols } = require('../src/services/nightlyUniverseScanService');

/**
 * 2026-09-25 real incident: AVGO, GOOGL and NFLX all failed the nightly scan two
 * nights running with the identical generic exclusion_reason "analyzeStockWithAI
 * returned null" — no way to tell a real fraud-risk hard-skip (ASTS, that same
 * night) apart from a genuine Weinstein-downtrend skip (these three) apart from
 * an actual data/internal failure, short of re-running the analysis live with ad
 * hoc instrumentation. analyzeStockWithAI now reports its real reason via an
 * optional onSkip callback; _analyzeWithRetry (exercised here through the already-
 * exported rescanSymbol/rescanFailedSymbols) threads that reason through instead
 * of collapsing every case into the same generic string.
 */
describe('nightlyUniverseScanService — real skip-reason propagation', () => {
    // _analyzeWithRetry's real 15s-between-attempts delay is genuine production
    // behavior (rate-limit-friendly pacing), not something to work around — fake
    // timers let every test here observe the real retry path without the real
    // wait. Every case below has analyzeStockWithAI resolve null at least once,
    // so all of them hit it.
    beforeEach(() => {
        jest.useFakeTimers();
        jest.clearAllMocks();
        query.mockResolvedValue({ rows: [] });
        const bot = require('../src/services/enhancedAITradingBot');
        bot.getVixLevel.mockResolvedValue(15);
        // jest.clearAllMocks() wipes the factory-level implementation above too, not just
        // call history — same lesson from earlier this week (portfolioTrackingServiceCashGuard).
        bot.getSkipReasonFamily.mockImplementation((code) => {
            const m = { WEINSTEIN_STAGE_3: 'STRATEGY', WEINSTEIN_STAGE_4: 'STRATEGY', RISK_FLAG_HARD_SKIP: 'RISK', NO_QUOTE_DATA: 'DATA', INSUFFICIENT_HISTORY: 'DATA', INTERNAL_ERROR: 'SYSTEM' };
            return m[code] || 'RELIABILITY';
        });
        marketRegimeService.getMarketRegime.mockResolvedValue(null);
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    async function _runWithFakeTimers(promiseFactory) {
        const p = promiseFactory();
        await jest.runAllTimersAsync();
        return p;
    }

    describe('rescanSymbol', () => {
        test('a real skip reason from analyzeStockWithAI is surfaced, not the generic fallback', async () => {
            analyzeStockWithAI.mockImplementation(async (symbol, vix, yf, regime, liveMode, onSkip) => {
                onSkip('WEINSTEIN_STAGE_4', 'price 343.7 vs sma200 346.47, rising=false');
                return null;
            });

            const result = await _runWithFakeTimers(() => rescanSymbol('GOOGL', 'news'));

            expect(result).toEqual(expect.objectContaining({
                symbol: 'GOOGL',
                changed: false,
                reason: 'WEINSTEIN_STAGE_4 (price 343.7 vs sma200 346.47, rising=false)',
            }));
        });

        test('a fraud/risk-flag hard skip is surfaced distinctly', async () => {
            analyzeStockWithAI.mockImplementation(async (symbol, vix, yf, regime, liveMode, onSkip) => {
                onSkip('RISK_FLAG_HARD_SKIP', 'litigation_material, fraud_allegation');
                return null;
            });

            const result = await _runWithFakeTimers(() => rescanSymbol('ASTS', 'news'));

            expect(result.reason).toBe('RISK_FLAG_HARD_SKIP (litigation_material, fraud_allegation)');
        });

        test('falls back to a generic reason when analyzeStockWithAI never calls onSkip (defensive)', async () => {
            analyzeStockWithAI.mockResolvedValue(null);

            const result = await _runWithFakeTimers(() => rescanSymbol('XYZ', 'news'));

            expect(result.reason).toBe('UNKNOWN');
        });

        test('a real analysis result still flows through unaffected', async () => {
            analyzeStockWithAI.mockResolvedValue({
                aiScore: 82, recommendation: 'STRONG BUY', setupFamily: 'breakout_leader', sector: 'Technology', marketCap: 5e9,
            });

            const result = await rescanSymbol('NBIS', 'news'); // no retry path hit -- no fake-timer wait needed

            expect(result).toEqual(expect.objectContaining({ symbol: 'NBIS', newRec: 'STRONG BUY', newScore: 82 }));
        });
    });

    describe('rescanFailedSymbols', () => {
        test('a real skip reason is recorded per-symbol, tagged as a rescan', async () => {
            analyzeStockWithAI.mockImplementation(async (symbol, vix, yf, regime, liveMode, onSkip) => {
                onSkip('NO_QUOTE_DATA', null);
                return null;
            });

            const result = await _runWithFakeTimers(() => rescanFailedSymbols('2026-09-25', ['NFLX']));

            expect(result.results).toEqual([{ symbol: 'NFLX', ok: false }]);
            const upsertCall = query.mock.calls.find(c => c[0].includes('INSERT INTO daily_universe_analysis'));
            expect(upsertCall[1]).toEqual(expect.arrayContaining(['NO_QUOTE_DATA (rescan)']));
            // The split code/detail now also lands in metadata, not just the combined exclusion_reason string.
            const metadataArg = JSON.parse(upsertCall[1][9]);
            expect(metadataArg).toEqual({ skipCode: 'NO_QUOTE_DATA', skipDetail: null });
        });
    });

    describe('getSkipReasonBreakdown', () => {
        test('groups stored skip codes by exact code and by family', async () => {
            const { getSkipReasonBreakdown } = require('../src/services/nightlyUniverseScanService');
            query.mockResolvedValue({
                rows: [
                    { code: 'WEINSTEIN_STAGE_4', n: '1843' },
                    { code: 'NO_QUOTE_DATA', n: '412' },
                    { code: 'RISK_FLAG_HARD_SKIP', n: '376' },
                ],
            });

            const result = await getSkipReasonBreakdown('2026-09-26');

            expect(result.total).toBe(2631);
            expect(result.byCode).toEqual([
                { code: 'WEINSTEIN_STAGE_4', count: 1843 },
                { code: 'NO_QUOTE_DATA', count: 412 },
                { code: 'RISK_FLAG_HARD_SKIP', count: 376 },
            ]);
            expect(result.byFamily).toEqual({ STRATEGY: 1843, DATA: 412, RISK: 376 });
        });

        test('reports zero cleanly when nothing has the new skipCode field yet (pre-fix historical data)', async () => {
            const { getSkipReasonBreakdown } = require('../src/services/nightlyUniverseScanService');
            query.mockResolvedValue({ rows: [] });

            const result = await getSkipReasonBreakdown('2026-09-20');

            expect(result).toEqual({ date: '2026-09-20', total: 0, byCode: [], byFamily: {} });
        });
    });

    describe('formatSkipReasonBreakdown', () => {
        test('renders totals, family rollup, and per-code detail into readable text', () => {
            const { formatSkipReasonBreakdown } = require('../src/services/nightlyUniverseScanService');
            const text = formatSkipReasonBreakdown({
                date: '2026-09-26',
                total: 2631,
                byCode: [
                    { code: 'WEINSTEIN_STAGE_4', count: 1843 },
                    { code: 'NO_QUOTE_DATA', count: 412 },
                    { code: 'RISK_FLAG_HARD_SKIP', count: 376 },
                ],
                byFamily: { STRATEGY: 1843, DATA: 412, RISK: 376 },
            });

            expect(text).toContain('Total skipped: 2631');
            expect(text).toContain('STRATEGY');
            expect(text).toContain('WEINSTEIN_STAGE_4');
            expect(text).toContain('1843');
        });
    });
});
