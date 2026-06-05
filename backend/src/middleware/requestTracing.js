const crypto = require('crypto');
const { logger } = require('../utils/logger');

// Paths that generate too much noise if logged on every poll — sampled at 1-in-N
const LOW_PRIORITY_PATHS = new Set(['/health', '/api/health', '/api/worker/status']);
const LOG_SAMPLE_RATE    = parseInt(process.env.REQUEST_LOG_SAMPLE_RATE || '10', 10);
let _lowPriorityCounter  = 0;

function requestTracing(req, res, next) {
    // Honour upstream IDs (load balancer, frontend, test harness)
    const correlationId =
        req.headers['x-correlation-id'] ||
        req.headers['x-request-id']     ||
        crypto.randomUUID();

    req.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);

    const startHr = process.hrtime.bigint();

    res.on('finish', () => {
        // Skip noisy health-poll paths most of the time
        if (LOW_PRIORITY_PATHS.has(req.path)) {
            if (++_lowPriorityCounter % LOG_SAMPLE_RATE !== 0) return;
        }

        const durationMs = Math.round(Number(process.hrtime.bigint() - startHr) / 1e6);
        const status     = res.statusCode;
        const level      = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';

        logger[level]('HTTP', {
            correlationId,
            method:     req.method,
            path:       req.path,
            status,
            durationMs,
            userId:     req.userId || null,
            ip: req.headers['x-real-ip'] ||
                (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
                req.ip
        });
    });

    next();
}

module.exports = { requestTracing };
