/** Long Telegram messages are sent in parts under the 4096-char limit (2026-11-05). */
jest.mock('axios', () => ({ post: jest.fn() }));
process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'test-token';
const axios = require('axios');
const { sendTelegramMessage } = require('../src/services/telegramAlertService');

test('a 9,000-char report goes out as 3 parts, each under the limit', async () => {
    axios.post.mockResolvedValue({ data: { ok: true } });
    const report = Array.from({ length: 300 }, (_, i) => `Line ${i} `.padEnd(29, 'x')).join('\n');
    expect(await sendTelegramMessage('1', report)).toBe(true);
    const texts = axios.post.mock.calls.map(c => c[1].text);
    expect(texts.length).toBe(3);
    texts.forEach(t => expect(t.length).toBeLessThanOrEqual(4000));
    expect(texts.join('\n')).toBe(report);
});
