jest.mock('../src/utils/logger', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), aiDecision: jest.fn() },
}));

describe('scoreComponentValidationService.analyzeRows', () => {
    const { analyzeRows, parseScoringLog } = require('../src/services/scoreComponentValidationService');

    // 40 scan dates x 100 symbols. Good fires on half the rows and adds +1% excess return;
    // Bad fires on half and subtracts 1%; Noise fires on half and does nothing.
    function synth() {
        const rows = [];
        let seed = 7;
        const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let day = 0; day < 40; day++) {
            const d = `2026-08-${String(day + 1).padStart(2, '0')}`;
            const marketMove = (rand() - 0.5) * 6; // same-day market drift, must be removed
            for (let i = 0; i < 100; i++) {
                const good = rand() < 0.5, bad = rand() < 0.5, noise = rand() < 0.5;
                const parts = { Good: good ? 5 : 0, Bad: bad ? 5 : -2, Noise: noise ? 3 : 0 };
                const ret5 = marketMove + (good ? 1 : 0) - (bad ? 1 : 0) + (rand() - 0.5) * 2;
                rows.push({ d, score: 50 + parts.Good + parts.Bad + parts.Noise, ret5, parts });
            }
        }
        return rows;
    }

    test('flags an unscored component that predicts in both halves for re-enabling', () => {
        const r = analyzeRows(synth(), new Set(['Good']));
        expect(r.reEnable.map(c => c.component)).toEqual(['Good']);
        const good = r.components.find(c => c.component === 'Good');
        expect(good.diff).toBeGreaterThan(0.8);
        expect(good.diffOlder).toBeGreaterThan(0);
        expect(good.diffNewer).toBeGreaterThan(0);
    });

    test('flags a scored component that hurts in both halves for disabling, not the noise one', () => {
        const r = analyzeRows(synth(), new Set());
        expect(r.disable.map(c => c.component)).toEqual(['Bad']);
        expect(r.reEnable).toEqual([]); // nothing is unscored here
    });

    test('a component that only works in one half is not flagged', () => {
        const rows = synth();
        const dates = [...new Set(rows.map(r => r.d))].sort();
        const mid = dates[20];
        // Regime: "Swing" helps +2% in the older half, hurts -2% in the newer half.
        for (const r of rows) {
            r.parts.Swing = r.parts.Noise > 0 ? 4 : 0;
            if (r.parts.Swing) r.ret5 += r.d < mid ? 2 : -2;
        }
        const r = analyzeRows(rows, new Set(['Swing']));
        expect(r.reEnable.map(c => c.component)).not.toContain('Swing');
        expect(r.disable.map(c => c.component)).not.toContain('Swing');
    });

    test('parseScoringLog reads the logged value, including [unscored] lines', () => {
        expect(parseScoringLog([
            'TrendTemplate: +12 (4/5 MA conditions)',
            'News: +6.54 (sentiment 81.7, sources 2) [unscored]',
            'SmartMoney: -4 (low institutional interest)',
            'not a component line',
        ])).toEqual({ TrendTemplate: 12, News: 6.54, SmartMoney: -4 });
    });
});

describe('SCORE_UNSCORED_BONUSES env switch', () => {
    afterEach(() => { delete process.env.SCORE_UNSCORED_BONUSES; jest.resetModules(); });

    test('defaults to the five components that failed the 2026-10-06 validation', () => {
        jest.resetModules();
        const { UNSCORED_BONUSES } = require('../src/services/enhancedAITradingBot');
        expect([...UNSCORED_BONUSES].sort()).toEqual(['Gemini', 'News', 'RelStrength5d', 'SmartMoney', 'WeeklyAlign']);
    });

    test('an empty value restores the old scoring (nothing unscored)', () => {
        jest.resetModules();
        process.env.SCORE_UNSCORED_BONUSES = '';
        const { UNSCORED_BONUSES } = require('../src/services/enhancedAITradingBot');
        expect(UNSCORED_BONUSES.size).toBe(0);
    });
});
