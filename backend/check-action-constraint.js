const { query } = require('./src/config/database');

async function checkConstraint() {
    try {
        const result = await query(`
            SELECT pg_get_constraintdef(oid) as definition 
            FROM pg_constraint 
            WHERE conname = 'trades_action_check'
        `);
        
        console.log('\nCheck constraint definition:');
        console.log(result.rows[0].definition);
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        process.exit(0);
    }
}

checkConstraint();
