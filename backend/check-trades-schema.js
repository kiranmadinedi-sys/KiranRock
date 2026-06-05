const { query } = require('./src/config/database');

async function checkSchema() {
    try {
        // Check trades table schema
        const result = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'trades' 
            ORDER BY ordinal_position
        `);
        
        console.log('\nTrades table columns:');
        result.rows.forEach(col => {
            console.log(`  ${col.column_name}: ${col.data_type}`);
        });
        
    } catch (error) {
        console.error('Error:', error);
    } finally {
        process.exit(0);
    }
}

checkSchema();
