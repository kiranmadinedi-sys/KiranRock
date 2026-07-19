const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance();

// Simple in-memory cache: Map key -> { value, expiresAt }
const cache = new Map();

const defaultTTL = 1000 * 60 * 5; // 5 minutes

function isTruthyEnv(value) {
    if (value == null) return false;
    const normalized = String(value).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

// Redis optional
let redisClient = null;
let redisConnectPromise = null;
let usingRedis = false;
const redisExplicitlyEnabled = isTruthyEnv(process.env.REDIS_ENABLED);
const redisUrl = process.env.REDIS_URL;
const shouldUseRedis = redisExplicitlyEnabled || Boolean(redisUrl);

if (shouldUseRedis) {
    try {
        const { createClient } = require('redis');
        redisClient = createClient({ url: redisUrl || 'redis://127.0.0.1:6379' });
        redisConnectPromise = redisClient.connect().then(() => {
            usingRedis = true;
            console.log('yfClient: connected to Redis cache');
        }).catch((err) => {
            console.warn('yfClient: Redis connect failed, falling back to file cache', err && err.message);
            redisClient = null;
            usingRedis = false;
        });
    } catch (e) {
        // redis not installed or not available - will use file cache
        redisClient = null;
        usingRedis = false;
    }
}

// File cache fallback directory
const fileCacheDir = path.join(__dirname, '..', '..', '.yfcache');
if (!usingRedis) {
    try {
        if (!fs.existsSync(fileCacheDir)) fs.mkdirSync(fileCacheDir, { recursive: true });
    } catch (e) {
        // ignore
    }
}

// If Redis client isn't available or couldn't connect, provide a lightweight
// in-process redis-like shim that uses the file cache. This lets the rest of
// the code treat it like Redis (get/setEx) without requiring a real server.
if (!usingRedis) {
    redisClient = {
        get: async (key) => {
            try {
                const filename = crypto.createHash('sha1').update(key).digest('hex') + '.json';
                const fp = path.join(fileCacheDir, filename);
                if (!fs.existsSync(fp)) return null;
                const raw = await fs.promises.readFile(fp, 'utf8');
                return raw; // return string like real redis
            } catch (e) {
                return null;
            }
        },
        setEx: async (key, ttlSeconds, valueStr) => {
            try {
                const filename = crypto.createHash('sha1').update(key).digest('hex') + '.json';
                const fp = path.join(fileCacheDir, filename);
                // valueStr is expected to be a JSON string containing {value, expiresAt}
                await fs.promises.writeFile(fp, valueStr, 'utf8');
                return 'OK';
            } catch (e) {
                throw e;
            }
        }
    };
    usingRedis = true; // pretend we have redis so cache code uses redisClient shim
}

async function sleep(ms) {
    return new Promise((res) => setTimeout(res, ms));
}

// Shared rate-limit cooldown — Yahoo's 429 is IP-wide, not per-symbol, but the
// per-call retry loop below has no memory of it. During a nightly scan (500+
// symbols) or a targeted rescan, one symbol getting rate-limited previously
// meant every subsequent symbol independently burned through its own 4-attempt
// backoff against the same still-active block — confirmed 2026-07-18 rescanning
// 130 symbols: 100% still failed, 779 "Too Many Requests" logged, because
// nothing ever told later calls that Yahoo was already blocking this IP.
// Once tripped, calls fail fast instead of retrying into a wall.
let _yahooRateLimitedUntil = 0;
const YAHOO_COOLDOWN_MS = Math.max(5000, parseInt(process.env.YAHOO_RATE_LIMIT_COOLDOWN_MS || '60000', 10));

function isYahooRateLimited() {
    return Date.now() < _yahooRateLimitedUntil;
}

async function withRetry(fn, args = [], opts = {}) {
    const maxAttempts = opts.maxAttempts || 4;
    const baseDelay = opts.baseDelay || 300; // ms

    if (isYahooRateLimited()) {
        const waitSec = Math.ceil((_yahooRateLimitedUntil - Date.now()) / 1000);
        const err = new Error(`Yahoo rate-limit cooldown active — skipping (retry in ${waitSec}s)`);
        err.statusCode = 429;
        err.isCooldownSkip = true;
        throw err;
    }

    let attempt = 0;
    while (attempt < maxAttempts) {
        try {
            return await fn(...args);
        } catch (err) {
            attempt++;
            const status = err && err.statusCode ? err.statusCode : err && err.code ? err.code : null;
            if (status === 429) {
                // Trip the shared breaker immediately so every OTHER in-flight or
                // future call backs off too, not just this one's own retry loop.
                _yahooRateLimitedUntil = Date.now() + YAHOO_COOLDOWN_MS;
                console.warn(`yfClient: 429 rate-limited — tripping shared cooldown for ${Math.round(YAHOO_COOLDOWN_MS / 1000)}s`);
            }
            // On 429 or network errors, retry with exponential backoff
            if (attempt >= maxAttempts || (status && status !== 429 && status !== 'ECONNRESET')) {
                throw err;
            }
            const delay = baseDelay * Math.pow(2, attempt - 1) + Math.floor(Math.random() * baseDelay);
            console.warn(`yfClient: attempt ${attempt} failed (${err && err.message}), retrying in ${delay}ms`);
            await sleep(delay);
        }
    }
}

async function cacheGet(key) {
    // fast in-memory check
    const mem = cache.get(key);
    if (mem && Date.now() <= mem.expiresAt) return mem.value;
    if (usingRedis && redisClient) {
        try {
            if (redisConnectPromise) await redisConnectPromise;
            const raw = await redisClient.get(key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (Date.now() > parsed.expiresAt) return null;
            // prime memory cache
            cache.set(key, { value: parsed.value, expiresAt: parsed.expiresAt });
            return parsed.value;
        } catch (e) {
            console.warn('yfClient: redis get failed, falling back to file cache', e && e.message);
        }
    }

    // file cache fallback
    try {
        const filename = crypto.createHash('sha1').update(key).digest('hex') + '.json';
        const fp = path.join(fileCacheDir, filename);
        if (!fs.existsSync(fp)) return null;
        const raw = await fs.promises.readFile(fp, 'utf8');
        const parsed = JSON.parse(raw);
        if (Date.now() > parsed.expiresAt) {
            try { await fs.promises.unlink(fp); } catch (e) {}
            return null;
        }
        cache.set(key, { value: parsed.value, expiresAt: parsed.expiresAt });
        return parsed.value;
    } catch (e) {
        return null;
    }
}

async function cacheSet(key, value, ttl = defaultTTL) {
    const expiresAt = Date.now() + ttl;
    // set memory cache
    try {
        cache.set(key, { value, expiresAt });
    } catch (e) {
        // ignore
    }

    if (usingRedis && redisClient) {
        try {
            if (redisConnectPromise) await redisConnectPromise;
            // store value with TTL seconds
            await redisClient.setEx(key, Math.ceil(ttl / 1000), JSON.stringify({ value, expiresAt }));
            return;
        } catch (e) {
            console.warn('yfClient: redis set failed, falling back to file cache', e && e.message);
        }
    }

    // file cache fallback
    try {
        const filename = crypto.createHash('sha1').update(key).digest('hex') + '.json';
        const fp = path.join(fileCacheDir, filename);
        await fs.promises.writeFile(fp, JSON.stringify({ value, expiresAt }), 'utf8');
    } catch (e) {
        // ignore
    }
}

async function search(symbol, opts = {}) {
    const key = `search:${symbol}:${JSON.stringify(opts)}`;
    const cached = await cacheGet(key);
    if (cached) return cached;

    const { ttl, ...providerOpts } = opts || {};
    const res = await withRetry(yf.search.bind(yf), [symbol, providerOpts], { maxAttempts: 4 });
    await cacheSet(key, res, ttl || defaultTTL);
    return res;
}

async function quoteSummary(symbol, opts = {}) {
    const key = `quoteSummary:${symbol}:${JSON.stringify(opts)}`;
    const cached = await cacheGet(key);
    if (cached) return cached;

    const { ttl, ...providerOpts } = opts || {};
    const fn = yf.quoteSummary.bind(yf);
    const res = await withRetry(fn, [symbol, providerOpts], { maxAttempts: 4 });
    await cacheSet(key, res, ttl || defaultTTL);
    return res;
}

async function quote(symbol, opts = {}) {
    // When DATA_PROVIDER is not yahoo, route through the active data provider
    // so all callers automatically get real-time prices (Alpaca/Polygon).
    const provider = (process.env.DATA_PROVIDER || 'yahoo').toLowerCase();
    if (provider !== 'yahoo') {
        try {
            const dataProvider = require('./dataProviderBridge');
            const q = await dataProvider.getQuote(symbol);
            // Normalise to yahoo-finance2 shape so all callers need no changes
            return {
                symbol:                     q.symbol,
                regularMarketPrice:         q.price,
                regularMarketChange:        q.change,
                regularMarketChangePercent: q.changePercent,
                regularMarketVolume:        q.volume,
                averageDailyVolume10Day:    q.avgVolume,
                marketCap:                  q.marketCap || 0,
                fiftyTwoWeekHigh:           q.high52w   || q.price,
                fiftyTwoWeekLow:            q.low52w    || q.price,
                sector:                     q.sector    || null,
                exchange:                   q.exchange  || null,
                // pre/post market — not available from Alpaca, use regular price
                preMarketPrice:  null,
                postMarketPrice: null
            };
        } catch (e) {
            // fall through to Yahoo if bridge fails
            console.warn(`yfClient: dataProvider bridge failed for ${symbol}, falling back to Yahoo: ${e.message}`);
        }
    }
    const key = `quote:${symbol}`;
    const cached = await cacheGet(key);
    if (cached) return cached;
    const { ttl, ...providerOpts } = opts || {};
    const res = await withRetry(yf.quote.bind(yf), [symbol, providerOpts], { maxAttempts: 3 });
    await cacheSet(key, res, ttl || 1000 * 30);
    return res;
}

module.exports = {
    search,
    quoteSummary,
    quote,
    isYahooRateLimited,
    // expose low-level yf for rare cases
    _raw: yf,
    _cache: cache,
    _usingRedis: usingRedis
};

// Add a small helper to expose cache TTLs for debugging
module.exports._defaultTTL = defaultTTL;
