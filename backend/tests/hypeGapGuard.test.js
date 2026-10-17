/** Hype-gap guard (2026-10-17): no-earnings ≥5% gap-ups on ≥2.5× volume are dropped. */
describe('precomputedUniverseService._dropHypeGaps', () => {
    let svc, query;
    const bars = (symbol, gapDayOpen, gapDayVol) => {
        const out = [];
        for (let i = 0; i < 25; i++) out.push({ symbol, d: `2026-09-${String(i + 1).padStart(2, '0')}`, o: 100, c: 100, v: 1000 });
        out.push({ symbol, d: '2026-10-16', o: gapDayOpen, c: gapDayOpen, v: gapDayVol });
        return out;
    };
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
        jest.doMock('../src/config/database', () => ({ query: jest.fn() }));
        svc = require('../src/services/precomputedUniverseService');
        query = require('../src/config/database').query;
    });
    const rows = [{ symbol: 'HYPE' }, { symbol: 'EARN' }, { symbol: 'CALM' }];
    const mock = (news) => query.mockImplementation(sql => Promise.resolve(
        /FROM daily_bars/.test(sql) ? { rows: [...bars('HYPE', 110, 5000), ...bars('EARN', 110, 5000), ...bars('CALM', 101, 1100)] }
            : /FROM news_archive/.test(sql) ? { rows: news } : { rows: [] }));

    test('drops a no-earnings hype gap, keeps an earnings gap and a calm stock', async () => {
        mock([{ s: 'EARN', d: '2026-10-16' }]);
        const out = await svc._dropHypeGaps(rows, '2026-10-16');
        expect(out.map(r => r.symbol)).toEqual(['EARN', 'CALM']);
    });

    test('never throws: on a data error every candidate is kept', async () => {
        query.mockRejectedValue(new Error('db down'));
        expect((await svc._dropHypeGaps(rows, '2026-10-16')).length).toBe(3);
    });

    test('HYPE_GAP_GUARD=off disables it', async () => {
        process.env.HYPE_GAP_GUARD = 'off';
        mock([]);
        expect((await svc._dropHypeGaps(rows, '2026-10-16')).length).toBe(3);
        expect(query).not.toHaveBeenCalled();
        delete process.env.HYPE_GAP_GUARD;
    });
});
