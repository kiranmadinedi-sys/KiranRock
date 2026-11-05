/** Paid/keyed service probe classifies billing, key and quota errors (2026-11-04). */
const { _serviceProblem } = require('../src/services/systemHealthMonitorService');

describe('_serviceProblem', () => {
    test('billing, key and quota errors are reported', () => {
        expect(_serviceProblem({ response: { status: 402, data: { error: { message: 'Your prepayment credits are depleted.' } } } }))
            .toMatch(/out of credits \(402\).*depleted/);
        expect(_serviceProblem({ response: { status: 403, data: {} } })).toMatch(/key rejected/);
        expect(_serviceProblem({ response: { status: 429, data: { error: 'API limit reached' } } })).toMatch(/429.*API limit/);
    });

    test('network blips and server errors are not', () => {
        expect(_serviceProblem({ code: 'ETIMEDOUT' })).toBeNull();
        expect(_serviceProblem({ response: { status: 503, data: {} } })).toBeNull();
    });
});
