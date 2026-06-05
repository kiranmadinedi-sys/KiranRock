function buildHealthResponse({
    dbOk,
    workerStatus,
    reportSnapshot = null,
    reportScheduler = null,
    uptimeSeconds,
    timestamp = new Date().toISOString(),
    env = process.env
}) {
    const normalizedWorkerStatus = workerStatus || {
        present: false,
        healthy: false,
        status: 'unknown'
    };

    const status = dbOk
        ? (normalizedWorkerStatus.healthy || !normalizedWorkerStatus.present ? 'ok' : 'degraded')
        : 'degraded';

    return {
        httpStatus: dbOk ? 200 : 503,
        body: {
            status,
            timestamp,
            uptime: Math.round(uptimeSeconds),
            db: dbOk ? 'connected' : 'unreachable',
            broker: env.BROKER || 'simulated',
            provider: env.DATA_PROVIDER || 'yahoo',
            botEnabled: env.BOT_ENABLED !== 'false',
            reportSnapshot,
            reportScheduler,
            worker: normalizedWorkerStatus
        }
    };
}

module.exports = {
    buildHealthResponse
};