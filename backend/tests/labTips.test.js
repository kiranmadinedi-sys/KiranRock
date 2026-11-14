jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const { query } = require('../src/config/database');
const tips = require('../src/services/labTipsService');

describe('marketTip', () => {
    test('plain sentence with regime, VIX band, weak tech and 20-day move', () => {
        const t = tips.marketTip({ regime: 'BULL', vixLevel: 19.3, qqqAboveMa50: false, return20d: '-1.58' });
        expect(t.title).toBe('Market mood');
        expect(t.text).toMatch(/rising \(bullish\)/);
        expect(t.text).toMatch(/19\.3: normal/);
        expect(t.text).toMatch(/Tech \(QQQ\) is below/);
        expect(t.text).toMatch(/-1\.6% over the last 20/);
    });
    test('high VIX gets the nervous wording; missing regime gives no tip', () => {
        expect(tips.marketTip({ regime: 'BEAR', vixLevel: 33 }).text).toMatch(/nervous market/);
        expect(tips.marketTip(null)).toBeNull();
    });
});

describe('buildTips', () => {
    test('a failing section is skipped, the rest still render', async () => {
        query.mockImplementation(async () => { throw new Error('db down'); });
        const out = await tips.buildTips('2026-11-14', { getRegime: async () => ({ regime: 'NEUTRAL', vixLevel: 14 }) });
        expect(out).toHaveLength(1);
        expect(out[0].text).toMatch(/flat \(neutral\)/);
        expect(out[0].text).toMatch(/calm conditions/);
    });
});
