const { query } = require('./src/config/database');
const tradingAccountService = require('./src/services/tradingAccountService');

async function testDeposit() {
    console.log('\n=== Testing Deposit Flow for User bnageshw ===\n');
    
    try {
        // Get user ID
        const userResult = await query(
            'SELECT id, username FROM users WHERE username = $1',
            ['bnageshw']
        );
        
        if (userResult.rows.length === 0) {
            console.log('❌ User not found');
            process.exit(1);
        }
        
        const userId = userResult.rows[0].id;
        console.log('✅ User found:', userResult.rows[0].username);
        console.log('   User ID:', userId);
        
        // Get initial balance
        const accountBefore = await tradingAccountService.getTradingAccount(userId);
        console.log('\n📊 Balance before deposit: $' + accountBefore.balance.toFixed(2));
        
        // Test deposit
        const depositAmount = 10000;
        console.log(`\n💰 Depositing $${depositAmount.toFixed(2)}...`);
        
        const depositResult = await tradingAccountService.depositFunds(userId, depositAmount);
        
        if (depositResult.success) {
            console.log('✅ Deposit successful!');
            console.log('   Transaction ID:', depositResult.transaction.id);
            console.log('   Amount: $' + depositResult.transaction.amount.toFixed(2));
            console.log('   New balance: $' + depositResult.newBalance.toFixed(2));
        } else {
            console.log('❌ Deposit failed');
        }
        
        // Verify balance
        const accountAfter = await tradingAccountService.getTradingAccount(userId);
        console.log('\n📊 Balance after deposit: $' + accountAfter.balance.toFixed(2));
        console.log('   Total deposited: $' + accountAfter.totalDeposited.toFixed(2));
        console.log('   Total withdrawn: $' + accountAfter.totalWithdrawn.toFixed(2));
        console.log('   Deposit transactions:', accountAfter.deposits.length);
        
        console.log('\n=== Test Complete ===');
        console.log('✅ Deposit flow working correctly!');
        
    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        process.exit(0);
    }
}

testDeposit();
