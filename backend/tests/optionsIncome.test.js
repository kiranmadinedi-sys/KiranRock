/** Options income — cash-secured puts, paper only (2026-10-17). */
describe('optionsIncomeService', () => {
    let oi;
    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
        jest.doMock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
        jest.doMock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
        oi = require('../src/services/optionsIncomeService');
    });

    const TODAY = '2026-10-19';
    const snap = (bid, ask, delta, vol = 50, barDay = TODAY) => ({ latestQuote: { bp: bid, ap: ask }, greeks: { delta }, dailyBar: { t: `${barDay}T04:00:00Z`, v: vol } });

    test('busy contracts only: under 20 traded, or a last trade over 5 days old, is skipped (2026-11-14)', () => {
        expect(oi.choosePut({ 'APA261120P00045000': snap(1.20, 1.36, -0.22, 5) }, TODAY)).toBeNull();
        expect(oi.choosePut({ 'APA261120P00045000': snap(1.20, 1.36, -0.22, 500, '2026-10-01') }, TODAY)).toBeNull();
        expect(oi.choosePut({ 'APA261120P00045000': snap(1.20, 1.36, -0.22, 20) }, TODAY).contract).toBe('APA261120P00045000');
    });

    test('delta beyond 0.25 is now too risky (2026-11-14)', () => {
        expect(oi.choosePut({ 'APA261120P00045000': snap(1.20, 1.36, -0.28) }, TODAY)).toBeNull();
    });

    test('picks the best premium per month among puts inside every rule', () => {
        const pick = oi.choosePut({
            'DVN261120P00047500': snap(0.95, 1.03, -0.26),   // 32d, 2.08% → qualifies
            'APA261120P00045000': snap(1.20, 1.36, -0.25),   // 32d, 2.84% → qualifies, higher
            'XYZ261120P00045000': snap(2.00, 2.20, -0.45),   // delta too high (too risky)
            'ABC261120P00045000': snap(0.05, 0.40, -0.20),   // spread far too wide
            'LOW261120P00045000': snap(0.10, 0.11, -0.10),   // delta too low / premium too small
            'SHR261030P00045000': snap(1.00, 1.05, -0.25),   // 11 days — too short
        }, TODAY);
        expect(pick.contract).toBe('APA261120P00045000');
        expect(pick.strike).toBe(45);
        expect(pick.dte).toBe(32);
    });

    test('skips contracts whose collateral exceeds the per-position cap', () => {
        // strike $150 → $15,000 collateral > $10,000 cap
        expect(oi.choosePut({ 'BIG261120P00150000': snap(3.0, 3.2, -0.22) }, TODAY)).toBeNull();
    });

    test('refuses a live account (PAPER ONLY guard)', async () => {
        jest.resetModules();
        jest.doMock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
        jest.doMock('../src/services/userDatabaseService', () => ({
            getUserAlpacaCredentials: jest.fn().mockResolvedValue({ keyId: 'k', secretKey: 's', isPaper: false }),
        }));
        const svc = require('../src/services/optionsIncomeService');
        await expect(svc.runEntries('live-user')).rejects.toThrow(/PAPER ONLY/);
        await expect(svc.runManagement('live-user')).rejects.toThrow(/PAPER ONLY/);
    });
});
