const { query } = require('./src/config/database');

async function checkUserAccount() {
    try {
        console.log('=== Checking User bnageshw Trading Account ===\n');
        
        const result = await query(`
            SELECT u.id, u.username, u.email, ta.balance, ta.id as account_id
            FROM users u 
            LEFT JOIN trading_accounts ta ON u.id = ta.user_id 
            WHERE u.username = $1
        `, ['bnageshw']);
        
        if (result.rows.length === 0) {
            console.log('❌ User not found');
            process.exit(1);
        }
        
        const user = result.rows[0];
        console.log('User ID:', user.id);
        console.log('Username:', user.username);
        console.log('Email:', user.email);
        console.log('Trading Account ID:', user.account_id || 'NOT CREATED');
        console.log('Balance:', user.balance ? '$' + parseFloat(user.balance).toFixed(2) : 'N/A');
        
        if (!user.account_id) {
            console.log('\n⚠️  ISSUE: No trading account found!');
            console.log('Creating trading account...');
            
            await query(`
                INSERT INTO trading_accounts (user_id, balance, created_at, updated_at)
                VALUES ($1, 0, NOW(), NOW())
            `, [user.id]);
            
            console.log('✅ Trading account created with $0 balance');
        }
        
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

checkUserAccount();
