/**
 * Create weekly predictions performance tracking table
 */

const { pool } = require('./database');

async function createPerformanceTable() {
    const client = await pool.connect();
    
    try {
        console.log('📊 Creating weekly predictions performance tracking table...');
        
        // Create table
        await client.query(`
            CREATE TABLE IF NOT EXISTS weekly_prediction_history (
                id SERIAL PRIMARY KEY,
                symbol VARCHAR(10) NOT NULL,
                week_start DATE NOT NULL,
                predicted_signal VARCHAR(20) NOT NULL,
                predicted_move DECIMAL(10,2) NOT NULL,
                confidence INTEGER NOT NULL,
                total_score INTEGER NOT NULL,
                target_price DECIMAL(10,2) NOT NULL,
                current_price DECIMAL(10,2) NOT NULL,
                rationale TEXT,
                actual_move DECIMAL(10,2),
                actual_price DECIMAL(10,2),
                target_hit BOOLEAN,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(symbol, week_start)
            )
        `);
        
        // Create indexes
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_weekly_predictions_week 
            ON weekly_prediction_history(week_start DESC)
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_weekly_predictions_symbol 
            ON weekly_prediction_history(symbol)
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_weekly_predictions_target_hit 
            ON weekly_prediction_history(target_hit) 
            WHERE target_hit IS NOT NULL
        `);
        
        console.log('✅ Performance tracking table created successfully!');
        
    } catch (error) {
        console.error('❌ Error creating performance table:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run the script
createPerformanceTable()
    .then(() => {
        console.log('\n✓ Database setup complete');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Setup failed:', error);
        process.exit(1);
    });
