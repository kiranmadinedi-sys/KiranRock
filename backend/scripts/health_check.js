/**
 * FORGE — Health Check (PANTHEON agent)
 *
 * Validates all critical KiranRock services at startup or on-demand.
 * Exits 0 on PASS, 1 on CRITICAL failure.
 * Sends a Telegram alert when any critical service is down.
 *
 * Usage:
 *   node scripts/health_check.js              # full check + Telegram on failure
 *   node scripts/health_check.js --silent     # no Telegram (CI mode)
 *   node scripts/health_check.js --json       # machine-readable JSON output
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const https  = require('https');
const http   = require('http');
const { Pool } = require('pg');

const SILENT = process.argv.includes('--silent');
const JSON_MODE = process.argv.includes('--json');

// ── colour helpers (disabled in JSON mode) ───────────────────────────────────
const c = JSON_MODE ? { green: s => s, red: s => s, yellow: s => s, bold: s => s, reset: '' }
    : {
        green:  s => `\x1b[32m${s}\x1b[0m`,
        red:    s => `\x1b[31m${s}\x1b[0m`,
        yellow: s => `\x1b[33m${s}\x1b[0m`,
        bold:   s => `\x1b[1m${s}\x1b[0m`,
    };

const PASS = c.green('PASS');
const FAIL = c.red('FAIL');
const WARN = c.yellow('WARN');

// ── check registry ────────────────────────────────────────────────────────────
const results = [];

function record(name, status, detail = '', critical = false) {
    results.push({ name, status, detail, critical });
    if (!JSON_MODE) {
        const badge = status === 'PASS' ? PASS : status === 'FAIL' ? FAIL : WARN;
        const flag  = critical && status === 'FAIL' ? c.red(' [CRITICAL]') : '';
        console.log(`  ${badge}  ${name.padEnd(35)} ${detail}${flag}`);
    }
}

// ── 1. Database ───────────────────────────────────────────────────────────────
async function checkDatabase() {
    const pool = new Pool({
        host:     process.env.DB_HOST     || 'localhost',
        port:     parseInt(process.env.DB_PORT || '5432'),
        database: process.env.DB_NAME     || 'kiranrock_trading',
        user:     process.env.DB_USER     || 'postgres',
        password: process.env.DB_PASSWORD || 'admin',
        connectionTimeoutMillis: 3000,
        max: 1,
    });
    try {
        const start  = Date.now();
        const client = await pool.connect();
        const res    = await client.query('SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = $1', ['public']);
        const ms     = Date.now() - start;
        client.release();
        await pool.end();
        const tableCount = parseInt(res.rows[0].count, 10);
        record('PostgreSQL connection', 'PASS', `${ms}ms, ${tableCount} tables`, true);

        // Check for required tables
        const pool2 = new Pool({
            host: process.env.DB_HOST || 'localhost',
            port: parseInt(process.env.DB_PORT || '5432'),
            database: process.env.DB_NAME || 'kiranrock_trading',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || 'admin',
            connectionTimeoutMillis: 3000,
            max: 1,
        });
        const c2 = await pool2.connect();
        const requiredTables = ['users', 'trades', 'holdings', 'trading_accounts', 'order_audit_log'];
        for (const tbl of requiredTables) {
            const r = await c2.query(
                `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1)`, [tbl]
            );
            const exists = r.rows[0].exists;
            record(`Table: ${tbl}`, exists ? 'PASS' : 'FAIL', exists ? 'exists' : 'MISSING', !exists);
        }
        c2.release();
        await pool2.end();
    } catch (err) {
        record('PostgreSQL connection', 'FAIL', err.message, true);
    }
}

// ── 2. API Keys ───────────────────────────────────────────────────────────────
function checkApiKeys() {
    const checks = [
        { key: 'ANTHROPIC_API_KEY', name: 'Anthropic (ORACLE/PROPHET)',  critical: false },
        { key: 'GEMINI_API_KEY',    name: 'Gemini (PULSE)',               critical: false },
        { key: 'FRED_API_KEY',      name: 'FRED (macro)',                 critical: false },
        { key: 'REDDIT_CLIENT_ID',  name: 'Reddit alt-data',              critical: false },
        { key: 'ALPACA_KEY_ID',     name: 'Alpaca broker',                critical: false },
        { key: 'TELEGRAM_BOT_TOKEN',name: 'Telegram alerts',              critical: false },
        { key: 'JWT_SECRET',        name: 'JWT auth secret',              critical: true  },
        { key: 'DB_PASSWORD',       name: 'Database password',            critical: true  },
    ];
    for (const { key, name, critical } of checks) {
        const val = process.env[key];
        if (!val || val.startsWith('your_') || val === '') {
            record(`API key: ${name}`, critical ? 'FAIL' : 'WARN', `${key} not set`, critical);
        } else {
            record(`API key: ${name}`, 'PASS', `${key} configured`);
        }
    }
}

// ── 3. Backend HTTP endpoint ──────────────────────────────────────────────────
async function checkBackendEndpoint() {
    const port = process.env.PORT || 3001;
    const url  = `http://localhost:${port}/api/health`;

    return new Promise((resolve) => {
        const req = http.get(url, { timeout: 3000 }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    record('Backend HTTP /api/health', 'PASS', `HTTP ${res.statusCode}`);
                } else {
                    record('Backend HTTP /api/health', 'WARN', `HTTP ${res.statusCode}`);
                }
                resolve();
            });
        });
        req.on('error', () => {
            record('Backend HTTP /api/health', 'WARN', `Not reachable on port ${port} (may not be started)`);
            resolve();
        });
        req.on('timeout', () => {
            req.destroy();
            record('Backend HTTP /api/health', 'WARN', 'Timed out');
            resolve();
        });
    });
}

// ── 4. External API reachability ──────────────────────────────────────────────
async function checkExternalReachability() {
    const endpoints = [
        { name: 'Yahoo Finance',  host: 'query1.finance.yahoo.com', path: '/v8/finance/chart/AAPL?range=1d&interval=1d', critical: true },
        { name: 'Anthropic API',  host: 'api.anthropic.com',        path: '/',                                            critical: false },
        { name: 'Gemini API',     host: 'generativelanguage.googleapis.com', path: '/',                                   critical: false },
    ];

    const checks = endpoints.map(({ name, host, path, critical }) =>
        new Promise((resolve) => {
            const start = Date.now();
            const req = https.get({ host, path, timeout: 4000 }, (res) => {
                const ms = Date.now() - start;
                // Any response (even 401/403) means the host is reachable
                record(`External: ${name}`, 'PASS', `${res.statusCode} in ${ms}ms`);
                res.resume();
                resolve();
            });
            req.on('error', (err) => {
                record(`External: ${name}`, critical ? 'FAIL' : 'WARN', err.message, critical);
                resolve();
            });
            req.on('timeout', () => {
                req.destroy();
                record(`External: ${name}`, critical ? 'FAIL' : 'WARN', 'Timed out', critical);
                resolve();
            });
        })
    );

    await Promise.all(checks);
}

// ── 5. Node modules ───────────────────────────────────────────────────────────
function checkNodeModules() {
    const critical = ['@anthropic-ai/sdk', 'pg', 'express', 'node-telegram-bot-api', 'yahoo-finance2'];
    const optional = ['@google/generative-ai', 'snoowrap', 'node-cron'];

    for (const mod of critical) {
        try {
            require.resolve(mod);
            record(`Module: ${mod}`, 'PASS', 'installed', false);
        } catch {
            record(`Module: ${mod}`, 'FAIL', 'NOT INSTALLED — run npm install', true);
        }
    }
    for (const mod of optional) {
        try {
            require.resolve(mod);
            record(`Module: ${mod}`, 'PASS', 'installed');
        } catch {
            record(`Module: ${mod}`, 'WARN', 'not installed (optional)');
        }
    }
}

// ── 6. SAGE data directory ────────────────────────────────────────────────────
function checkSageDirectory() {
    const fs   = require('fs');
    const path = require('path');
    const dir  = path.join(__dirname, '../data/sage');
    if (fs.existsSync(dir)) {
        record('SAGE data dir', 'PASS', dir);
    } else {
        try {
            fs.mkdirSync(dir, { recursive: true });
            record('SAGE data dir', 'PASS', `created ${dir}`);
        } catch (e) {
            record('SAGE data dir', 'WARN', `could not create: ${e.message}`);
        }
    }
}

// ── 7. AGENT_HEALTH heartbeats ────────────────────────────────────────────────
function checkAgentHealth() {
    const fs   = require('fs');
    const path = require('path');
    const file = path.join(__dirname, '../data/sage/agent_health.json');

    if (!fs.existsSync(file)) {
        record('AGENT_HEALTH file', 'WARN', 'not yet written — no trading session run since deploy');
        return;
    }

    let state;
    try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        record('AGENT_HEALTH file', 'WARN', `parse error: ${e.message}`);
        return;
    }

    record('AGENT_HEALTH file', 'PASS', `${Object.keys(state).length} agent(s) recorded`);

    const STALE = {
        ORACLE: 4 * 3600000, VISION: 4 * 3600000, PROPHET: 4 * 3600000,
        PULSE:  4 * 3600000, SHIELD: 4 * 3600000,  ARROW:   4 * 3600000,
        SAGE:  25 * 3600000, SONAR: 25 * 3600000,  FORGE:  25 * 3600000,
    };
    const now = Date.now();

    for (const [name, info] of Object.entries(state)) {
        const age       = info.lastSeen ? now - new Date(info.lastSeen).getTime() : Infinity;
        const threshold = STALE[name] || 25 * 3600000;
        const ageH      = (age / 3600000).toFixed(1);
        if (age > threshold) {
            record(`Agent: ${name}`, 'WARN', `last seen ${ageH}h ago (${info.status || '?'})`);
        } else {
            record(`Agent: ${name}`, 'PASS', `${ageH}h ago — ${info.status || 'OK'}`);
        }
    }
}

// ── Telegram alert ────────────────────────────────────────────────────────────
async function sendTelegramAlert(failures) {
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId || SILENT) return;

    const lines = failures.map(f => `• ${f.name}: ${f.detail}`).join('\n');
    const text  = `🔴 FORGE Health Check FAILED\n\n${lines}\n\nHost: ${require('os').hostname()}\n${new Date().toISOString()}`;

    const body = JSON.stringify({ chat_id: chatId, text });
    return new Promise((resolve) => {
        const req = https.request({
            hostname: 'api.telegram.org',
            path:     `/bot${token}/sendMessage`,
            method:   'POST',
            headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout:  5000,
        }, (res) => { res.resume(); resolve(); });
        req.on('error', resolve);
        req.on('timeout', () => { req.destroy(); resolve(); });
        req.write(body);
        req.end();
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
    if (!JSON_MODE) {
        console.log(c.bold('\n╔══════════════════════════════════════════════╗'));
        console.log(c.bold('║  FORGE — KiranRock Health Check               ║'));
        console.log(c.bold('╚══════════════════════════════════════════════╝\n'));
        console.log(c.bold('Database'));
    }
    await checkDatabase();

    if (!JSON_MODE) console.log(c.bold('\nAPI Keys'));
    checkApiKeys();

    if (!JSON_MODE) console.log(c.bold('\nNode Modules'));
    checkNodeModules();

    if (!JSON_MODE) console.log(c.bold('\nExternal Reachability'));
    await checkExternalReachability();

    if (!JSON_MODE) console.log(c.bold('\nBackend Service'));
    await checkBackendEndpoint();

    if (!JSON_MODE) console.log(c.bold('\nStorage'));
    checkSageDirectory();

    if (!JSON_MODE) console.log(c.bold('\nAgent Heartbeats'));
    checkAgentHealth();

    // ── Summary ───────────────────────────────────────────────────────────────
    const criticalFails  = results.filter(r => r.status === 'FAIL' && r.critical);
    const allFails       = results.filter(r => r.status === 'FAIL');
    const warns          = results.filter(r => r.status === 'WARN');
    const passes         = results.filter(r => r.status === 'PASS');
    const overall        = criticalFails.length > 0 ? 'FAIL' : (allFails.length > 0 ? 'FAIL' : 'PASS');

    if (JSON_MODE) {
        console.log(JSON.stringify({ overall, results, timestamp: new Date().toISOString() }, null, 2));
    } else {
        console.log('\n' + c.bold('─'.repeat(50)));
        console.log(`  Overall:  ${overall === 'PASS' ? PASS : FAIL}`);
        console.log(`  Checks:   ${passes.length} passed, ${warns.length} warnings, ${allFails.length} failed`);
        if (criticalFails.length > 0) {
            console.log(c.red(`\n  ${criticalFails.length} CRITICAL failure(s):`));
            criticalFails.forEach(f => console.log(c.red(`    • ${f.name}: ${f.detail}`)));
        }
        console.log('');
    }

    if (criticalFails.length > 0) {
        await sendTelegramAlert(criticalFails);
    }

    process.exit(overall === 'PASS' ? 0 : 1);
})();
