/**
 * Yahoo Finance API Rate Limiter
 * Prevents 429 "Too Many Requests" errors by throttling API calls
 */

class YahooFinanceRateLimiter {
    constructor() {
        this.lastRequestTime = 0;
        this.MIN_REQUEST_INTERVAL = 500; // Minimum 500ms between requests (max 2 requests/second)
        this.requestQueue = [];
        this.isProcessing = false;
    }

    /**
     * Wait for rate limit before allowing next request
     */
    async waitForRateLimit() {
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        if (timeSinceLastRequest < this.MIN_REQUEST_INTERVAL) {
            const waitTime = this.MIN_REQUEST_INTERVAL - timeSinceLastRequest;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastRequestTime = Date.now();
    }

    /**
     * Execute a function with rate limiting
     * @param {Function} fn - Async function to execute
     * @returns {Promise} Result of the function
     */
    async execute(fn) {
        await this.waitForRateLimit();
        return await fn();
    }

    /**
     * Batch execute multiple functions with rate limiting
     * @param {Array<Function>} functions - Array of async functions to execute
     * @param {Number} batchSize - Number of concurrent requests (default: 5)
     * @returns {Promise<Array>} Results of all functions
     */
    async executeBatch(functions, batchSize = 5) {
        const results = [];
        
        // Process in batches to limit concurrency
        for (let i = 0; i < functions.length; i += batchSize) {
            const batch = functions.slice(i, i + batchSize);
            
            const batchResults = await Promise.allSettled(
                batch.map(fn => this.execute(fn))
            );
            
            results.push(...batchResults);
        }
        
        return results;
    }
}

// Singleton instance
const rateLimiter = new YahooFinanceRateLimiter();

module.exports = rateLimiter;
