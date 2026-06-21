/**
 * SEC EDGAR Connector — Form 4 Insider Transactions + Form 8-K Material Events
 *
 * Fetches legally-disclosed insider buy/sell data and material-event 8-K filings
 * directly from the US Securities and Exchange Commission EDGAR database.
 * No API key required.  Free, official source.
 *
 * Data flow (Form 4):
 *   1. company_tickers.json  — ticker → CIK mapping (cached 24h)
 *   2. /submissions/CIK*.json — list of recent Form 4 filings for a CIK
 *   3. /Archives/edgar/data/…/form4.xml — individual transaction XML (parsed via regex)
 *
 * Data flow (Form 8-K):
 *   1. company_tickers.json  — same CIK mapping
 *   2. /submissions/CIK*.json — filings array includes an `items` field for 8-K
 *      listing space-separated item numbers (e.g. "1.01 5.02 9.01")
 *
 * SEC rate-limit guidance: ≤10 req/sec, identify yourself via User-Agent.
 * We cap at ~5 req/sec (200 ms gap) to stay well within limits.
 *
 * Returned Form 4 transaction shape (Finnhub-compatible):
 *   { change, price, transactionCode, filingDate, insiderName, insiderTitle,
 *     isOfficer, isDirector, dollarValue }
 *
 * Returned Form 8-K shape:
 *   { filingDate: string, items: string[] }  e.g. items: ['1.01', '5.02', '9.01']
 */

const { logger } = require('../utils/logger');
const cacheService = require('../services/cacheService');

const UA          = 'KiranRock-TradingBot kiranmadinedi@gmail.com';
const EDGAR_BASE  = 'https://data.sec.gov';
const ARCHIVE     = 'https://www.sec.gov/Archives/edgar/data';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

const CIK_CACHE_TTL     = 24 * 60 * 60 * 1000;  // 24 h — tickers rarely change
const INSIDER_CACHE_TTL =  6 * 60 * 60 * 1000;  //  6 h — enough freshness intraday
const FORM8K_CACHE_TTL  = 12 * 60 * 60 * 1000;  // 12 h — 8-K filings are infrequent
const MAX_FILINGS       = 8;                      // Form 4 filings to parse per symbol
const MAX_8K_FILINGS    = 6;                      // 8-K filings to inspect per symbol
const REQUEST_GAP_MS    = 220;                    // ~4.5 req/sec — comfortably under SEC limit
const FORM8K_LOOKBACK_D = 90;                     // days to look back for 8-K signals

let _tikMap     = null;   // { AAPL: '0000320193', ... }
let _tikLoaded  = 0;

// ── Helpers ────────────────────────────────────────────────────────────────────

async function _get(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function _getText(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
}

function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ── CIK lookup ─────────────────────────────────────────────────────────────────

async function _loadTickerMap() {
    const now = Date.now();
    if (_tikMap && now - _tikLoaded < CIK_CACHE_TTL) return _tikMap;

    const raw  = await _get(TICKERS_URL);
    const map  = {};
    for (const entry of Object.values(raw)) {
        map[entry.ticker.toUpperCase()] = String(entry.cik_str).padStart(10, '0');
    }
    _tikMap    = map;
    _tikLoaded = now;
    return map;
}

async function getCik(symbol) {
    const map = await _loadTickerMap();
    return map[symbol.toUpperCase()] ?? null;
}

// ── Form 4 XML parsing (regex — no external XML library needed) ────────────────

function _extract(xml, tag) {
    return xml.match(new RegExp(`<${tag}>[\\s\\S]*?<value>([\\d.]+)<\\/value>`))?.[1] ?? null;
}

function _extractText(xml, tag) {
    return xml.match(new RegExp(`<${tag}>(.*?)<\\/${tag}>`))?.[1]?.trim() ?? null;
}

function _parseForm4(xml) {
    const txs = [];

    // Reporter metadata (same for every transaction in the filing)
    const insiderName  = _extractText(xml, 'rptOwnerName') ?? '';
    const officerTitle = _extractText(xml, 'officerTitle')  ?? '';
    const isOfficer    = xml.includes('<isOfficer>1</isOfficer>');
    const isDirector   = xml.includes('<isDirector>1</isDirector>');
    const isTenPct     = xml.includes('<isTenPercentOwner>1</isTenPercentOwner>');

    // Non-derivative (stock) transactions — the ones we care about
    const ndRx = /<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/g;
    let m;
    while ((m = ndRx.exec(xml)) !== null) {
        const chunk  = m[1];
        const code   = _extractText(chunk, 'transactionCode') ?? '';
        const shares = parseFloat(_extract(chunk, 'transactionShares'))   || 0;
        const price  = parseFloat(_extract(chunk, 'transactionPricePerShare')) || 0;

        // Skip option exercises (M), gifts (G), inheritances (W), plan contributions (A)
        // We want open-market buys (P) and sells (S) and disposals (D)
        if (!code || shares === 0) continue;

        txs.push({
            change:        code === 'S' || code === 'D' ? -shares : shares,
            price,
            transactionCode: code,
            insiderName,
            insiderTitle: officerTitle,
            isOfficer,
            isDirector,
            isTenPct,
            dollarValue: shares * price
        });
    }

    return txs;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Returns insider transactions for a ticker from the last 6 months.
 * Results are cached for 6 hours per symbol.
 *
 * @param {string} symbol
 * @returns {Promise<Array<{change,price,transactionCode,filingDate,insiderName,
 *                          insiderTitle,isOfficer,isDirector,dollarValue}>>}
 */
async function getInsiderTransactions(symbol) {
    const cacheKey = `edgar_insider_${symbol}`;
    const cached   = cacheService.get(cacheKey);
    if (cached !== null) return cached;

    try {
        const cik = await getCik(symbol);
        if (!cik) {
            logger.debug(`[SECEdgar] No CIK for ${symbol}`);
            return [];
        }

        // Fetch submission list
        const sub    = await _get(`${EDGAR_BASE}/submissions/CIK${cik}.json`);
        const recent = sub.filings?.recent ?? {};
        const forms  = recent.form         ?? [];
        const dates  = recent.filingDate   ?? [];
        const accNos = recent.accessionNumber ?? [];

        // Filter to Form 4 filings within last 6 months
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - 6);

        const primaryDocs = recent.primaryDocument ?? [];

        const form4s = forms
            .map((f, i) => ({ form: f, date: dates[i], acc: accNos[i], doc: primaryDocs[i] ?? '' }))
            .filter(x => x.form === '4' && x.date && new Date(x.date) >= cutoff)
            .slice(0, MAX_FILINGS);

        if (!form4s.length) {
            cacheService.set(cacheKey, [], INSIDER_CACHE_TTL);
            return [];
        }

        const allTxs = [];

        for (const filing of form4s) {
            try {
                await _sleep(REQUEST_GAP_MS);
                const acc      = filing.acc.replace(/-/g, '');
                // Some filers use non-standard names (e.g. wk-form4_*.xml via XSLT wrapper).
                // primaryDocument may include a subdirectory prefix like "xslF345X06/" — strip it.
                const filename = filing.doc ? filing.doc.split('/').pop() : 'form4.xml';
                const xmlUrl   = `${ARCHIVE}/${parseInt(cik)}/${acc}/${filename}`;
                const xml   = await _getText(xmlUrl);
                const txs   = _parseForm4(xml);

                for (const tx of txs) {
                    allTxs.push({ ...tx, filingDate: filing.date });
                }
            } catch (fErr) {
                // skip this filing — don't abort the whole symbol
            }
        }

        logger.info(`[SECEdgar] ${symbol}: ${allTxs.length} insider txs from ${form4s.length} Form 4 filings`);
        cacheService.set(cacheKey, allTxs, INSIDER_CACHE_TTL);
        return allTxs;

    } catch (err) {
        logger.warn(`[SECEdgar] Failed for ${symbol}: ${err.message}`);
        return [];
    }
}

// ── Form 8-K ──────────────────────────────────────────────────────────────────

/**
 * Returns recent 8-K filings for a ticker with their item numbers.
 * The SEC submissions JSON exposes an `items` field (space-separated) for each
 * 8-K entry — e.g. "1.01 5.02 9.01" — so no extra HTTP fetches are needed.
 * Results are cached for 12 hours per symbol.
 *
 * @param {string} symbol
 * @returns {Promise<Array<{filingDate: string, items: string[]}>>}
 */
async function getRecentForm8K(symbol) {
    const cacheKey = `edgar_8k_${symbol}`;
    const cached   = cacheService.get(cacheKey);
    if (cached !== null) return cached;

    try {
        const cik = await getCik(symbol);
        if (!cik) {
            cacheService.set(cacheKey, [], FORM8K_CACHE_TTL);
            return [];
        }

        const sub    = await _get(`${EDGAR_BASE}/submissions/CIK${cik}.json`);
        const recent = sub.filings?.recent ?? {};
        const forms  = recent.form        ?? [];
        const dates  = recent.filingDate  ?? [];
        const rawItems = recent.items     ?? [];   // space-separated item numbers per filing

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - FORM8K_LOOKBACK_D);

        const filings = forms
            .map((f, i) => ({ form: f, date: dates[i], rawItems: rawItems[i] || '' }))
            .filter(x => x.form === '8-K' && x.date && new Date(x.date) >= cutoff)
            .slice(0, MAX_8K_FILINGS)
            .map(x => ({
                filingDate: x.date,
                items: x.rawItems
                    .split(/[\s,]+/)
                    .map(s => s.trim())
                    .filter(Boolean)
            }));

        logger.info(`[SECEdgar] ${symbol}: ${filings.length} 8-K filings in last ${FORM8K_LOOKBACK_D}d`);
        cacheService.set(cacheKey, filings, FORM8K_CACHE_TTL);
        return filings;

    } catch (err) {
        logger.warn(`[SECEdgar] 8-K fetch failed for ${symbol}: ${err.message}`);
        return [];
    }
}

module.exports = { getInsiderTransactions, getRecentForm8K, getCik };
