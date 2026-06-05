require('./bootstrapRuntime');

const stockSignalTelegramScheduler = require('./services/stockSignalTelegramScheduler');
const { pool } = require('./config/database');

function parseArgs(argv) {
    const options = {
        manual: true,
        dryRun: false,
        username: null
    };

    for (const arg of argv) {
        if (arg === '--dry-run') {
            options.dryRun = true;
            continue;
        }

        if (arg.startsWith('--user=')) {
            options.username = arg.slice('--user='.length) || null;
        }
    }

    return options;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const result = await stockSignalTelegramScheduler.runSignalCycle(options);
    console.log(JSON.stringify(result, null, 2));
}

main()
    .then(async () => {
        await pool.end();
        process.exit(0);
    })
    .catch(async (error) => {
        console.error('[Stock Signal Cycle] Failed:', error);
        try {
            await pool.end();
        } catch (_) {
            // ignore cleanup error
        }
        process.exit(1);
    });