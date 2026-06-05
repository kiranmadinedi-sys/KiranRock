const path = require('path');
const { expect } = require('chai');

function resolveFromBackend(moduleId) {
  const backendRoot = path.join(__dirname, '..');

  if (moduleId.startsWith('src/') || moduleId.startsWith('test/')) {
    return require.resolve(path.join(backendRoot, moduleId));
  }

  return require.resolve(moduleId, { paths: [backendRoot] });
}

function loadFresh(moduleId, mocks = {}) {
  const resolvedModule = resolveFromBackend(moduleId);
  const touched = [];
  const originals = new Map();

  delete require.cache[resolvedModule];

  for (const [mockId, mockExports] of Object.entries(mocks)) {
    const resolvedMock = resolveFromBackend(mockId);
    originals.set(resolvedMock, require.cache[resolvedMock]);
    require.cache[resolvedMock] = {
      id: resolvedMock,
      filename: resolvedMock,
      loaded: true,
      exports: mockExports
    };
    touched.push(resolvedMock);
  }

  const loaded = require(resolvedModule);

  return {
    loaded,
    restore() {
      delete require.cache[resolvedModule];
      for (const resolvedMock of touched) {
        const original = originals.get(resolvedMock);
        if (original) {
          require.cache[resolvedMock] = original;
        } else {
          delete require.cache[resolvedMock];
        }
      }
    }
  };
}

describe('broker-backed execution paths', function() {
  const originalBroker = process.env.BROKER;
  const originalBotEnabled = process.env.BOT_ENABLED;

  afterEach(function() {
    if (originalBroker === undefined) {
      delete process.env.BROKER;
    } else {
      process.env.BROKER = originalBroker;
    }

    if (originalBotEnabled === undefined) {
      delete process.env.BOT_ENABLED;
    } else {
      process.env.BOT_ENABLED = originalBotEnabled;
    }
  });

  it('allows manual buy orders through brokerService even when AI trading and bot toggles are off', async function() {
    process.env.BROKER = 'simulated';
    process.env.BOT_ENABLED = 'false';

    const buyCalls = [];
    const harness = loadFresh('src/services/brokerService.js', {
      'src/utils/logger.js': { logger: { info() {}, warn() {}, error() {} } },
      'src/services/tradingControlService.js': {
        getGlobalTradingControl: async () => ({ globalTradingEnabled: true, killSwitchReason: null }),
        getUserTradingControls: async () => ({
          aiTradingEnabled: false,
          emergencyStopEnabled: false,
          maxOrderNotional: 5000
        })
      },
      'src/services/tradingServiceDB.js': {
        getCurrentPrice: async () => 100,
        executeBuyOrder: async (userId, symbol, quantity, executedBy) => {
          buyCalls.push({ userId, symbol, quantity, executedBy });
          return { price: 100, total: 100 * quantity, commission: 0.1 };
        },
        executeSellOrder: async () => ({ price: 100, total: 100, commission: 0.1 })
      },
      'src/services/tradingAccountDatabaseService.js': {
        getTradingAccount: async () => ({ balance: 9900 })
      }
    });

    const brokerService = harness.loaded;

    try {
      const result = await brokerService.executeManualBuyOrder('user-1', 'AAPL', 1);

      expect(result.success).to.equal(true);
      expect(result.symbol).to.equal('AAPL');
      expect(result.price).to.equal(100);
      expect(result.broker).to.equal('simulated');
      expect(result.newBalance).to.equal(9900);
      expect(buyCalls).to.have.lengthOf(1);
      expect(buyCalls[0].executedBy).to.equal('MANUAL');
    } finally {
      harness.restore();
    }
  });

  it('still enforces maxOrderNotional on manual broker orders', async function() {
    process.env.BROKER = 'simulated';
    process.env.BOT_ENABLED = 'false';

    const harness = loadFresh('src/services/brokerService.js', {
      'src/utils/logger.js': { logger: { info() {}, warn() {}, error() {} } },
      'src/services/tradingControlService.js': {
        getGlobalTradingControl: async () => ({ globalTradingEnabled: true, killSwitchReason: null }),
        getUserTradingControls: async () => ({
          aiTradingEnabled: false,
          emergencyStopEnabled: false,
          maxOrderNotional: 50
        })
      },
      'src/services/tradingServiceDB.js': {
        getCurrentPrice: async () => 100,
        executeBuyOrder: async () => {
          throw new Error('should not execute');
        },
        executeSellOrder: async () => ({})
      },
      'src/services/tradingAccountDatabaseService.js': {
        getTradingAccount: async () => ({ balance: 10000 })
      }
    });

    const brokerService = harness.loaded;

    try {
      let caughtError = null;
      try {
        await brokerService.executeManualBuyOrder('user-1', 'AAPL', 1);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).to.be.an('error');
      expect(caughtError.message).to.contain('maxOrderNotional');
    } finally {
      harness.restore();
    }
  });

  it('initializes the legacy AI portfolio through brokerService buyMarket', async function() {
    process.env.BROKER = 'simulated';
    process.env.BOT_ENABLED = 'true';

    const buyCalls = [];
    const harness = loadFresh('src/services/aiTradingBotService.js', {
      'yahoo-finance2': {
        default: class MockYahooFinance {
          async quoteSummary() {
            return {
              price: {
                regularMarketPrice: 100,
                regularMarketChangePercent: 3,
                regularMarketVolume: 2000
              },
              summaryDetail: {
                averageDailyVolume10Day: 1000
              }
            };
          }
        }
      },
      'src/services/brokerService.js': {
        buyMarket: async (userId, symbol, quantity, meta) => {
          buyCalls.push({ userId, symbol, quantity, meta });
          return {
            filledAvgPrice: 100,
            total: quantity * 100,
            broker: 'simulated',
            orderId: `SIM-${symbol}`,
            status: 'filled'
          };
        }
      },
      'src/services/tradingServiceDB.js': {
        getCurrentPrice: async () => 100
      },
      'src/services/tradingAccountService.js': {
        getTradingAccount: async () => ({ balance: 10000 })
      },
      'src/services/portfolioTrackingService.js': {
        getPortfolioSummary: async () => ({ holdings: [], totalPortfolioValue: 0 })
      },
      'src/services/userProfileService.js': {
        getAITradingSettings: async () => ({})
      },
      'src/config/database.js': {
        query: async () => ({ rows: [] })
      },
      'src/services/newsSentimentService.js': {
        getNewsSentiment: async () => ({
          sentiment: { score: 0, label: 'Neutral', confidence: 'Low' },
          meta: { xPostCount: 0, articleCount: 0, sourceBreakdown: {} },
          analystRatings: { consensus: 'Hold' }
        })
      }
    });

    const aiTradingBotService = harness.loaded;

    try {
      const result = await aiTradingBotService.initializeAIPortfolio('legacy-ai-user');

      expect(result.success).to.equal(true);
      expect(result.executedTrades.length).to.be.greaterThan(0);
      expect(buyCalls.length).to.equal(result.executedTrades.length);
      expect(buyCalls[0].meta.executedBy).to.equal('AI_BOT');
    } finally {
      harness.restore();
    }
  });

  it('routes legacy AI scheduler auto-sells through brokerService', async function() {
    const sellCalls = [];
    const loggedDecisions = [];

    const harness = loadFresh('src/services/aiTradingScheduler.js', {
      'src/config/database.js': {
        query: async (sql, params) => {
          if (sql.includes('FROM users WHERE ai_trading_enabled = true')) {
            return { rows: [{ id: 'user-1', username: 'legacy-user' }] };
          }

          if (sql.includes('COUNT(*) as count FROM holdings')) {
            return { rows: [{ count: '1' }] };
          }

          if (sql.includes('SELECT id, symbol, quantity, average_price, peak_price FROM holdings')) {
            return {
              rows: [{
                id: 1,
                symbol: 'AAPL',
                quantity: '2',
                average_price: '100',
                peak_price: '120'
              }]
            };
          }

          return { rows: [] };
        }
      },
      'src/services/aiTradingBotService.js': {
        initializeAIPortfolio: async () => ({ executedTrades: [], diversification: { sectors: 0 } }),
        rebalancePortfolio: async () => ({ actions: [] })
      },
      'src/services/brokerService.js': {
        sellMarket: async (userId, symbol, quantity, meta) => {
          sellCalls.push({ userId, symbol, quantity, meta });
          return { filledAvgPrice: 100, status: 'filled', broker: 'simulated' };
        }
      },
      'src/services/tradingServiceDB.js': {
        getCurrentPrice: async () => 100
      },
      'src/services/userProfileService.js': {
        logAIDecision: async (userId, decision) => {
          loggedDecisions.push({ userId, decision });
          return { userId, ...decision };
        }
      }
    });

    const aiTradingScheduler = harness.loaded;

    try {
      await aiTradingScheduler.runAutomatedTrading();

      expect(sellCalls).to.have.lengthOf(1);
      expect(sellCalls[0]).to.include({ userId: 'user-1', symbol: 'AAPL', quantity: 2 });
      expect(sellCalls[0].meta.executedBy).to.equal('AI_SCHEDULER');
      expect(loggedDecisions).to.have.lengthOf(1);
      expect(loggedDecisions[0].decision.action).to.equal('AUTO_SELL');
    } finally {
      harness.restore();
    }
  });
});