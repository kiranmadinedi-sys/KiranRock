const { query } = require('./src/config/database');

async function findTables() {
    try {
        const result = await query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND (table_name LIKE '%portfolio%' OR table_name LIKE '%holding%' OR table_name LIKE '%position%' OR table_name LIKE '%trade%')
            ORDER BY table_name
        `);
        
        console.log('Portfolio/Trading related tables:');
        result.rows.forEach(row => {
            console.log('  -', row.table_name);
        });
        
        // Get holdings table schema
        console.log('\nHoldings table columns:');
        const columnsResult = await query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'holdings'
            ORDER BY ordinal_position
        `);
        columnsResult.rows.forEach(col => {
            console.log('  -', col.column_name, `(${col.data_type})`);
        });
        
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

findTables();
