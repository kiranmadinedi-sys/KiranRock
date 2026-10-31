/** Candidate rotation (2026-10-31): the top stays first, the tail rotates so every candidate gets a turn. */
jest.mock('../src/services/telegramAlertService', () => ({ sendMessage: jest.fn(async () => {}), alertAll: jest.fn(async () => {}) }));
const { _test } = require('../src/services/enhancedAITradingBot');
const list = Array.from({ length: 12 }, (_, i) => `S${i}`);

test('top 5 always first; the tail starts at the cursor and wraps', () => {
    expect(_test.rotateScanList(list, 0, 5)).toEqual(list);
    expect(_test.rotateScanList(list, 3, 5)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4', 'S8', 'S9', 'S10', 'S11', 'S5', 'S6', 'S7']);
    expect(_test.rotateScanList(list, 7 + 3, 5)).toEqual(_test.rotateScanList(list, 3, 5)); // wraps by tail length
});

test('8 analyzed per cycle covers all 40 within a few cycles', () => {
    const forty = Array.from({ length: 40 }, (_, i) => i);
    const seen = new Set(); let cursor = 0;
    for (let c = 0; c < 12 && seen.size < 40; c++) {
        _test.rotateScanList(forty, cursor, 5).slice(0, 8).forEach(x => seen.add(x));
        cursor += 8 - 5;
    }
    expect(seen.size).toBe(40);
});

test('short lists are returned unchanged', () => {
    expect(_test.rotateScanList(['A', 'B'], 4, 5)).toEqual(['A', 'B']);
});
