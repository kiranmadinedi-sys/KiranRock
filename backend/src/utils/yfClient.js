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

// yahoo-finance2's crumb-fetch failure throws a plain Error with statusCode/code both
// undefined — the 429 only ever exists as text inside .message ("Failed to get crumb,
// status 429..."). withRetry below was checking err.statusCode/err.code exclusively, so
// it NEVER matched a real 429 and the shared cooldown breaker never tripped — every
// single call independently retried into an active rate-limit wall instead of any of
// them backing off for the others. Confirmed live: thousands of retries logged, zero
// "tripping shared cooldown" messages, and per-symbol scan steps stretching past half an
// hour each during this morning's catch-up scan (found 2026-08-24, right before market
// open). Falls back to matching the message text since that's the only place it exists.
function _extractStatus(err) {
    if (err && err.statusCode) return err.statusCode;
    if (err && err.code) return err.code;
    if (err && typeof err.message === 'string' && /\b429\b/.test(err.message)) return 429;
    return null;
}

// A genuine network-level Yahoo outage (not a normal per-minute rate limit) doesn't
// only show up as 429 — dataProvider.js's separate Yahoo circuit breaker (protecting
// the quote/chart path) already had to learn this the hard way (2026-08-18/20: "hard
// IP block ... persists for hours"). This file's own retry loop only ever tripped its
// shared cooldown on 429, so a sustained network-type outage (ETIMEDOUT/ECONNRESET/
// ECONNREFUSED/ENOTFOUND/generic timeout) left every symbol's quoteSummary() call
// (getDaysToEarnings, used every live cycle for every symbol) independently retrying
// into the same dead wall with no shared memory of it — confirmed 2026-08-31: the
// quote/chart path's circuit breaker was open (44 trips today, one streak of 165
// consecutive failures) while this path kept retrying blind, ballooning per-symbol
// dataGather time to 60-80s+ and directly causing live trading-cycle timeouts.
const NETWORK_ERROR_RE = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|timeout/i;
function _isNetworkOrRateLimitError(status, err) {
    if (status === 429) return true;
    if (typeof status === 'string' && NETWORK_ERROR_RE.test(status)) return true;
    return NETWORK_ERROR_RE.test(String(err?.message || ''));
}

// A Promise.race-based per-attempt timeout was tried here (2026-08-31) and reverted
// same day: Promise.race doesn't cancel the losing side, so a genuinely-hung (not
// actively-rejecting) Yahoo request kept running in the background after the race
// "gave up" on it — and withRetry immediately fired the NEXT attempt on top of the
// still-pending one. Under today's sustained outage that meant MORE concurrent
// orphaned Yahoo connections piling up per symbol, not fewer: confirmed live, the
// first candidate's dataGatherMs got WORSE after this timeout was added (191.7s vs
// 66-78s before it existed). The network-error-triggers-shared-cooldown fix directly
// above this comment (which has no such downside — it only reads existing error
// state, never leaves extra work running) stays; this file has no true timeout
// protection again until a cancellable approach (AbortController, if yahoo-finance2's
// transport supports it) is verified not to cause the same pile-up.
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
            const status = _extractStatus(err);
            if (_isNetworkOrRateLimitError(status, err)) {
                // Trip the shared breaker immediately so every OTHER in-flight or
                // future call backs off too, not just this one's own retry loop.
                // Covers both 429 (normal rate limit) and a genuine network-level
                // outage (ETIMEDOUT/ECONNRESET/ECONNREFUSED/ENOTFOUND/timeout) —
                // see _isNetworkOrRateLimitError's comment.
                _yahooRateLimitedUntil = Date.now() + YAHOO_COOLDOWN_MS;
                console.warn(`yfClient: ${status || 'network error'} — tripping shared cooldown for ${Math.round(YAHOO_COOLDOWN_MS / 1000)}s`);
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
