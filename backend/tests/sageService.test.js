const SageService = require('../src/services/sageService');
const { query } = require('../src/config/database');
const logger = require('../src/utils/logger');

// Mock dependencies
jest.mock('../src/config/database');
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('SageService (SAGE)', () => {

  beforeEach(() => {
    // Clear mock history before each test
    logger.warn.mockClear();
    query.mockClear();
  });

  test('should calculate metrics correctly from a profitable trade history', async () => {
    // Arrange: 3 wins, 1 loss
    const mockTrades = {
      rows: [
        { pnl: '150.00' }, { pnl: '200.00' }, { pnl: '50.00' }, // Wins
        { pnl: '-100.00' }, // Loss
        ...Array(20).fill({ pnl: '10' }) // Add enough trades to pass threshold
      ],
    };
    query.mockResolvedValue(mockTrades);

    // Act
    const metrics = await SageService.getStrategyMetrics();

    // Assert
    // Win Probability = 3 wins / 4 trades = 0.75 (ignoring the filler)
    // Let's recalculate with the filler: 23 wins / 24 trades
    expect(metrics.winProbability).toBeCloseTo(23 / 24);
    
    // Average Win = (150 + 200 + 50 + 20*10) / 23 = 600 / 23
    // Average Loss = 100 / 1 = 100
    // Win/Loss Ratio = (600/23) / 100 = 6 / 23
    const avgWin = (150 + 200 + 50 + 200) / 23;
    const avgLoss = 100;
    expect(metrics.winLossRatio).toBeCloseTo(avgWin / avgLoss);
  });

  test('should return default metrics if trade history is insufficient', async () => {
    // Arrange: Only 10 trades
    const mockTrades = { rows: Array(10).fill({ pnl: '10' }) };
    query.mockResolvedValue(mockTrades);

    // Act
    const metrics = await SageService.getStrategyMetrics();

    // Assert
    expect(metrics.winProbability).toBe(0.55);
    expect(metrics.winLossRatio).toBe(1.5);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Insufficient trade history'));
  });

  test('should return default metrics on database error', async () => {
    // Arrange
    query.mockRejectedValue(new Error('DB connection failed'));

    // Act
    const metrics = await SageService.getStrategyMetrics();

    // Assert
    expect(metrics.winProbability).toBe(0.55);
    expect(metrics.winLossRatio).toBe(1.5);
    expect(logger.error).toHaveBeenCalled();
  });

  test('should handle history with no losses', async () => {
    // Arrange: 25 wins, 0 losses
    const mockTrades = { rows: Array(25).fill({ pnl: '100' }) };
    query.mockResolvedValue(mockTrades);

    // Act
    const metrics = await SageService.getStrategyMetrics();

    // Assert
    expect(metrics.winProbability).toBe(1);
    expect(metrics.winLossRatio).toBe(10); // Capped value
  });
  
  test('should handle history with no wins', async () => {
    // Arrange: 25 losses, 0 wins
    const mockTrades = { rows: Array(25).fill({ pnl: '-50' }) };
    query.mockResolvedValue(mockTrades);

    // Act
    const metrics = await SageService.getStrategyMetrics();

    // Assert
    expect(metrics.winProbability).toBe(0);
    expect(metrics.winLossRatio).toBe(0);
  });
});
