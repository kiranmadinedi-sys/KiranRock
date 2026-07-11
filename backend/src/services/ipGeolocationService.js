/**
 * IP Geolocation — city/region/country lookup for the admin users overview (2026-07-11).
 * This is approximate location from IP registration data, NOT a precise street address —
 * that information doesn't exist anywhere in this system and isn't something to try to
 * obtain. Uses ip-api.com's free tier (no key required, 45 req/min limit), which is far
 * more than this app's handful of users will ever need. Results are cached indefinitely
 * per IP in memory — an IP's registered location essentially never changes.
 */
const axios = require('axios');
const { logger } = require('../utils/logger');

const _cache = new Map(); // ip -> { city, region, country, isp, fetchedAt }

const PRIVATE_IP_PATTERNS = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^::1$/, /^localhost$/i];

function isPrivateIp(ip) {
    return !ip || PRIVATE_IP_PATTERNS.some(p => p.test(ip));
}

async function getLocationForIp(ip) {
    if (isPrivateIp(ip)) {
        return { city: null, region: null, country: null, isp: null, note: 'local/private IP — no public geolocation' };
    }

    const cached = _cache.get(ip);
    if (cached) return cached;

    try {
        const resp = await axios.get(`http://ip-api.com/json/${encodeURIComponent(ip)}`, {
            params: { fields: 'status,message,country,regionName,city,isp' },
            timeout: 5000
        });
        const d = resp.data || {};
        const result = d.status === 'success'
            ? { city: d.city || null, region: d.regionName || null, country: d.country || null, isp: d.isp || null }
            : { city: null, region: null, country: null, isp: null, note: d.message || 'lookup failed' };
        _cache.set(ip, result);
        return result;
    } catch (err) {
        logger.debug('[IPGeolocation] Lookup failed', { ip, error: err.message });
        return { city: null, region: null, country: null, isp: null, note: 'lookup error' };
    }
}

module.exports = { getLocationForIp };
