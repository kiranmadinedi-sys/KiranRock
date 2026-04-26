const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');

// Create logs directory if it doesn't exist
const fs = require('fs');
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Define log format
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
);

// Daily rotate file transport for all logs
const dailyRotateFileTransport = new DailyRotateFile({
    filename: path.join(logsDir, 'application-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d', // Keep logs for 14 days
    format: logFormat
});

// Daily rotate file transport for AI trading logs
const aiTradingRotateTransport = new DailyRotateFile({
    filename: path.join(logsDir, 'ai-trading-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '30d', // Keep AI trading logs for 30 days
    format: logFormat,
    level: 'info'
});

// Daily rotate file transport for errors only
const errorRotateTransport = new DailyRotateFile({
    filename: path.join(logsDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '30d',
    format: logFormat,
    level: 'error'
});

// Create the logger
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: logFormat,
    transports: [
        dailyRotateFileTransport,
        errorRotateTransport,
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    let msg = `${timestamp} [${level}]: ${message}`;
                    if (Object.keys(meta).length > 0) {
                        msg += ` ${JSON.stringify(meta)}`;
                    }
                    return msg;
                })
            )
        })
    ]
});

// Create specialized AI trading logger
const aiTradingLogger = winston.createLogger({
    level: 'info',
    format: logFormat,
    transports: [
        aiTradingRotateTransport,
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.timestamp({ format: 'HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message, ...meta }) => {
                    let msg = `${timestamp} [AI BOT ${level}]: ${message}`;
                    if (Object.keys(meta).length > 0) {
                        msg += ` ${JSON.stringify(meta)}`;
                    }
                    return msg;
                })
            )
        })
    ]
});

// Helper methods for structured logging
logger.trade = (action, symbol, quantity, price, meta = {}) => {
    logger.info('Trade Executed', {
        type: 'TRADE',
        action,
        symbol,
        quantity,
        price,
        total: quantity * price,
        ...meta
    });
};

logger.aiDecision = (symbol, score, decision, meta = {}) => {
    aiTradingLogger.info('AI Decision', {
        type: 'AI_DECISION',
        symbol,
        score,
        decision,
        ...meta
    });
};

logger.riskEvent = (eventType, symbol, details, meta = {}) => {
    logger.warn('Risk Event', {
        type: 'RISK_EVENT',
        eventType,
        symbol,
        details,
        ...meta
    });
};

logger.performance = (metrics, meta = {}) => {
    aiTradingLogger.info('Performance Metrics', {
        type: 'PERFORMANCE',
        ...metrics,
        ...meta
    });
};

module.exports = { logger, aiTradingLogger };
