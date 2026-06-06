/**
 * SEC EDGAR Connector — Form 4 Insider Transactions
 *
 * Fetches legally-disclosed insider buy/sell data directly from the US Securities
 * and Exchange Commission EDGAR database.  No API key required.  Free, official,
 * and updated within 2 business days of each insider transaction.
 *
 * Data flow:
 *   1. company_tickers.json  — ticker → CIK mapping (cached 24h)
 *   2. /submissions/CIK*.json — list of recent Form 4 filings for a CIK
 *   3. /Archives/edgar/data/…/form4.xml — individual transaction XML (parsed via regex)
 *
 * SEC rate-limit guidance: ≤10 req/sec, identify yourself via User-Agent.
 * We cap at ~5 req/sec (200 ms gap) to stay well within limits.
 *
 * Returned transaction shape (Finnhub-compatible):
 *   { change, price, transactionCode, filingDate, insiderName, insiderTitle,
 *     isOfficer, isDirector, dollarValue }
 */

const { logger } = require('../utils/logger');
const cacheService = require('../services/cacheService');

const UA          = 'KiranRock-TradingBot kiranmadinedi@gmail.com';
const EDGAR_BASE  = 'https://data.sec.gov';
const ARCHIVE     = 'https://www.sec.gov/Archives/edgar/data';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';

const CIK_CACHE_TTL     = 24 * 60 * 60 * 1000;  // 24 h — tickers rarely change
const INSIDER_CACHE_TTL =  6 * 60 * 60 * 1000;  //  6 h — enough freshness intraday
const MAX_FILINGS       = 8;                      // Form 4 filings to parse per symbol
const REQUEST_GAP_MS    = 220;                    // ~4.5 req/sec — comfortably under SEC limit

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

module.exports = { getInsiderTransactions, getCik };
