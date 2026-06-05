const path   = require('path');
const { expect } = require('chai');

// ─── loadFresh helper (same pattern used across the test suite) ───────────────

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

// ─── Stub factory for enhancedAITradingBot dependencies ──────────────────────
// Produces a minimal but complete set of mocks so loadFresh doesn't crash on import.

function makeMinimalMocks(overrides = {}) {
    const silentLogger = { info() {}, warn() {}, error() {}, aiDecision() {} };

    return {
        // data / DB
        'src/config/database.js':                      { query: async () => ({ rows: [], rowCount: 0 }) },
        'src/utils/logger.js':                         { logger: silentLogger, aiTradingLogger: silentLogger },
        'src/services/marketScreenerService.js':       { getStockUniverse: async () => [] },
        'src/services/tradingServiceDB.js':            {
            getCurrentPrice: async () => 100,
            executeBuyOrder: async () => ({ price: 100, total: 1000, commission: 0 }),
            executeSellOrder: async () => ({ price: 100, total: 1000, commission: 0 })
        },
        'src/services/userDatabaseService.js':         { getUser: async () => null },
        'src/services/tradingAccountDatabaseService.js': {
            getTradingAccount: async () => ({ balance: 10000, id: 'acc-1' })
        },
        'src/services/holdingsDatabaseService.js':     { getHoldings: async () => [] },
        'src/services/tradesDatabaseService.js':       { getRecentTrades: async () => [] },
        'src/services/telegramAlertService.js':        {
            alertStartup: async () => {},
            alertHighVIX: async () => {},
            alertNoOpportunities: async () => {},
            alertTrade: async () => {},
            alertTrailingStop: async () => {},
            alertStopLoss: async () => {},
            alertTakeProfit: async () => {}
        },
        'src/services/technicalIndicators.js':         require(path.join(__dirname, '../src/services/technicalIndicators')),
        'src/services/marketRegimeService.js':         {
            getMarketRegime: async () => ({
                regime: 'NEUTRAL', minBuyScore: 65, maxPortfolioRisk: 0.6,
                sizeMultiplier: 1.0, regimeDescription: 'Neutral'
            })
        },
        'src/services/newsSentimentService.js':        { getNewsSentiment: async () => null },
        'src/services/tradeIntelligenceService.js':    {
            ensureTradeIntelligenceSchema: async () => {},
            getExpectancyAdjustment: async () => ({ scoreAdjustment: 0 }),
            recordCandidate: async () => {},
            recordTrade: async () => {}
        },
        'src/services/cacheService.js':                { get: async () => null, set: async () => {} },
        'src/services/brokerService.js':               {
            executeOrder: async () => ({ success: true, filledAvgPrice: 100, total: 1000, broker: 'simulated' }),
            executeSellOrder: async () => ({ success: true, filledAvgPrice: 100, total: 1000, broker: 'simulated' }),
            executeManualBuyOrder: async () => ({ success: true }),
            executeManualSellOrder: async () => ({ success: true })
        },
        'src/services/dataProvider.js':                {
            getQuote: async () => ({ symbol: 'SPY', price: 500, _fetchedAt: Date.now() }),
            getBars:  async () => [],
            providerName: 'Mock', providerKey: 'mock'
        },
        'src/services/tradingControlService.js':       {
            ensurePhase0Schema: async () => {},
            getGlobalTradingControl:  async () => ({ globalTradingEnabled: true, killSwitchReason: null }),
            getUserTradingControls:   async () => ({
                aiTradingEnabled: true, emergencyStopEnabled: false, maxOrderNotional: 10000
            })
        },
        'src/services/performanceMetricsService.js':   {
            getConsecutiveLosses: async () => 0,
            recordDailyMetrics:   async () => {},
            getKellyMetrics:      async () => null
        },
        // Suppress yahoo-finance2 — not needed in tests
        'yahoo-finance2': {
            default: class { async quoteSummary() { return {}; } async chart() { return { quotes: [] }; } }
        },
        ...overrides
    };
}

// ─── ① brokerService safety gate (per-order notional cap) ────────────────────

describe('brokerService — per-order safety gate', function () {
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    before(function () { process.env.TELEGRAM_BOT_TOKEN = process.env.TEST_TELEGRAM_BOT_TOKEN || 'test-token'; });
    after(function () {
        if (origToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
        else process.env.TELEGRAM_BOT_TOKEN = origToken;
    });

    it('blocks an order whose estimated cost exceeds MAX_BOT_INVESTMENT_USD', async function () {
        process.env.BROKER = 'simulated';
        process.env.BOT_ENABLED = 'true';
        process.env.MAX_BOT_INVESTMENT_USD = '500';

        const harness = loadFresh('src/services/brokerService.js', {
            'src/utils/logger.js': { logger: { info() {}, warn() {}, error() {} } },
            'src/services/tradingControlService.js': {
                getGlobalTradingControl: async () => ({ globalTradingEnabled: true, killSwitchReason: null }),
                getUserTradingControls:  async () => ({
                    aiTradingEnabled: true, emergencyStopEnabled: false, maxOrderNotional: 0
                })
            },
            'src/services/tradingServiceDB.js': {
                getCurrentPrice: async () => 200,
                executeBuyOrder: async () => ({ price: 200, total: 600, commission: 0 }),
                executeSellOrder: async () => ({})
            },
            'src/services/tradingAccountDatabaseService.js': {
                getTradingAccount: async () => ({ balance: 50000 })
            }
        });

        try {
            // 3 shares × $200 = $600, exceeds MAX_BOT_INVESTMENT_USD=$500
            // buyMarket fetches current price internally, so estimated cost = quantity × fetched price
            await harness.loaded.buyMarket('user-1', 'AAPL', 3, { safetyOptions: { requireAiEnabled: false } });
            expect.fail('Should have thrown an error');
        } catch (err) {
            expect(err.message).to.include('MAX_BOT_INVESTMENT_USD');
        } finally {
            harness.restore();
            delete process.env.MAX_BOT_INVESTMENT_USD;
        }
    });

    it('allows an order within the MAX_BOT_INVESTMENT_USD cap', async function () {
        process.env.BROKER = 'simulated';
        process.env.BOT_ENABLED = 'true';
        process.env.MAX_BOT_INVESTMENT_USD = '5000';

        const harness = loadFresh('src/services/brokerService.js', {
            'src/utils/logger.js': { logger: { info() {}, warn() {}, error() {} } },
            'src/services/tradingControlService.js': {
                getGlobalTradingControl: async () => ({ globalTradingEnabled: true, killSwitchReason: null }),
                getUserTradingControls:  async () => ({
                    aiTradingEnabled: true, emergencyStopEnabled: false, maxOrderNotional: 0
                })
            },
            'src/services/tradingServiceDB.js': {
                getCurrentPrice: async () => 100,
                executeBuyOrder: async () => ({ price: 100, total: 200, commission: 0 }),
                executeSellOrder: async () => ({})
            },
            'src/services/tradingAccountDatabaseService.js': {
                getTradingAccount: async () => ({ balance: 50000 })
            }
        });

        try {
            // 2 shares × $100 = $200, well within $5000 cap
            const result = await harness.loaded.buyMarket('user-1', 'AAPL', 2, { safetyOptions: { requireAiEnabled: false } });
            expect(result).to.exist;
        } finally {
            harness.restore();
            delete process.env.MAX_BOT_INVESTMENT_USD;
        }
    });
});

// ─── ② executeAutonomousTrading kill-switch / control gates ──────────────────

describe('executeAutonomousTrading — trading control gates', function () {
    it('returns early with "Global trading disabled" when kill switch is on', async function () {
        process.env.NODE_ENV = 'test';

        const harness = loadFresh('src/services/enhancedAITradingBot.js', {
            ...makeMinimalMocks({
                'src/services/tradingControlService.js': {
                    ensurePhase0Schema: async () => {},
                    getGlobalTradingControl:  async () => ({ globalTradingEnabled: false, killSwitchReason: 'Maintenance' }),
                    getUserTradingControls:   async () => ({ aiTradingEnabled: true, emergencyStopEnabled: false, maxOrderNotional: 0 })
                }
            })
        });

        try {
            const result = await harness.loaded.executeAutonomousTrading('user-1');
            expect(result.success).to.equal(false);
            expect(result.message).to.include('Global trading disabled');
        } finally {
            harness.restore();
            delete process.env.NODE_ENV;
        }
    });

    it('returns early with "AI trading disabled" when user AI toggle is off', async function () {
        process.env.NODE_ENV = 'test';

        const harness = loadFresh('src/services/enhancedAITradingBot.js', {
            ...makeMinimalMocks({
                'src/services/tradingControlService.js': {
                    ensurePhase0Schema: async () => {},
                    getGlobalTradingControl:  async () => ({ globalTradingEnabled: true, killSwitchReason: null }),
                    getUserTradingControls:   async () => ({ aiTradingEnabled: false, emergencyStopEnabled: false, maxOrderNotional: 0 })
                }
            })
        });

        try {
            const result = await harness.loaded.executeAutonomousTrading('user-1');
            expect(result.success).to.equal(false);
            expect(result.message).to.include('AI trading disabled');
        } finally {
            harness.restore();
            delete process.env.NODE_ENV;
        }
    });

    it('returns early with "User emergency stop" when emergency stop is enabled', async function () {
        process.env.NODE_ENV = 'test';

        const harness = loadFresh('src/services/enhancedAITradingBot.js', {
            ...makeMinimalMocks({
                'src/services/tradingControlService.js': {
                    ensurePhase0Schema: async () => {},
                    getGlobalTradingControl:  async () => ({ globalTradingEnabled: true, killSwitchReason: null }),
                    getUserTradingControls:   async () => ({ aiTradingEnabled: true, emergencyStopEnabled: true, maxOrderNotional: 0 })
                }
            })
        });

        try {
            const result = await harness.loaded.executeAutonomousTrading('user-1');
            expect(result.success).to.equal(false);
            expect(result.message).to.include('emergency stop');
        } finally {
            harness.restore();
            delete process.env.NODE_ENV;
        }
    });
});

// ─── ③ Consecutive loss streak circuit breaker (internal, test-only export) ──

describe('checkLossStreakBreaker', function () {
    let harness;

    before(function () {
        process.env.NODE_ENV = 'test';
        harness = loadFresh('src/services/enhancedAITradingBot.js', makeMinimalMocks());
    });

    after(function () {
        if (harness) harness.restore();
        delete process.env.NODE_ENV;
    });

    it('exports _test.checkLossStreakBreaker in test environment', function () {
        expect(harness.loaded._test).to.exist;
        expect(harness.loaded._test.checkLossStreakBreaker).to.be.a('function');
    });

    it('returns multiplier=1 and halt=false when streak is 0', async function () {
        // performanceMetricsService is mocked to return getConsecutiveLosses=0
        const result = await harness.loaded._test.checkLossStreakBreaker('user-1');
        expect(result.halt).to.equal(false);
        expect(result.multiplier).to.equal(1.0);
        expect(result.streak).to.equal(0);
    });

    it('returns multiplier=0.5 and halt=false at streak=3 (CIRCUIT_REDUCE_STREAK)', async function () {
        // Reload with streak=3
        harness.restore();
        process.env.NODE_ENV = 'test';
        process.env.CIRCUIT_REDUCE_STREAK = '3';
        process.env.CIRCUIT_HALT_STREAK   = '5';

        harness = loadFresh('src/services/enhancedAITradingBot.js', makeMinimalMocks({
            'src/services/performanceMetricsService.js': {
                getConsecutiveLosses: async () => 3,
                recordDailyMetrics:   async () => {},
                getKellyMetrics:      async () => null
            }
        }));

        const result = await harness.loaded._test.checkLossStreakBreaker('user-1');
        expect(result.halt).to.equal(false);
        expect(result.multiplier).to.equal(0.5);
        expect(result.streak).to.equal(3);

        delete process.env.CIRCUIT_REDUCE_STREAK;
        delete process.env.CIRCUIT_HALT_STREAK;
    });

    it('returns multiplier=0 and halt=true at streak=5 (CIRCUIT_HALT_STREAK)', async function () {
        harness.restore();
        process.env.NODE_ENV = 'test';
        process.env.CIRCUIT_REDUCE_STREAK = '3';
        process.env.CIRCUIT_HALT_STREAK   = '5';

        harness = loadFresh('src/services/enhancedAITradingBot.js', makeMinimalMocks({
            'src/services/performanceMetricsService.js': {
                getConsecutiveLosses: async () => 5,
                recordDailyMetrics:   async () => {},
                getKellyMetrics:      async () => null
            }
        }));

        const result = await harness.loaded._test.checkLossStreakBreaker('user-1');
        expect(result.halt).to.equal(true);
        expect(result.multiplier).to.equal(0);
        expect(result.streak).to.equal(5);

        delete process.env.CIRCUIT_REDUCE_STREAK;
        delete process.env.CIRCUIT_HALT_STREAK;
    });
});

// ─── ④ deriveStockSetupFamily — mean_reversion_bounce classification ──────────

describe('deriveStockSetupFamily', function () {
    let fn;

    before(function () {
        process.env.NODE_ENV = 'test';
        const harness = loadFresh('src/services/enhancedAITradingBot.js', makeMinimalMocks());
        fn = harness.loaded._test.deriveStockSetupFamily;
        // Note: don't restore — we'll restore in after()
        this._harness = harness;
    });

    after(function () {
        if (this._harness) this._harness.restore();
        delete process.env.NODE_ENV;
    });

    it('returns breakout_leader when relative strength is high and near 52wk high', function () {
        const result = fn({ momentum: 0.02, relativeStrength: 10, highProximity: 0.97, rsi: 65, stochRSI: 60, macdSignal: 'Bullish', newsSentiment: 0, distFromSma20Pct: 2 });
        expect(result).to.equal('breakout_leader');
    });

    it('returns mean_reversion_bounce when RSI is oversold AND price is 3-15% below SMA20', function () {
        const result = fn({ momentum: -0.02, relativeStrength: -5, highProximity: 0.80, rsi: 28, stochRSI: 18, macdSignal: 'Bearish', newsSentiment: 0, distFromSma20Pct: -8 });
        expect(result).to.equal('mean_reversion_bounce');
    });

    it('returns oversold_reversal when RSI is low but price is not below SMA20', function () {
        const result = fn({ momentum: 0.01, relativeStrength: -2, highProximity: 0.85, rsi: 28, stochRSI: null, macdSignal: 'Neutral', newsSentiment: 0, distFromSma20Pct: 1 });
        expect(result).to.equal('oversold_reversal');
    });

    it('returns trend_following when momentum and MACD are both bullish', function () {
        const result = fn({ momentum: 0.02, relativeStrength: 3, highProximity: 0.88, rsi: 55, stochRSI: 60, macdSignal: 'Bullish', newsSentiment: 0, distFromSma20Pct: 3 });
        expect(result).to.equal('trend_following');
    });

    it('returns news_momentum when sentiment is high and momentum is positive', function () {
        const result = fn({ momentum: 0.005, relativeStrength: 1, highProximity: 0.88, rsi: 55, stochRSI: 55, macdSignal: 'Neutral', newsSentiment: 50, distFromSma20Pct: 0 });
        expect(result).to.equal('news_momentum');
    });

    it('returns quality_continuation as the default', function () {
        const result = fn({ momentum: 0.001, relativeStrength: 1, highProximity: 0.88, rsi: 52, stochRSI: 55, macdSignal: 'Neutral', newsSentiment: 0, distFromSma20Pct: 0 });
        expect(result).to.equal('quality_continuation');
    });
});
