const { pool } = require('./backend/src/config/database');
const fs = require('fs').promises;
const path = require('path');

/**
 * Initialize Options Trading Database
 * Creates all required tables for autonomous options trading bot
 */

async function initializeOptionsDatabase() {
    console.log('🔧 Initializing Options Trading Database...\n');
    
    try {
        // Read SQL schema
        const schemaPath = path.join(__dirname, 'backend', 'src', 'config', 'optionsSchema.sql');
        const schema = await fs.readFile(schemaPath, 'utf8');
        
        console.log('📄 Executing SQL schema...');
        
        // Execute schema (PostgreSQL handles multiple statements)
        await pool.query(schema);
        
        console.log('\n✅ Database initialization complete!\n');
        console.log('Created tables:');
        console.log('  ✓ options_trades');
        console.log('  ✓ options_performance');
        console.log('  ✓ options_watchlist');
        console.log('  ✓ options_alerts');
        console.log('  ✓ options_bot_config');
        console.log('\nCreated views:');
        console.log('  ✓ options_open_positions');
        console.log('  ✓ options_strategy_performance');
        console.log('  ✓ options_monthly_performance');
        console.log('\nCreated triggers:');
        console.log('  ✓ Auto-update timestamps');
        console.log('  ✓ Auto-calculate P/L on close');
        
        // Verify tables exist
        const verifyQuery = `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name LIKE 'options%'
            ORDER BY table_name;
        `;
        
        const result = await pool.query(verifyQuery);
        
        console.log('\n📊 Verification - Tables in database:');
        result.rows.forEach(row => {
            console.log(`  ✓ ${row.table_name}`);
        });
        
        // Check if we need to create default configs for existing users
        const usersResult = await pool.query('SELECT id, username FROM users LIMIT 10');
        
        if (usersResult.rows.length > 0) {
            console.log('\n👥 Creating default bot configs for existing users...');
            
            for (const user of usersResult.rows) {
                // Check if config already exists
                const configExists = await pool.query(
                    'SELECT id FROM options_bot_config WHERE user_id = $1',
                    [user.id]
                );
                
                if (configExists.rows.length === 0) {
                    await pool.query(
                        `INSERT INTO options_bot_config (user_id, enabled) 
                         VALUES ($1, false) 
                         ON CONFLICT (user_id) DO NOTHING`,
                        [user.id]
                    );
                    console.log(`  ✓ Created config for user: ${user.username}`);
                }
            }
        }
        
        console.log('\n✨ Options trading database is ready!');
        console.log('\n📝 Next steps:');
        console.log('1. Enable options bot for a user: POST /api/options-bot/enable');
        console.log('2. Configure settings: PUT /api/options-bot/config');
        console.log('3. Manual scan: POST /api/options-bot/manual-scan');
        console.log('4. Check status: GET /api/options-bot/status');
        
        process.exit(0);
        
    } catch (error) {
        console.error('\n❌ Error initializing database:', error);
        console.error(error.stack);
        process.exit(1);
    }
}

// Run initialization
initializeOptionsDatabase();
