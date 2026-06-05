#!/usr/bin/env node
/**
 * QUICK START SCRIPT
 * Validates all enhancements are ready
 */

const fs = require('fs');
const path = require('path');

console.log('\n╔═══════════════════════════════════════════════════╗');
console.log('║    AI Trading Bot Enhancements - Quick Start    ║');
console.log('╚═══════════════════════════════════════════════════╝\n');

const checks = [];

// Check 1: Winston installed
try {
    require('winston');
    checks.push({ name: 'Winston logging library', status: '✅' });
} catch (e) {
    checks.push({ name: 'Winston logging library', status: '❌ Run: npm install winston winston-daily-rotate-file' });
}

// Check 2: Logger exists
const loggerPath = path.join(__dirname, 'src', 'utils', 'logger.js');
checks.push({ 
    name: 'Logger utility (logger.js)', 
    status: fs.existsSync(loggerPath) ? '✅' : '❌' 
});

// Check 3: Telegram alert service exists
const alertPath = path.join(__dirname, 'src', 'services', 'telegramAlertService.js');
checks.push({ 
    name: 'Telegram alert service', 
    status: fs.existsSync(alertPath) ? '✅' : '❌' 
});

// Check 4: Performance metrics service exists
const perfPath = path.join(__dirname, 'src', 'services', 'performanceMetricsService.js');
checks.push({ 
    name: 'Performance metrics service', 
    status: fs.existsSync(perfPath) ? '✅' : '❌' 
});

// Check 5: Technical indicators enhanced
const indicatorsPath = path.join(__dirname, 'src', 'services', 'technicalIndicators.js');
if (fs.existsSync(indicatorsPath)) {
    const content = fs.readFileSync(indicatorsPath, 'utf8');
    const hasNew = content.includes('calculateSimpleRSI') && content.includes('interpretRSI');
    checks.push({ 
        name: 'Technical indicators enhanced', 
        status: hasNew ? '✅' : '⚠️  Missing new functions' 
    });
} else {
    checks.push({ name: 'Technical indicators enhanced', status: '❌' });
}

// Check 6: Backup exists
const botPath = path.join(__dirname, 'src', 'services', 'enhancedAITradingBot.js');
const backupPath = botPath.replace('.js', '.backup.js');
checks.push({ 
    name: 'Backup of trading bot', 
    status: fs.existsSync(backupPath) ? '✅' : '⚠️  No backup' 
});

// Check 7: Logs directory
const logsPath = path.join(__dirname, 'logs');
checks.push({ 
    name: 'Logs directory', 
    status: fs.existsSync(logsPath) ? '✅' : '⚠️  Will be created on first log' 
});

// Check 8: Test script exists
const testPath = path.join(__dirname, 'test-enhancements.js');
checks.push({ 
    name: 'Test suite (test-enhancements.js)', 
    status: fs.existsSync(testPath) ? '✅' : '❌' 
});

// Check 9: Integration helper exists
const integratePath = path.join(__dirname, 'integrate-enhancements.js');
checks.push({ 
    name: 'Integration helper', 
    status: fs.existsSync(integratePath) ? '✅' : '❌' 
});

// Print results
console.log('INFRASTRUCTURE STATUS:');
console.log('─────────────────────────────────────────────────────\n');
checks.forEach(check => {
    console.log(`${check.status}  ${check.name}`);
});

// Count status
const ready = checks.filter(c => c.status === '✅').length;
const total = checks.length;
const percentage = Math.round((ready / total) * 100);

console.log('\n─────────────────────────────────────────────────────');
console.log(`Status: ${ready}/${total} checks passed (${percentage}%)\n`);

if (percentage === 100) {
    console.log('🎉 ALL SYSTEMS READY!\n');
    console.log('NEXT STEPS:');
    console.log('─────────────────────────────────────────────────────');
    console.log('1. Run tests:');
    console.log('   node test-enhancements.js\n');
    console.log('2. View integration guide:');
    console.log('   node integrate-enhancements.js\n');
    console.log('3. Read full documentation:');
    console.log('   AI_BOT_ENHANCEMENTS.md\n');
    console.log('4. Quick summary:');
    console.log('   ENHANCEMENT_SUMMARY.md\n');
} else if (percentage >= 80) {
    console.log('⚠️  ALMOST READY - Minor issues\n');
    console.log('Run: node test-enhancements.js\n');
} else {
    console.log('❌ SETUP INCOMPLETE\n');
    console.log('Some files are missing. Please check the error messages above.\n');
}

console.log('═════════════════════════════════════════════════════\n');

// Database check (async)
console.log('CHECKING DATABASE...\n');
const { query } = require('./src/config/database');

query(`
    SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'ai_performance_metrics'
    ) as table_exists
`).then(result => {
    const exists = result.rows[0].table_exists;
    
    if (exists) {
        console.log('✅ ai_performance_metrics table exists');
        
        // Check record count
        return query('SELECT COUNT(*) FROM ai_performance_metrics');
    } else {
        console.log('⚠️  ai_performance_metrics table not initialized');
        console.log('\nTo initialize:');
        console.log('node -e "require(\'./src/services/performanceMetricsService\').initializePerformanceTable()"');
        process.exit(0);
    }
}).then(result => {
    if (result) {
        const count = parseInt(result.rows[0].count);
        console.log(`✅ ${count} performance record(s) in database`);
    }
    
    console.log('\n─────────────────────────────────────────────────────');
    console.log('✓ Database check complete\n');
    
    console.log('🚀 READY TO INTEGRATE ENHANCEMENTS!\n');
    console.log('Run: node integrate-enhancements.js\n');
    
    process.exit(0);
}).catch(error => {
    console.log('❌ Database connection error:', error.message);
    console.log('\nMake sure PostgreSQL is running and connection details are correct.\n');
    process.exit(1);
});
