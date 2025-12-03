/**
 * Simple in-memory cache service for stock data and signals.
 * This reduces redundant API calls and improves performance.
 */

class CacheService {
    constructor() {
        this.cache = new Map();
        this.ttl = 5 * 60 * 1000; // 5 minutes default TTL
    }

    /**
     * Sets a value in cache with TTL.
     * @param {string} key - Cache key
     * @param {*} value - Value to cache
     * @param {number} customTTL - Custom TTL in milliseconds (optional)
     */
    set(key, value, customTTL = null) {
        const expiry = Date.now() + (customTTL || this.ttl);
        this.cache.set(key, { value, expiry });
    }

    /**
     * Gets a value from cache if not expired.
     * @param {string} key - Cache key
     * @returns {*} Cached value or null if expired/not found
     */
    get(key) {
        const cached = this.cache.get(key);
        
        if (!cached) {
            return null;
        }

        if (Date.now() > cached.expiry) {
            this.cache.delete(key);
            return null;
        }

        return cached.value;
    }

    /**
     * Checks if a key exists and is not expired.
     * @param {string} key - Cache key
     * @returns {boolean}
     */
    has(key) {
        return this.get(key) !== null;
    }

    /**
     * Deletes a specific key from cache.
     * @param {string} key - Cache key
     */
    delete(key) {
        this.cache.delete(key);
    }

    /**
     * Clears all cache entries.
     */
    clear() {
        this.cache.clear();
    }

    /**
     * Clears expired entries from cache.
     */
    clearExpired() {
        const now = Date.now();
        for (const [key, data] of this.cache.entries()) {
            if (now > data.expiry) {
                this.cache.delete(key);
            }
        }
    }

    /**
     * Gets cache statistics.
     * @returns {Object} Cache stats
     */
    getStats() {
        const now = Date.now();
        let validEntries = 0;
        let expiredEntries = 0;

        for (const [, data] of this.cache.entries()) {
            if (now > data.expiry) {
                expiredEntries++;
            } else {
                validEntries++;
            }
        }

        return {
            totalEntries: this.cache.size,
            validEntries,
            expiredEntries,
            hitRate: this.hitRate || 0
        };
    }

    /**
     * Wrapper to cache async function results.
     * @param {string} key - Cache key
     * @param {Function} fn - Async function to execute if cache miss
     * @param {number} customTTL - Custom TTL (optional)
     * @returns {Promise<*>} Cached or fresh value
     */
    async getOrSet(key, fn, customTTL = null) {
        const cached = this.get(key);
        
        if (cached !== null) {
            console.log(`[Cache] HIT: ${key}`);
            return cached;
        }

        console.log(`[Cache] MISS: ${key}`);
        const value = await fn();
        this.set(key, value, customTTL);
        return value;
    }
}

// Create singleton instance
const cacheService = new CacheService();

// Auto-cleanup expired entries every 10 minutes
setInterval(() => {
    cacheService.clearExpired();
    console.log('[Cache] Cleanup completed:', cacheService.getStats());
}, 10 * 60 * 1000);

module.exports = cacheService;
