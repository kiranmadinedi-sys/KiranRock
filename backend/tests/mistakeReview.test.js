/** Daily mistake review: labels are restricted to the fixed cause lists (2026-11-07). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mr = require('../src/services/mistakeReviewService');

const items = [
    { key: 'loss:1', kind: 'loss', ref: { id: 1 }, facts: { symbol: 'AAA', pnlPct: -4 } },
    { key: 'missed:9', kind: 'missed', ref: { id: 9 }, facts: { symbol: 'BBB', ret5DaysAfterPct: 12 } },
];

test('keeps valid labels, maps unknown causes to the neutral one, drops unknown keys and repeats', () => {
    const reply = JSON.stringify([
        { key: 'loss:1', cause: 'chased_extended', lesson: 'bought 15% above the 20-day low' },
        { key: 'loss:1', cause: 'weak_market', lesson: 'repeat' },
        { key: 'missed:9', cause: 'stop_too_tight', lesson: 'loss cause used for a miss' },
        { key: 'loss:77', cause: 'weak_market', lesson: 'not a case' },
    ]);
    const out = mr.parseLabels(reply, items);
    expect(out.map(o => [o.item.key, o.cause])).toEqual([['loss:1', 'chased_extended'], ['missed:9', 'correct_skip']]);
});

test('non-JSON reply → no labels', () => {
    expect(mr.parseLabels('sorry', items)).toEqual([]);
});

test('prompt carries both cause lists and every case', () => {
    const p = mr.buildPrompt(items);
    for (const c of [...mr.LOSS_CAUSES, ...mr.MISS_CAUSES]) expect(p).toContain(c);
    expect(p).toContain('"key":"loss:1"');
    expect(p).toContain('"key":"missed:9"');
});

test('message flags causes repeating 3+ times, not the neutral ones', () => {
    const saved = [{ item: items[0], cause: 'chased_extended', lesson: 'x <b>' }];
    const msg = mr.formatMessage(saved, 0.003, { counts: [
        { kind: 'loss', cause: 'chased_extended', n: 4 }, { kind: 'loss', cause: 'normal_noise', n: 9 },
    ] });
    expect(msg).toContain('chased_extended ×4');
    expect(msg).not.toContain('normal_noise ×9');
    expect(msg).not.toContain('<b>x');
});
