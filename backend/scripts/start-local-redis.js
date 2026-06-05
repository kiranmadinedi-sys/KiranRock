// Small helper to start a local Redis server via the `redis-server` npm package
// Usage: node backend/scripts/start-local-redis.js

async function start() {
    try {
        const RedisServer = require('redis-server');
        const port = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;
        const server = new RedisServer(port);

        server.open((err) => {
            if (err) {
                console.error('Failed to start local redis-server:', err && err.message ? err.message : err);
                process.exit(1);
            }
            console.log(`Local redis-server started on port ${port}`);
        });

        // Keep process alive
        process.on('SIGINT', async () => {
            try { await server.close(); } catch (e) {}
            process.exit(0);
        });

    } catch (e) {
        console.error('redis-server package not available or failed to start:', e && e.message ? e.message : e);
        process.exit(1);
    }
}

if (require.main === module) start();
