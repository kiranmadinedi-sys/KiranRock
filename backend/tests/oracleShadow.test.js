/** ORACLE shadow: log-only Gemini comparison never throws, respects the daily cap (2026-11-07). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('axios');

const axios = require('axios');
const { query } = require('../src/config/database');
const shadow = require('../src/services/oracleShadowService');

const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => {
    process.env.GEMINI_API_KEY = 'k';
    delete process.env.ORACLE_SHADOW_GEMINI;
    process.env.ORACLE_SHADOW_MAX_PER_DAY = '2';
    shadow._day.date = null;
    query.mockClear(); axios.post.mockReset();
});

test('parseVerdict applies the same field rules as the local parser', () => {
    expect(shadow.parseVerdict('```json\n{"verdict":"TRADE","score":120,"confidence":"HIGH"}\n```')).toEqual({ verdict: 'TRADE', score: 100, confidence: 'HIGH' });
    expect(shadow.parseVerdict('{"verdict":"maybe","score":"x"}')).toEqual({ verdict: 'WATCHLIST', score: 50, confidence: 'MEDIUM' });
});

test('daily cap', () => {
    const now = new Date('2026-11-09T15:00:00Z');
    expect([shadow._takeSlot(now), shadow._takeSlot(now), shadow._takeSlot(now)]).toEqual([true, true, false]);
    expect(shadow._takeSlot(new Date('2026-11-10T15:00:00Z'))).toBe(true);
});

test('logs both verdicts, including when the local model failed', async () => {
    axios.post.mockResolvedValue({ data: { candidates: [{ content: { parts: [{ text: '{"verdict":"SKIP","score":30,"confidence":"LOW"}' }] } }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100 } } });
    expect(() => shadow.record({ symbol: 'AAPL', price: 200, system: 's', prompt: 'p', localModel: 'qwen', local: null, localMs: 5 })).not.toThrow();
    await flush(); await flush();
    const insert = query.mock.calls.find(c => /INSERT INTO oracle_shadow/.test(c[0]));
    expect(insert[1].slice(0, 4)).toEqual(['AAPL', 200, 'qwen', null]);
    expect(insert[1].slice(8, 11)).toEqual(['SKIP', 30, 'LOW']);
    expect(insert[1][12]).toBeCloseTo(0.00055);
});

test('a Gemini error is logged, not thrown', async () => {
    axios.post.mockRejectedValue(Object.assign(new Error('x'), { response: { status: 402 } }));
    shadow.record({ symbol: 'MSFT', system: 's', prompt: 'p', localModel: 'qwen', local: { verdict: 'TRADE', score: 80, confidence: 'HIGH' } });
    await flush(); await flush();
    const insert = query.mock.calls.find(c => /INSERT INTO oracle_shadow/.test(c[0]));
    expect(insert[1][13]).toBe('402');
});

test('switched off → no Gemini call', () => {
    process.env.ORACLE_SHADOW_GEMINI = 'false';
    shadow.record({ symbol: 'X', system: 's', prompt: 'p' });
    expect(axios.post).not.toHaveBeenCalled();
});
