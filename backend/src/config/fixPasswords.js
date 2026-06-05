// Fix migrated passwords - hash plain text passwords with bcrypt
const bcrypt = require('bcrypt');
const { pool } = require('./database');

async function fixPasswords() {
    console.log('🔐 Starting password migration to bcrypt hashes...\n');
    
    const client = await pool.connect();
    
    try {
        // Get all users with plain text passwords (not starting with $2b$)
        const result = await client.query(
            "SELECT id, username, password FROM users WHERE password NOT LIKE '$2b$%'"
        );
        
        console.log(`Found ${result.rows.length} users with plain text passwords\n`);
        
        if (result.rows.length === 0) {
            console.log('✅ All passwords are already hashed!');
            return;
        }
        
        // Hash each password
        let updated = 0;
        for (const user of result.rows) {
            const hashedPassword = await bcrypt.hash(user.password, 10);
            
            await client.query(
                'UPDATE users SET password = $1 WHERE id = $2',
                [hashedPassword, user.id]
            );
            
            console.log(`✓ Updated password for user: ${user.username}`);
            updated++;
        }
        
        console.log(`\n✅ Successfully hashed ${updated} passwords!`);
        console.log('🎉 Users can now login with their original passwords');
        
    } catch (error) {
        console.error('❌ Error fixing passwords:', error);
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

// Run the fix
fixPasswords()
    .then(() => {
        console.log('\n✓ Password migration completed successfully');
        process.exit(0);
    })
    .catch((error) => {
        console.error('\n❌ Password migration failed:', error);
        process.exit(1);
    });
