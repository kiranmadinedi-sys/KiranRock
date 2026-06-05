/**
 * Test script for AI Trading Bot Enhancements
 * Tests logger, alerts, performance metrics, and technical indicators
 */

const { logger, aiTradingLogger } = require('./src/utils/logger');
const alertService = require('./src/services/telegramAlertService');
const performanceService = require('./src/services/performanceMetricsService');
const technicalIndicators = require('./src/services/technicalIndicators');

async function testLogger() {
    console.log('\n========== Testing Logger ==========');
    
    // Test standard logging
    logger.info('Standard info log');
    logger.warn('Warning log');
    logger.error('Error log', { errorCode: 'TEST_ERROR' });
    
    // Test specialized methods
    logger.trade('BUY', 'AAPL', 100, 178.50, { aiScore: 85, reason: 'Strong RSI signal' });
    logger.aiDecision('NVDA', 88, 'STRONG BUY', { rsi: 45, macd: 'bullish', confidence: 92 });
    logger.riskEvent('STOP_LOSS_TRIGGERED', 'TSLA', { lossPercent: -12.5, price: 240.50 });
    logger.performance({
        winRate: 58.5,
        profitFactor: 1.75,
        totalTrades: 45,
        sharpeRatio: 1.32
    });
    
    console.log('✓ Logger test complete - check logs/ directory');
}

async function testTechnicalIndicators() {
    console.log('\n========== Testing Technical Indicators ==========');
    
    // Sample price data (last 30 days)
    const closes = [
        175, 176, 174, 177, 178, 180, 179, 181, 183, 182,
        184, 185, 183, 186, 188, 187, 189, 190, 188, 192,
        194, 193, 195, 197, 196, 198, 200, 199, 201, 203
    ];
    
    const highs = closes.map(c => c + 1);
    const lows = closes.map(c => c - 1);
    
    // Test RSI
    const rsi = technicalIndicators.calculateSimpleRSI(closes, 14);
    const rsiSignal = technicalIndicators.interpretRSI(rsi);
    console.log(`RSI: ${rsi.toFixed(2)}`);
    console.log(`RSI Signal: ${rsiSignal.signal} (${rsiSignal.description})`);
    console.log(`RSI Score Adjustment: ${rsiSignal.scoreAdjustment}`);
    
    // Test MACD
    const macd = technicalIndicators.calculateSimpleMACD(closes, 12, 26, 9);
    const macdSignal = technicalIndicators.interpretMACD(macd);
    console.log(`MACD Line: ${macd.macdLine.toFixed(4)}`);
    console.log(`Signal Line: ${macd.signalLine.toFixed(4)}`);
    console.log(`Histogram: ${macd.histogram.toFixed(4)}`);
    console.log(`MACD Signal: ${macdSignal.signal} (${macdSignal.description})`);
    console.log(`MACD Score Adjustment: ${macdSignal.scoreAdjustment}`);
    
    // Test ATR
    const atr = technicalIndicators.calculateSimpleATR(highs, lows, closes, 14);
    console.log(`ATR: ${atr.toFixed(2)}`);
    
    console.log('✓ Technical indicators test complete');
}

async function testTelegramAlerts() {
    console.log('\n========== Testing Telegram Alerts ==========');
    
    const testUserId = 1; // Change to your test user ID
    
    try {
        // Test 1: Trading Started
        console.log('Sending trading started alert...');
        await alertService.alertTradingStarted(testUserId, 25000, 5);
        
        // Test 2: Trade Executed
        console.log('Sending trade executed alert...');
        await alertService.alertTradeExecuted(
            testUserId,
            'BUY',
            'AAPL',
            100,
            178.50,
            85,
            'RSI: 45 (Neutral), MACD: Bullish'
        );
        
        // Test 3: Large Loss Warning
        console.log('Sending large loss alert...');
        await alertService.alertLargeLoss(
            testUserId,
            'NVDA',
            -12.5,
            450.25,
            515.00
        );
        
        // Test 4: Daily Summary
        console.log('Sending daily summary...');
        await alertService.alertDailySummary(testUserId, {
            trades: 8,
            profitTrades: 5,
            lossTrades: 3,
            totalProfit: 1250.75,
            winRate: 62.5,
            bestTrade: 850.20,
            worstTrade: -320.50
        });
        
        console.log('✓ Telegram alerts test complete - check @KiranTradePro_bot');
    } catch (error) {
        console.error('✗ Telegram alert test failed:', error.message);
        console.log('Note: Telegram alerts require TELEGRAM_BOT_TOKEN in .env');
    }
}

async function testPerformanceMetrics() {
    console.log('\n========== Testing Performance Metrics ==========');
    
    try {
        // Initialize table
        console.log('Initializing performance metrics table...');
        await performanceService.initializePerformanceTable();
        console.log('✓ Table initialized');
        
        // Record sample trade
        const testUserId = 1;
        const sampleTrade = {
            action: 'BUY',
            symbol: 'AAPL',
            quantity: 100,
            price: 178.50,
            fees: 1.00,
            profit: null
        };
        
        console.log('Recording sample trade...');
        await performanceService.recordTradePerformance(testUserId, sampleTrade);
        console.log('✓ Trade recorded');
        
        // Fetch today's performance
        const today = new Date().toISOString().split('T')[0];
        const dailyPerf = await performanceService.getDailyPerformance(testUserId, today);
        console.log('Today\'s Performance:', dailyPerf);
        
        // Fetch weekly performance
        const weeklyPerf = await performanceService.getWeeklyPerformance(testUserId);
        console.log('Weekly Performance:', weeklyPerf);
        
        console.log('✓ Performance metrics test complete');
    } catch (error) {
        console.error('✗ Performance metrics test failed:', error.message);
    }
}

// Run all tests
async function runAllTests() {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║  AI Trading Bot Enhancements Test Suite  ║');
    console.log('╚════════════════════════════════════════════╝');
    
    try {
        await testLogger();
        await testTechnicalIndicators();
        await testPerformanceMetrics();
        await testTelegramAlerts(); // Last because it's optional
        
        console.log('\n╔════════════════════════════════════════════╗');
        console.log('║          All Tests Completed! ✓           ║');
        console.log('╚════════════════════════════════════════════╝\n');
        
        console.log('Next Steps:');
        console.log('1. Check logs/ directory for log files');
        console.log('2. Verify Telegram messages were received');
        console.log('3. Query ai_performance_metrics table in database');
        console.log('4. Follow AI_BOT_ENHANCEMENTS.md integration steps');
        
        process.exit(0);
    } catch (error) {
        console.error('\n✗ Test suite failed:', error);
        process.exit(1);
    }
}

runAllTests();
