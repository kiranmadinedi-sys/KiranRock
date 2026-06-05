const SonarService = require('../src/services/sonarService');
const finnhubConnector = require('../src/connectors/finnhubConnector');
const logger = require('../src/utils/logger');

// Mock dependencies
jest.mock('../src/connectors/finnhubConnector');
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('SonarService (SONAR)', () => {

  beforeEach(() => {
    // Clear mock history before each test
    logger.info.mockClear();
    finnhubConnector.getInstitutionalOwnership.mockClear();
    finnhubConnector.getInsiderTransactions.mockClear();
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
    expect(score).toBeGreaterThan(0.7);
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
    expect(score).toBeLessThan(0.4);
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
    expect(score).toBe(0); // Should return 0 on error
    expect(logger.error).toHaveBeenCalled();
  });

});
