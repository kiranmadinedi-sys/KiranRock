/** Every Telegram message is copied to the Reports page with the right visibility (2026-11-07). */
jest.mock('../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { query } = require('../src/config/database');
const archive = require('../src/services/reportArchiveService');
const flush = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await flush(); };

beforeEach(() => {
    process.env.REPORT_ARCHIVE_IN_TESTS = '1';
    process.env.TELEGRAM_CHAT_ID = 'ADMIN';
    query.mockReset();
});
afterAll(() => { delete process.env.REPORT_ARCHIVE_IN_TESTS; });

const inserted = () => query.mock.calls.filter(c => /INSERT INTO report_archive/.test(c[0])).map(c => c[1]);

test('admin chat → admin-only raw copy, title from the first line', async () => {
    query.mockImplementation(async () => ({ rows: [] }));
    archive.archiveTelegram({ chatId: 'ADMIN', body: '*Scan done*\n2,727 stocks', parseMode: 'Markdown' });
    await settle();
    expect(inserted()).toEqual([['Scan done', '*Scan done*\n2,727 stocks', 'markdown', null, true]]);
});

test("a user's own chat → visible only to that user", async () => {
    query.mockImplementation(async sql => (/FROM users/.test(sql) ? { rows: [{ id: 'u-1' }] } : { rows: [] }));
    archive.archiveTelegram({ chatId: '555', body: '<b>BUY</b> AAPL', parseMode: 'HTML' });
    await settle();
    expect(inserted()).toEqual([['BUY AAPL', '<b>BUY</b> AAPL', 'html', 'u-1', false]]);
});

test('skips text a scheduled report already archived', async () => {
    query.mockImplementation(async sql => (/SELECT 1 FROM report_archive/.test(sql) ? { rows: [{ '?column?': 1 }] } : { rows: [] }));
    archive.archiveTelegram({ chatId: 'ADMIN', body: 'weekly report' });
    await settle();
    expect(inserted()).toEqual([]);
});

test('"All" view hides the raw Telegram copies; the telegram chip shows them', async () => {
    query.mockResolvedValue({ rows: [] });
    await archive.list('u', true);
    expect(query.mock.calls.at(-1)[0]).toMatch(/kind <> ALL\('\{telegram\}'\)/);
    await archive.list('u', true, { kind: 'telegram' });
    expect(query.mock.calls.at(-1)[0]).not.toMatch(/kind <> ALL/);
});
