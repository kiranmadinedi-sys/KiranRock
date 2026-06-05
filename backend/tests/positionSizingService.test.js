const PositionSizingService = require('../src/services/positionSizingService');
const sageService = require('../src/services/sageService');
const riskConfig = require('../src/config/riskConfig');
const logger = require('../src/utils/logger');

// Mock dependencies
jest.mock('../src/services/sageService');
jest.mock('../src/config/riskConfig', () => ({
  minPositionSize: 0.01, // 1%
  maxPositionSize: 0.10, // 10%
  kellyFraction: 0.5,    // Use 50% of the calculated Kelly fraction
}));
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

describe('PositionSizingService (SCALE)', () => {

  beforeEach(() => {
    // Clear mock history before each test
    logger.info.mockClear();
    logger.warn.mockClear();
    sageService.getStrategyMetrics.mockClear();
  });

  test('should calculate a standard Kelly fraction and apply constraints', async () => {
    // Arrange: Profitable strategy
    sageService.getStrategyMetrics.mockResolvedValue({
      winProbability: 0.6, // 60% win rate
      winLossRatio: 2.0,   // Wins are 2x the size of losses
    });

    // Act
    const fraction = await PositionSizingService.getKellyFraction();

    // Assert
    // Raw Kelly = 0.6 - ((1 - 0.6) / 2.0) = 0.6 - (0.4 / 2.0) = 0.6 - 0.2 = 0.4
    // Adjusted for confidence (default 1.0) = 0.4
    // Fractional Kelly (0.5) = 0.4 * 0.5 = 0.2
    // Constrained by maxPositionSize (0.10) = 0.10
    expect(fraction).toBe(riskConfig.maxPositionSize);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Raw Kelly Fraction calculated: 0.4000'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Final position size fraction after applying constraints: 0.1000'));
  });

  test('should return 0 when Kelly Criterion is negative (no edge)', async () => {
    // Arrange: Losing strategy
    sageService.getStrategyMetrics.mockResolvedValue({
      winProbability: 0.4, // 40% win rate
      winLossRatio: 1.0,   // Wins are equal to losses
    });

    // Act
    const fraction = await PositionSizingService.getKellyFraction();

    // Assert
    // Raw Kelly = 0.4 - ((1 - 0.4) / 1.0) = 0.4 - 0.6 = -0.2
    expect(fraction).toBe(0);
    expect(logger.info).toHaveBeenCalledWith('[SCALE] Kelly fraction is not positive. Suggests no edge. Returning 0.');
  });

  test('should apply confidence score to moderate the fraction', async () => {
    // Arrange: Profitable strategy, but low confidence
    sageService.getStrategyMetrics.mockResolvedValue({
      winProbability: 0.7, // 70% win rate
      winLossRatio: 3.0,   // Wins are 3x the size of losses
    });
    const confidenceScore = 0.5;

    // Act
    const fraction = await PositionSizingService.getKellyFraction(confidenceScore);

    // Assert
    // Raw Kelly = 0.7 - ((1 - 0.7) / 3.0) = 0.7 - (0.3 / 3.0) = 0.7 - 0.1 = 0.6
    // Adjusted for confidence (0.5) = 0.6 * 0.5 = 0.3
    // Fractional Kelly (0.5) = 0.3 * 0.5 = 0.15
    // Constrained by maxPositionSize (0.10) = 0.10
    expect(fraction).toBe(riskConfig.maxPositionSize);
     expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Fraction adjusted for confidence (0.50): 0.3000'));
  });

  test('should return minPositionSize if calculated fraction is too low but positive', async () => {
    // Arrange: Barely profitable strategy
    sageService.getStrategyMetrics.mockResolvedValue({
      winProbability: 0.51, // 51% win rate
      winLossRatio: 1.0,    // Wins are equal to losses
    });

    // Act
    const fraction = await PositionSizingService.getKellyFraction();

    // Assert
    // Raw Kelly = 0.51 - ((1 - 0.51) / 1.0) = 0.51 - 0.49 = 0.02
    // Adjusted for confidence (1.0) = 0.02
    // Fractional Kelly (0.5) = 0.02 * 0.5 = 0.01
    // Constrained by minPositionSize (0.01) = 0.01
    expect(fraction).toBeCloseTo(riskConfig.minPositionSize);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Final position size fraction after applying constraints: 0.0100'));
  });

  test('should return minPositionSize when win/loss ratio is zero or negative', async () => {
    // Arrange: Invalid win/loss ratio
    sageService.getStrategyMetrics.mockResolvedValue({
      winProbability: 0.8,
      winLossRatio: 0,
    });

    // Act
    const fraction = await PositionSizingService.getKellyFraction();

    // Assert
    expect(fraction).toBe(riskConfig.minPositionSize);
    expect(logger.warn).toHaveBeenCalledWith('[SCALE] Win/Loss ratio is zero or negative. Cannot calculate Kelly. Defaulting to minimum size.');
  });
});
