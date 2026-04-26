/**
 * Test Yahoo Finance fixes
 */

const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const rateLimiter = require('./src/utils/yahooFinanceRateLimiter');

async function testYahooFinanceFixes() {
  console.log('========================================');
  console.log('YAHOO FINANCE FIXES TEST');
  console.log('========================================\n');
  
  console.log('1. Testing yahoo-finance2 import...');
  console.log(`   Type: ${typeof yahooFinance}`);
  console.log(`   Has quote method: ${typeof yahooFinance.quote === 'function'}`);
  
  if (typeof yahooFinance.quote !== 'function') {
    console.log('   ❌ FAILED: yahooFinance.quote is not a function!\n');
    return;
  }
  console.log('   ✓ Import is correct\n');
  
  console.log('2. Testing rate limiter...');
  console.log(`   Type: ${typeof rateLimiter.execute}`);
  
  if (typeof rateLimiter.execute !== 'function') {
    console.log('   ❌ FAILED: rateLimiter.execute is not a function!\n');
    return;
  }
  console.log('   ✓ Rate limiter loaded\n');
  
  console.log('3. Testing Yahoo Finance API call with rate limiter...');
  try {
    const start = Date.now();
    const quote = await rateLimiter.execute(() => 
      yahooFinance.quote('AAPL')
    );
    const elapsed = Date.now() - start;
    
    console.log(`   ✓ API call successful! (${elapsed}ms)`);
    console.log(`   Symbol: ${quote.symbol}`);
    console.log(`   Price: $${quote.regularMarketPrice}`);
    console.log(`   Market Cap: $${(quote.marketCap / 1e9).toFixed(2)}B\n`);
  } catch (error) {
    console.log(`   ❌ FAILED: ${error.message}\n`);
    return;
  }
  
  console.log('4. Testing multiple API calls (rate limiting)...');
  const symbols = ['AAPL', 'MSFT', 'GOOGL'];
  const start = Date.now();
  
  try {
    for (const symbol of symbols) {
      const quote = await rateLimiter.execute(() => 
        yahooFinance.quote(symbol)
      );
      console.log(`   ✓ ${symbol}: $${quote.regularMarketPrice.toFixed(2)}`);
    }
    
    const elapsed = Date.now() - start;
    console.log(`   ✓ All calls successful! Total time: ${elapsed}ms`);
    console.log(`   Average time per call: ${(elapsed / symbols.length).toFixed(0)}ms\n`);
    
    if (elapsed / symbols.length < 150) {
      console.log('   ⚠️  WARNING: Rate limiting may not be working');
      console.log('   (Expected >150ms per call)\n');
    } else {
      console.log('   ✓ Rate limiting is working correctly\n');
    }
  } catch (error) {
    console.log(`   ❌ FAILED: ${error.message}\n`);
    return;
  }
  
  console.log('========================================');
  console.log('✓ ALL TESTS PASSED!');
  console.log('========================================');
  console.log('Yahoo Finance fixes are working correctly.');
  console.log('The Enhanced AI Scheduler should now be able to');
  console.log('analyze stocks without errors.');
}

testYahooFinanceFixes().catch(console.error);
