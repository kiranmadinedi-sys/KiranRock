const { query } = require('./src/config/database');

async function listAllTables() {
    try {
        console.log('=== PostgreSQL Database Tables ===\n');
        
        const result = await query(`
            SELECT table_name, 
                   (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = t.table_name) as column_count
            FROM information_schema.tables t
            WHERE table_schema = 'public'
            ORDER BY table_name
        `);
        
        console.log(`Total Tables: ${result.rows.length}\n`);
        
        result.rows.forEach((table, index) => {
            console.log(`${index + 1}. ${table.table_name} (${table.column_count} columns)`);
        });
        
        console.log('\n' + '='.repeat(50));
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

listAllTables();
