jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { simulateExit, compareExitRules, compareMethods } = require('../src/services/weeklyMarketStudyService');

/** Weekly market study (2026-10-17): exit simulation + method comparison over all ≥80 candidates. */
describe('simulateExit', () => {
    const bar = (o, h, l, c) => ({ o, h, l, c });

    test('fixed target sells at the target when the high reaches it', () => {
        const path = [bar(100, 104, 99, 103), bar(103, 106, 102, 105)];
        expect(simulateExit(path, 100, { target: 5 })).toBe(5);
    });

    test('same-day stop and target touch counts as the stop (conservative)', () => {
        const path = [bar(100, 110, 94, 100)];
        expect(simulateExit(path, 100, { target: 5 })).toBeCloseTo(-5);
    });

    test('a gap below the stop exits at the open, not the stop price', () => {
        const path = [bar(100, 101, 99, 100), bar(90, 91, 88, 89)];
        expect(simulateExit(path, 100, {})).toBeCloseTo(-10);
    });

    test('trailing stop follows the peak and locks in gains', () => {
        // rises to 120, trailing 5% → stop 114; next bar dips to 113
        const path = [bar(100, 120, 99, 118), bar(118, 118, 113, 115)];
        expect(simulateExit(path, 100, { trail: 5 })).toBeCloseTo(14);
    });

    test('no exit triggered → last close of the holding window', () => {
        const path = [bar(100, 102, 98, 101), bar(101, 103, 99, 102)];
        expect(simulateExit(path, 100, { hold: 2 })).toBeCloseTo(2);
    });
});

describe('compareExitRules / compareMethods', () => {
    const mk = (d, s, score, path, extra = {}) => ({
        d, s, score, tie: s.charCodeAt(0), path, entry: path[0].o, parts: {}, rsi: null, price: null, change: 0, ...extra,
    });
    const winner = [{ o: 100, h: 112, l: 99, c: 111 }, { o: 111, h: 113, l: 110, c: 112 }];
    const loser = [{ o: 100, h: 101, l: 94, c: 95 }];

    test('every rule is scored against the current trailing stop', () => {
        const rows = compareExitRules([mk('2026-10-01', 'A', 90, winner), mk('2026-10-01', 'B', 90, loser)]);
        expect(rows[0]).toMatchObject({ rule: 'Trailing 5% stop (current)', vsCurrentPp: 0 });
        const t5 = rows.find(r => r.rule === 'Target +5%');
        expect(t5.avgPct).toBeLessThan(rows[0].avgPct); // the target cut the +11% winner to +5%
    });

    test('jump check splits >5% scan-day jumpers from the rest', () => {
        const ts = [
            mk('2026-10-01', 'J', 99, loser, { change: 8 }),
            mk('2026-10-01', 'K', 90, winner, { change: 1 }),
        ];
        for (const t of ts) t.result = t.s === 'J' ? -5 : 11;
        const m = compareMethods(ts);
        expect(m.jumpCheck).toMatchObject({ jumpedN: 1, jumpedAvgPct: -5, restAvgPct: 11 });
        expect(m.current.avgPct).toBe(3); // both picked: (−5 + 11) / 2
    });
});
