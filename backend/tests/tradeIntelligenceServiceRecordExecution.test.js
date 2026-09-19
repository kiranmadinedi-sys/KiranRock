const { query } = require('../src/config/database');
const { logger } = require('../src/utils/logger');

jest.mock('../src/config/database');
jest.mock('../src/utils/logger', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
    },
}));

const tradeIntelligenceService = require('../src/services/tradeIntelligenceService');

/**
 * 2026-09-19: EXECUTED rows went dark platform-wide for ~2 weeks (Sept 1-15)
 * with zero errors logged anywhere and no root cause found from static
 * inspection. recordExecution now traces entry, logs the inserted row's id
 * and rowCount on success, and captures full Postgres error detail (not just
 * error.message) on failure — so if this recurs, the logs actually show
 * which of "never called" / "insert silently no-op" / "threw and was hidden"
 * happened. These tests just guard that instrumentation itself.
 */
describe('tradeIntelligenceService.recordExecution diagnostics (2026-09-19)', () => {
    beforeEach(() => {
        query.mockReset();
        logger.info.mockClear();
        logger.error.mockClear();
    });

    test('logs an entry trace before attempting the insert', async () => {
        query.mockResolvedValue({ rowCount: 1, rows: [{ id: 42 }] });

        await tradeIntelligenceService.recordExecution('user-1', {
            botType: 'stock', symbol: 'NVDA', setupFamily: 'breakout_leader',
        });

        expect(logger.info).toHaveBeenCalledWith(
            '[TradeIntelligence] recordExecution called',
            expect.objectContaining({ userId: 'user-1', symbol: 'NVDA', setupFamily: 'breakout_leader' })
        );
    });

    test('on success, logs the real rowCount and RETURNING id from the insert', async () => {
        query.mockResolvedValue({ rowCount: 1, rows: [{ id: 777 }] });

        await tradeIntelligenceService.recordExecution('user-1', {
            botType: 'stock', symbol: 'AMD',
        });

        const insertCall = query.mock.calls.find(c => c[0].includes('INSERT INTO trade_decision_journal'));
        expect(insertCall[0]).toMatch(/RETURNING id/);
        expect(logger.info).toHaveBeenCalledWith(
            '[TradeIntelligence] recordExecution wrote row',
            expect.objectContaining({ userId: 'user-1', symbol: 'AMD', rowCount: 1, insertedId: 777 })
        );
    });

    test('a silently no-op insert (rowCount 0, no error) is now visible in the success log', async () => {
        // The exact unexplained shape from the Sept 1-15 gap: no throw, but nothing written.
        query.mockResolvedValue({ rowCount: 0, rows: [] });

        await tradeIntelligenceService.recordExecution('user-1', {
            botType: 'stock', symbol: 'GOOGL',
        });

        expect(logger.info).toHaveBeenCalledWith(
            '[TradeIntelligence] recordExecution wrote row',
            expect.objectContaining({ rowCount: 0, insertedId: null })
        );
        expect(logger.error).not.toHaveBeenCalled();
    });

    test('on failure, logs full Postgres error detail, not just error.message', async () => {
        const pgError = new Error('null value in column "user_id" violates not-null constraint');
        pgError.code = '23502';
        pgError.detail = 'Failing row contains (null, stock, AMD, ...).';
        pgError.constraint = 'trade_decision_journal_user_id_not_null';
        pgError.table = 'trade_decision_journal';
        query.mockRejectedValue(pgError);

        await tradeIntelligenceService.recordExecution('user-1', {
            botType: 'stock', symbol: 'AMD',
        });

        expect(logger.error).toHaveBeenCalledWith(
            '[TradeIntelligence] Failed to record execution',
            expect.objectContaining({
                userId: 'user-1',
                symbol: 'AMD',
                code: '23502',
                detail: expect.stringContaining('Failing row'),
                constraint: 'trade_decision_journal_user_id_not_null',
                table: 'trade_decision_journal',
            })
        );
    });

    test('still swallows the failure rather than throwing — must never affect a real trade', async () => {
        query.mockRejectedValue(new Error('connection terminated'));

        await expect(tradeIntelligenceService.recordExecution('user-1', {
            botType: 'stock', symbol: 'AMD',
        })).resolves.toBeUndefined();
    });
});
