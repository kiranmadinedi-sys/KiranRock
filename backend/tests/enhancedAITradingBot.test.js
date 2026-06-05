const EnhancedAITradingBot = require('../src/services/enhancedAITradingBot');
const dataProvider = require('../src/services/dataProvider');
const newsSentimentService = require('../src/services/newsSentimentService');
const marketRegimeService = require('../src/services/marketRegimeService');
const tradeIntelligenceService = require('../src/services/tradeIntelligenceService');
const brokerService = require('../src/services/brokerService');
const { query } = require('../src/config/database');
const logger = require('../src/utils/logger');
const cacheService = require('../src/services/cacheService');
const performanceService = require('../src/services/performanceMetricsService');
const tradingControlService = require('../src/services/tradingControlService');
const indicators = require('../src/services/technicalIndicators');

// Mock all other dependencies
jest.mock('../src/services/dataProvider');
jest.mock('../src/services/newsSentimentService');
jest.mock('../src/services/marketRegimeService');
jest.mock('../src/services/tradeIntelligenceService');
jest.mock('../src/services/brokerService');
jest.mock('../src/config/database');
jest.mock('../src/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    aiDecision: jest.fn(),
  },
  aiTradingLogger: {
    info: jest.fn(),
  },
}));
jest.mock('../src/services/cacheService', () => ({
    get: jest.fn(),
    set: jest.fn(),
}));
jest.mock('../src/services/performanceMetricsService');
jest.mock('../src/services/tradingControlService');
jest.mock('../src/services/technicalIndicators');

describe('EnhancedAITradingBot (The Brain)', () => {
  // Create a mock yahooFinance instance that we can pass to our functions.
  const mockYahooFinance = {
    quoteSummary: jest.fn(),
    chart: jest.fn(),
  };

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks();
    
    // Default mock implementations
    cacheService.get.mockReturnValue(null);
    query.mockResolvedValue({ rows: [] }); // Default DB response
    
    // Set default behaviors for our mock yahooFinance instance
    mockYahooFinance.quoteSummary.mockResolvedValue({
        calendarEvents: { earnings: { earningsDate: [] } }
    });

    tradeIntelligenceService.getExpectancyAdjustment.mockResolvedValue({
        scoreAdjustment: 0,
        sizeMultiplier: 1.0,
        expectancy: 0,
        confidence: 'low'
    });
    tradeIntelligenceService.ensureTradeIntelligenceSchema.mockResolvedValue(true);
    tradeIntelligenceService.recordCandidate.mockResolvedValue(true);
  });

  // Helper function to create mock data for a given scenario
  const createMockData = (scenario) => {
    const baseQuote = {
      price: 150,
      changePercent: 0,
      volume: 5000000,
      avgVolume: 5000000,
      marketCap: 50e9,
      sector: 'Technology',
      high52w: 155,
    };

    const baseBars = Array.from({ length: 90 }, (_, i) => ({
      close: 100 + i * 0.5,
      high: 101 + i * 0.5,
      low: 99 + i * 0.5,
      volume: 5000000,
    }));

    const baseNews = {
      sentiment: { score: 0, sourceCount: 5 },
      meta: { xPostCount: 0 }
    };

    switch (scenario) {
      case 'STRONG_BUY':
        dataProvider.getQuote.mockResolvedValue({ ...baseQuote, changePercent: 2.5 }); // Positive momentum
        const strongBuyBars = Array.from({ length: 90 }, (_, i) => ({ ...baseBars[i], close: 130 + (i * 0.25) + Math.sin(i / 4) * 1.5 }));
        dataProvider.getBars.mockResolvedValue(strongBuyBars);
        newsSentimentService.getNewsSentiment.mockResolvedValue({ ...baseNews, sentiment: { score: 80, sourceCount: 12 } });
        break;
      case 'STRONG_SELL':
        dataProvider.getQuote.mockResolvedValue({ ...baseQuote, changePercent: -2.8, high52w: 190 }); // Negative momentum
        const strongSellBars = Array.from({ length: 90 }, (_, i) => ({ ...baseBars[i], close: 170 - (i * 0.3) - Math.sin(i / 5) * 2 }));
        dataProvider.getBars.mockResolvedValue(strongSellBars);
        newsSentimentService.getNewsSentiment.mockResolvedValue({ ...baseNews, sentiment: { score: -75, sourceCount: 11 } });
        break;
      case 'EARNINGS_RISK':
        dataProvider.getQuote.mockResolvedValue({ ...baseQuote, changePercent: 1.0 });
        dataProvider.getBars.mockResolvedValue(baseBars);
        newsSentimentService.getNewsSentiment.mockResolvedValue(baseNews);
        // Mock earnings date to be 3 days from now
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 3);
        // Set a specific behavior on our mock for this test
        mockYahooFinance.quoteSummary.mockResolvedValue({
            calendarEvents: { earnings: { earningsDate: [futureDate] } }
        });
        break;
      default: // Neutral
        dataProvider.getQuote.mockResolvedValue(baseQuote);
        dataProvider.getBars.mockResolvedValue(baseBars);
        newsSentimentService.getNewsSentiment.mockResolvedValue(baseNews);
        break;
    }
  };

  describe('analyzeStockWithAI', () => {
    
    test('should generate a high score for a STRONG BUY scenario', async () => {
      // --- Arrange: Force a perfect "Strong Buy" by mocking internal indicators ---
      
      // 1. Mock fundamental data providers for positive momentum and news
      dataProvider.getQuote.mockResolvedValue({ price: 150, changePercent: 3.5, volume: 6e6, avgVolume: 3e6, marketCap: 200e9, sector: 'Technology', high52w: 155 });
      dataProvider.getBars.mockResolvedValue(Array(90).fill({ close: 100, high: 101, low: 99, volume: 3e6 }));
      newsSentimentService.getNewsSentiment.mockResolvedValue({ sentiment: { score: 80 } });
      
      // 2. Mock indicator interpretations to return max bullish scores
      indicators.interpretRSI.mockReturnValue({ scoreAdjustment: 15, signal: 'Bullish' });
      indicators.interpretMACD.mockReturnValue({ scoreAdjustment: 10, signal: 'Bullish Crossover' });
      indicators.interpretBollingerBands.mockReturnValue({ scoreAdjustment: 12, signal: 'Breaking Upper Band' });
      
      // 3. Mock other indicators to be bullish or neutral
      indicators.calculateStochasticRSI.mockReturnValue(15); // Oversold = Bullish
      indicators.calculateWilliamsR.mockReturnValue(-85); // Oversold = Bullish
      
      // --- Act ---
      const analysis = await EnhancedAITradingBot.analyzeStockWithAI('AAPL', 15, mockYahooFinance); // Low VIX
      
      // --- Assert ---
      expect(analysis).not.toBeNull();
      expect(analysis.aiScore).toBeGreaterThan(75);
      expect(analysis.recommendation).toBe('STRONG BUY');
      expect(analysis.scoringLog).toEqual(expect.arrayContaining([
          "Momentum: +10 (strong up)",
          "Volume: +10 (2x avg)",
          "RSI: +15 (Bullish)",
          "StochRSI: +8 (oversold 15.0)",
          "WilliamsR: +7 (oversold -85.0)",
          "MACD: +10 (Bullish Crossover)",
          "BB: +12 (Breaking Upper Band)",
          "VIX: +5 (calm market)"
      ]));
    });

    test('should generate a low score for a STRONG SELL scenario', async () => {
      // --- Arrange: Force a perfect "Strong Sell" ---
      dataProvider.getQuote.mockResolvedValue({ price: 150, changePercent: -4.0, volume: 6e6, avgVolume: 3e6, marketCap: 200e9, sector: 'Technology', high52w: 250 });
      dataProvider.getBars.mockResolvedValue(Array(90).fill({ close: 200, high: 201, low: 199, volume: 3e6 }));
      newsSentimentService.getNewsSentiment.mockResolvedValue({ sentiment: { score: -80 } });

      indicators.interpretRSI.mockReturnValue({ scoreAdjustment: -15, signal: 'Bearish' });
      indicators.interpretMACD.mockReturnValue({ scoreAdjustment: -10, signal: 'Bearish Crossover' });
      indicators.interpretBollingerBands.mockReturnValue({ scoreAdjustment: -12, signal: 'Breaking Lower Band' });
      indicators.calculateStochasticRSI.mockReturnValue(85); // Overbought = Bearish
      indicators.calculateWilliamsR.mockReturnValue(-15); // Overbought = Bearish

      // --- Act ---
      const analysis = await EnhancedAITradingBot.analyzeStockWithAI('META', 35, mockYahooFinance); // High VIX

      // --- Assert ---
      expect(analysis).not.toBeNull();
      expect(analysis.aiScore).toBeLessThan(25);
      expect(analysis.recommendation).toBe('STRONG SELL');
      expect(analysis.scoringLog).toEqual(expect.arrayContaining([
          "Momentum: -10 (strong down)",
          "Volume: +10 (2x avg)", // High volume can occur in sell-offs too
          "RSI: -15 (Bearish)",
          "StochRSI: -8 (overbought 85.0)",
          "WilliamsR: -7 (overbought -15.0)",
          "MACD: -10 (Bearish Crossover)",
          "BB: -12 (Breaking Lower Band)",
          "VIX: -10 (extreme fear)"
      ]));
    });

    test('should heavily penalize score due to upcoming earnings', async () => {
      // --- Arrange ---
      dataProvider.getQuote.mockResolvedValue({ price: 200, changePercent: 1, volume: 1e6, avgVolume: 1e6, marketCap: 500e9, sector: 'Technology', high52w: 210 });
      dataProvider.getBars.mockResolvedValue(Array(90).fill({ close: 190 }));
      newsSentimentService.getNewsSentiment.mockResolvedValue({ sentiment: { score: 10 } }); // Neutral news
      
      // Mock indicators to be neutral
      indicators.interpretRSI.mockReturnValue({ scoreAdjustment: 0 });
      indicators.interpretMACD.mockReturnValue({ scoreAdjustment: 0 });
      
      // --- Act ---
      const analysis = await EnhancedAITradingBot.analyzeStockWithAI('NVDA', 20, mockYahooFinance);
      
      // --- Assert ---
      expect(analysis).not.toBeNull();
      expect(analysis.earningsFlag).toBe(true);
      expect(analysis.scoringLog).toEqual(expect.arrayContaining(['Earnings: -15 (3 days)']));
    });

    test('should return null if data provider fails to fetch a quote', async () => {
        dataProvider.getQuote.mockRejectedValue(new Error("API Error"));
        dataProvider.getBars.mockResolvedValue([]);
        newsSentimentService.getNewsSentiment.mockResolvedValue(null);
        
        const analysis = await EnhancedAITradingBot.analyzeStockWithAI('FAIL', 20, mockYahooFinance);
        
        expect(analysis).toBeNull();
        const { logger } = require('../src/utils/logger');
        expect(logger.error).toHaveBeenCalledWith('Error analyzing stock', expect.any(Object));
    });

    test('should return null if there is insufficient historical data', async () => {
        createMockData('NEUTRAL');
        dataProvider.getBars.mockResolvedValue(Array(10).fill({close: 100})); // Only 10 bars
        // Pass the mock instance directly to the function
        const analysis = await EnhancedAITradingBot.analyzeStockWithAI('SHORT', 20, mockYahooFinance);
        expect(analysis).toBeNull();
    });
  });
});
