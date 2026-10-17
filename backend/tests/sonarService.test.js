const SonarService = require('../src/services/sonarService');
const finnhubConnector = require('../src/connectors/finnhubConnector');
const { logger } = require('../src/utils/logger');

// Mock dependencies
jest.mock('../src/connectors/finnhubConnector');
// No network or cache in unit tests: the service now also falls back to Polygon (axios) and
// SEC EDGAR, applies an 8-K modifier, and caches scores per symbol.
jest.mock('../src/connectors/secEdgarConnector', () => ({ getRecentForm8K: jest.fn().mockResolvedValue([]), getInsiderTransactions: jest.fn().mockResolvedValue([]) }));
jest.mock('../src/services/cacheService', () => ({ get: jest.fn().mockReturnValue(null), set: jest.fn() }));
jest.mock('axios', () => {
  const get = jest.fn().mockRejectedValue(new Error('no network in tests'));
  return { get, create: jest.fn(() => ({ get })) }; // create: finnhubConnector builds a client at load
});
// The logger module exports { logger } (was mocked as a bare object, which crashed the suite on load).
jest.mock('../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

describe('SonarService (SONAR)', () => {

  beforeEach(() => {
    // Clear mock history before each test
    logger.info.mockClear();
    finnhubConnector.getInstitutionalOwnership.mockClear();
    finnhubConnector.getInsiderTransactions.mockClear();
    // jest.config resetMocks wipes factory implementations before every test — re-arm them.
    const cache = require('../src/services/cacheService');
    cache.get.mockReturnValue(null);
    const sec = require('../src/connectors/secEdgarConnector');
    sec.getRecentForm8K.mockResolvedValue([]);
    sec.getInsiderTransactions.mockResolvedValue([]);
    require('axios').get.mockRejectedValue(new Error('no network in tests'));
  });

  test('should return a high score for strong institutional buying and ownership', async () => {
    // Arrange
    const ownershipData = [
      { reportDate: '2026-03-31', share: 4000000, change: 500000 }, // High ownership, recent buy
      { reportDate: '2026-03-31', share: 3000000, change: 200000 },
    ];
    const transactionData = [
      { transactionCode: 'P - Purchase', change: 10000, price: 100 }, // $1M buy
      { transactionCode: 'S - Sale', change: 1000, price: 100 },     // $100k sell
    ];
    finnhubConnector.getInstitutionalOwnership.mockResolvedValue(ownershipData);
    finnhubConnector.getInsiderTransactions.mockResolvedValue(transactionData);

    // Act
    const score = await SonarService.getSmartMoneyScore('GOOD');

    // Assert
    // Ownership score should be high (high total shares, positive change)
    // Transaction score should be high (net buying)
    // Final score is a weighted average, so it should be high.
    // Current formula (institutional + insider weights, 8-K modifier): clearly above neutral.
    expect(score).toBeGreaterThan(0.6);
  });

  test('should return a low score for institutional selling and insider selling', async () => {
    // Arrange
    const ownershipData = [
      { reportDate: '2026-03-31', share: 1000000, change: -500000 }, // Low ownership, recent sell
      { reportDate: '2026-03-31', share: 500000, change: -200000 },
    ];
    const transactionData = [
      { transactionCode: 'P - Purchase', change: 1000, price: 100 },     // $100k buy
      { transactionCode: 'S - Sale', change: 10000, price: 100 }, // $1M sell
    ];
    finnhubConnector.getInstitutionalOwnership.mockResolvedValue(ownershipData);
    finnhubConnector.getInsiderTransactions.mockResolvedValue(transactionData);

    // Act
    const score = await SonarService.getSmartMoneyScore('BAD');

    // Assert
    // Ownership score should be low (low total shares, negative change)
    // Transaction score should be low (net selling)
    expect(score).toBeLessThan(0.5); // below neutral
  });

  test('should return a neutral score when no data is available', async () => {
    // Arrange
    finnhubConnector.getInstitutionalOwnership.mockResolvedValue(null);
    finnhubConnector.getInsiderTransactions.mockResolvedValue(null);

    // Act
    const score = await SonarService.getSmartMoneyScore('UNKNOWN');

    // Assert
    // Ownership score should be 0.5 (neutral)
    // Transaction score should be 0.5 (neutral)
    // Final score should be 0.5
    expect(score).toBeCloseTo(0.5);
  });
  
  test('should return a neutral score on API error', async () => {
    // Arrange
    finnhubConnector.getInstitutionalOwnership.mockRejectedValue(new Error('API Timeout'));
    finnhubConnector.getInsiderTransactions.mockResolvedValue([]); // Assume this one succeeds

    // Act
    const score = await SonarService.getSmartMoneyScore('ERROR');

    // Assert
    // Each source's failure is caught on its own (2026 redesign), so one outage leaves the
    // score neutral instead of penalising the stock.
    expect(score).toBeCloseTo(0.5);
  });

});
