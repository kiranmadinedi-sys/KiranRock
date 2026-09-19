/**
 * Position Reconciliation Service (PANTHEON: ATLAS)
 *
 * Compares KiranRock DB holdings against Alpaca's position list.
 * Alpaca is the source of truth for what is actually held.
 *
 * Three discrepancy classes:
 *   PHANTOM  — DB says we hold shares, Alpaca has 0 / no position
 *   DRIFT    — Both sides show a position but quantities differ
 *   SHADOW   — Alpaca holds shares that are not recorded in DB
 *
 * Every action is written to position_reconciliation_log so you have an
 * immutable audit trail to diagnose recurring drift, bugs, and patterns.
 *
 * If auto-fix fails for any row, `result.ok` is set false and the caller
 * should halt trading until the issue is resolved manually.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { logger } = require('../utils/logger');
const { query }  = require('../config/database');
const tradeIntelligenceService = require('./tradeIntelligenceService');

// ─── Alpaca positions fetch ───────────────────────────────────────────────────

async function _fetchAlpacaPositions(userId) {
    const axios   = require('axios');
    // Use per-user credentials so each user's live/paper account is checked correctly.
    // Falls back to .env if the user has no personal keys stored.
    const userDb  = require('./userDatabaseService');
    const creds   = userId ? await userDb.getUserAlpacaCredentials(userId) : null;
    const isPaper = creds ? creds.isPaper : (process.env.ALPACA_PAPER || 'true').toLowerCase() !== 'false';
    const keyId     = (creds && creds.keyId)     || process.env.ALPACA_KEY_ID     || '';
    const secretKey = (creds && creds.secretKey) || process.env.ALPACA_SECRET_KEY || '';
    const base    = isPaper
        ? 'https://paper-api.alpaca.markets/v2'
        : 'https://api.alpaca.markets/v2';
    if (!keyId || !secretKey) throw new Error('ALPACA_KEY_ID / ALPACA_SECRET_KEY not set');
    const resp = await axios.get(`${base}/positions`, {
        headers: {
            'APCA-API-KEY-ID':     keyId,
            'APCA-API-SECRET-KEY': secretKey,
            'Content-Type':        'application/json'
        },
        timeout: 10000
    });
    return resp.data || [];
}

// ─── Audit log helper ─────────────────────────────────────────────────────────

async function _auditLog(userId, discrepancy, symbol, dbQty, brokerQty, action, details, trigger) {
    try {
        await query(
            `INSERT INTO position_reconciliation_log
             (user_id, discrepancy, symbol, db_qty, broker_qty, action, details, trigger)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [String(userId), discrepancy, symbol, dbQty ?? null, brokerQty ?? null, action, details || null, trigger]
        );
    } catch (err) {
        logger.warn('[Reconcile] audit_log write failed', { userId, symbol, err: err.message });
    }
}

// ─── Fill-history reconciliation ───────────────────────────────────────────────

/**
 * Catches what PHANTOM/DRIFT/SHADOW structurally cannot: those three only ever
 * compare the CURRENT DB quantity against the CURRENT Alpaca quantity at the
 * instant reconcilePositions happens to run. A complete round trip that opens
 * and closes entirely between two of those checks — landing back on the same
 * net share count — produces zero drift at either checkpoint, so it's
 * invisible to that comparison no matter how often it runs.
 *
 * Found 2026-09-17: a SOXL position went 9→0→9→0→9 shares within about an
 * hour on 2026-09-11 (a real stop-loss then an immediate re-entry-and-exit),
 * and both intermediate fills were completely missing from `trades` — no
 * PHANTOM/DRIFT/SHADOW was ever flagged because the share count matched DB's
 * expectation at every point reconcilePositions actually looked. No log trace
 * existed either, at any bot's decision-logging level, of what submitted
 * those two orders — this function can't explain a gap like that, only make
 * sure it can never stay invisible again.
 *
 * Approach: pull every real closed ORDER from Alpaca over the lookback window
 * (aggregated filled_qty/filled_avg_price — see the partial-fill note below)
 * and match each one against an existing `trades` row — first by
 * broker_order_id (exact, for rows written after 2026-09-17), falling back to
 * a symbol+action+qty+price+time fuzzy match (for everything recorded before
 * that column existed). Anything left unmatched is a real fill this app never
 * wrote down.
 *
 * Detect-and-ALERT only — deliberately does not auto-backfill. Building this,
 * two separate live runs against real data produced false positives before
 * being caught and rolled back: matching against raw per-partial-fill
 * activities instead of per-order aggregates (one 189-share order's 7 partial
 * fills looked like 7 separate missing trades), and — even after fixing that —
 * a genuinely fragmented real order sequence (VEEA, an already-known messy
 * multi-whipsaw day) where quantities didn't line up exactly with the nearest
 * recorded trade despite close time/price. A fuzzy match this imprecise is
 * good enough to flag something for a human to look at; it is not good enough
 * to trust with an unattended write of real financial history. `result.missing`
 * is surfaced through runMorningReconciliation's Telegram alert so a real gap
 * (like the SOXL one that started this) gets found and fixed by hand the way
 * that one was, instead of sitting invisible indefinitely.
 *
 * Deliberately NOT a substitute for the PHANTOM/DRIFT/SHADOW checks above —
 * those still exist because a currently-wrong balance is worth flagging even
 * before any fill-level detail is available (e.g. a network blip mid-fetch).
 * This is a second, independent safety net over the same ground.
 */
async function reconcileFillHistory(userId, { trigger = 'SCHEDULED', lookbackHours = 26 } = {}) {
    const result = { ok: true, missing: [], fixes: [], errors: [] };

    const broker = (process.env.BROKER || 'simulated').toLowerCase();
    if (broker !== 'alpaca') return result;

    const axios    = require('axios');
    const userDb   = require('./userDatabaseService');
    const tradesDb = require('./tradesDatabaseService');

    const afterIso = new Date(Date.now() - lookbackHours * 3600 * 1000).toISOString();

    let fills;
    try {
        const creds = await userDb.getUserAlpacaCredentials(userId);
        const base  = (creds?.isPaper !== false) ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
        const headers = {
            'APCA-API-KEY-ID':     creds?.keyId     || process.env.ALPACA_KEY_ID,
            'APCA-API-SECRET-KEY': creds?.secretKey || process.env.ALPACA_SECRET_KEY
        };
        // Deliberately /v2/orders, NOT /v2/account/activities?activity_type=FILL.
        // A single order commonly fills across several PARTIAL activity records
        // (large or illiquid orders especially) at slightly different prices —
        // recordTrade() throughout this codebase always writes ONE row per ORDER
        // using its aggregated filled_qty/filled_avg_price, never one row per
        // partial fill. Matching against raw FILL activities compares that one
        // aggregated row against each individual partial slice, none of which
        // matches on qty or price alone — guaranteed false positives. Confirmed
        // live 2026-09-17: an early version of this function, run once against
        // real data, mistook 7 partial fills of one 189-share MEDS order for 7
        // separate missing trades and inserted all of them — caught immediately
        // by re-reading the result before trusting it, rolled back before
        // shipping. /v2/orders gives exactly the same per-order aggregate this
        // app's own recording code already uses, so it's the correct unit to
        // compare against.
        const ordRes = await axios.get(`${base}/v2/orders`, {
            headers, params: { status: 'closed', after: afterIso, limit: 500, direction: 'asc' }, timeout: 10000
        });
        fills = (ordRes.data || [])
            .filter(o => o.symbol && (o.side === 'buy' || o.side === 'sell')
                && parseFloat(o.filled_qty) > 0 && parseFloat(o.filled_avg_price) > 0 && o.filled_at)
            // Crypto has its own separate ledger (crypto_positions/crypto_trades) —
            // never reconcile it into the stock `trades` table. Alpaca crypto symbols
            // always carry a '/' (e.g. "BTC/USD"); equities never do.
            .filter(o => !o.symbol.includes('/'))
            .map(o => ({
                symbol: o.symbol, side: o.side,
                qty: o.filled_qty, price: o.filled_avg_price,
                transaction_time: o.filled_at, order_id: o.id
            }))
            .sort((a, b) => new Date(a.transaction_time) - new Date(b.transaction_time));
    } catch (err) {
        const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' ||
                             err.code === 'ETIMEDOUT'  || err.code === 'ECONNRESET'  ||
                             (err.response?.status >= 500);
        if (isNetworkErr) {
            logger.warn('[Reconcile:FillHistory] Alpaca unreachable (transient) — skipping', { userId, err: err.message });
            return result;
        }
        logger.error('[Reconcile:FillHistory] Failed to fetch orders', { userId, err: err.message });
        result.ok = false;
        result.errors.push(`Orders fetch failed: ${err.message}`);
        return result;
    }

    if (fills.length === 0) return result;

    try {
        await tradesDb.ensureBrokerOrderIdColumn();
    } catch (err) {
        logger.error('[Reconcile:FillHistory] Could not ensure broker_order_id column', { userId, err: err.message });
        result.ok = false;
        result.errors.push(`Schema check failed: ${err.message}`);
        return result;
    }

    // Wider than the lookback on the low end so a fill right at the boundary can still
    // find its match (or its own cost-basis BUY) rather than getting falsely flagged.
    // trade_date_utc converts the naive `timestamp without time zone` column to a real
    // instant server-side (AT TIME ZONE), the same correctness reasoning as every other
    // trade_date read/write in this file — comparing raw JS-parsed naive values against
    // Alpaca's real UTC timestamps would silently reintroduce the exact round-trip bug
    // fixed elsewhere this week.
    let existingRows;
    try {
        const res = await query(
            `SELECT id, symbol, action, quantity, price, broker_order_id,
                    (trade_date AT TIME ZONE 'America/Chicago') AS trade_date_utc
             FROM trades
             WHERE user_id = $1
               AND trade_date >= (($2::timestamptz AT TIME ZONE 'America/Chicago') - INTERVAL '30 minutes')`,
            [userId, afterIso]
        );
        existingRows = res.rows;
    } catch (err) {
        logger.error('[Reconcile:FillHistory] Failed to load existing trades for matching', { userId, err: err.message });
        result.ok = false;
        result.errors.push(`Trades read failed: ${err.message}`);
        return result;
    }

    const consumed        = new Set();
    // Widened 2026-09-17 after a live run against real data: the EXISTING recorder
    // (the SHADOW backfill above, and presumably others) records the price of
    // whichever single partial fill it happened to look up, not the order's true
    // filled_avg_price — confirmed on a real MEDS order where the recorded price
    // (5.90) was 0.6% off the order's actual average (5.865). A tight tolerance
    // here would flag already-correctly-recorded trades as "missing" purely
    // because of that pre-existing, unrelated imprecision.
    const PRICE_TOL_ABS    = 0.10;
    const PRICE_TOL_PCT    = 0.02;   // 2%
    const TIME_TOL_MINUTES = 15;

    function findMatch(fill) {
        const action = fill.side === 'buy' ? 'BUY' : 'SELL';

        const byOrderId = existingRows.find(r =>
            !consumed.has(r.id) && r.broker_order_id && r.broker_order_id === fill.order_id);
        if (byOrderId) return byOrderId;

        const fillTimeMs = new Date(fill.transaction_time).getTime();
        const fillPrice  = parseFloat(fill.price);
        const fillQty    = parseFloat(fill.qty);
        const priceTol   = Math.max(PRICE_TOL_ABS, fillPrice * PRICE_TOL_PCT);

        let best = null, bestDiffMs = Infinity;
        for (const r of existingRows) {
            if (consumed.has(r.id)) continue;
            if (r.symbol.toUpperCase() !== fill.symbol.toUpperCase()) continue;
            if (r.action !== action) continue;
            if (Math.abs(parseFloat(r.quantity) - fillQty) > 0.001) continue;
            if (Math.abs(parseFloat(r.price) - fillPrice) > priceTol) continue;
            const diffMs = Math.abs(new Date(r.trade_date_utc).getTime() - fillTimeMs);
            if (diffMs > TIME_TOL_MINUTES * 60000) continue;
            if (diffMs < bestDiffMs) { best = r; bestDiffMs = diffMs; }
        }
        return best;
    }

    // Report-only, deliberately NOT auto-backfilled. Two live runs against real
    // data while building this each produced false positives before this was
    // caught and rolled back: first, matching against raw partial-fill activities
    // instead of aggregated orders (7 partials of one 189-share MEDS order looked
    // like 7 separate missing trades); second, even after fixing that, a genuinely
    // fragmented real order sequence (VEEA, already a known messy multi-whipsaw
    // day) produced fills whose quantity didn't line up exactly with the nearest
    // recorded trade (194 vs 189 shares) despite matching time and price closely.
    // Auto-writing on a fuzzy match this imprecise risks exactly the kind of
    // phantom-duplicate mess this whole feature exists to catch. A human
    // reviewing an alert and deciding whether to backfill (the same way the SOXL
    // gap that started this was fixed) is the safe version of this feature;
    // silently trusting a fuzzy match to insert real financial data is not.
    for (const fill of fills) {
        const match = findMatch(fill);
        if (match) { consumed.add(match.id); continue; }

        const action = fill.side === 'buy' ? 'BUY' : 'SELL';
        const qty    = parseFloat(fill.qty);
        const price  = parseFloat(fill.price);

        await _auditLog(userId, 'MISSING_FILL', fill.symbol, null, null, 'DETECTED',
            `${action} ${qty} @ $${price.toFixed(2)} on ${fill.transaction_time} (order ${fill.order_id}) — ` +
            `no matching trades row found within ±${TIME_TOL_MINUTES}min / ±${(PRICE_TOL_PCT * 100).toFixed(1)}% price. Needs manual review.`,
            trigger);
        result.missing.push(`${fill.symbol} ${action} ${qty}@$${price.toFixed(2)} (${fill.transaction_time})`);
        logger.warn('[Reconcile:FillHistory] Real fill has no matching trades row — needs manual review', {
            userId, symbol: fill.symbol, action, qty, price, filledAt: fill.transaction_time, orderId: fill.order_id
        });
    }

    return result;
}

// ─── Core reconciliation logic ────────────────────────────────────────────────

/**
 * Reconcile DB holdings for one user against Alpaca.
 *
 * @param {string|number} userId
 * @param {{ trigger?: 'SCHEDULED' | 'STARTUP' | 'MANUAL' }} opts
 * @returns {Promise<{
 *   ok:       boolean,   // false means an auto-fix failed — halt trading
 *   phantoms: string[],
 *   drifts:   Array<{symbol,dbQty,alpacaQty}>,
 *   shadows:  string[],
 *   fixes:    string[],
 *   errors:   string[]  // unfixable problems
 * }>}
 */
async function reconcilePositions(userId, { trigger = 'SCHEDULED' } = {}) {
    const result = {
        ok:           true,
        networkError: false,  // true = transient network failure, don't halt trading
        phantoms:     [],
        drifts:       [],
        shadows:      [],
        missingFills: [],
        fillErrors:   [], // separate from `errors` — never halt-worthy, see reconcileFillHistory
        fixes:        [],
        errors:       []
    };

    // Skip when using the simulated broker — no Alpaca to compare against.
    const broker = (process.env.BROKER || 'simulated').toLowerCase();
    if (broker !== 'alpaca') {
        logger.info('[Reconcile] BROKER != alpaca — skipping (simulated mode)');
        return result;
    }

    // ── Step 1: load DB holdings ─────────────────────────────────────────────
    let dbRows;
    try {
        const res = await query(
            `SELECT symbol, quantity, average_price, current_price, sector FROM holdings WHERE user_id = $1 AND quantity > 0`,
            [userId]
        );
        dbRows = res.rows;
    } catch (err) {
        logger.error('[Reconcile] Failed to load DB holdings', { userId, err: err.message });
        result.ok = false;
        result.errors.push(`DB read failed: ${err.message}`);
        return result;
    }

    // ── Step 2: load Alpaca positions ────────────────────────────────────────
    let alpacaPositions;
    try {
        alpacaPositions = await _fetchAlpacaPositions(userId);
    } catch (err) {
        // Distinguish transient network errors (DNS, timeout, 5xx) from real failures.
        // Network errors are self-healing — don't halt trading; just skip this run.
        const isNetworkErr = err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' ||
                             err.code === 'ETIMEDOUT'  || err.code === 'ECONNRESET'  ||
                             (err.response?.status >= 500);
        if (isNetworkErr) {
            logger.warn('[Reconcile] Alpaca unreachable (transient) — skipping reconciliation run', {
                userId, err: err.message, code: err.code
            });
            result.networkError = true;
            return result;   // ok=true, networkError=true — caller must NOT halt trading
        }
        logger.error('[Reconcile] Failed to fetch Alpaca positions', { userId, err: err.message });
        result.ok = false;
        result.errors.push(`Alpaca fetch failed: ${err.message}`);
        return result;
    }

    // Build lookup maps (symbol → quantity, normalised to uppercase).
    // Use parseFloat so fractional share positions (e.g. 0.269 ASML) are preserved.
    // Skip short positions (negative qty) — the bot is long-only; shorts are manual/external.
    const dbMap     = new Map(dbRows.map(r => [r.symbol.toUpperCase(), parseFloat(r.quantity)]));
    const alpacaMap = new Map(
        alpacaPositions
            .filter(p => parseFloat(p.qty) > 0.0001)   // exclude shorts and dust (< 0.0001 shares)
            // Crypto positions are deliberately tracked in their own crypto_positions table
            // (same isolation reasoning as Blitz — see cryptoDatabaseService.js), never in
            // this shared `holdings` table. Without this filter, this reconciler's "shadow"
            // detection (Alpaca has a position, `holdings` doesn't) can't tell the difference
            // between a genuinely-untracked stock buy and a crypto position that's correctly
            // tracked elsewhere — it "helpfully" auto-imports the crypto position into
            // `holdings` as if it were a missed stock trade. Confirmed live 2026-09-02:
            // DOTUSD/LTCUSD (real, correctly-managed crypto_positions rows) got imported
            // into `holdings` this way, then the swing position-management loop tried to
            // price them as stocks every cycle and failed 50+ times ("Unable to get current
            // price for DOTUSD") — noisy, though not a real safety gap since the crypto bot
            // was still separately managing the real position correctly throughout.
            .filter(p => (p.asset_class || 'us_equity') === 'us_equity')
            .map(p => [p.symbol.toUpperCase(), parseFloat(p.qty)])
    );

    // ── Step 3: detect discrepancies ─────────────────────────────────────────

    for (const [symbol, dbQty] of dbMap) {
        const alpacaQty = alpacaMap.get(symbol);
        if (alpacaQty === undefined || alpacaQty < 0.0001) {
            // Alpaca has no meaningful position — DB record is phantom
            result.phantoms.push(symbol);
            logger.warn('[Reconcile] PHANTOM detected', { userId, symbol, dbQty });
        } else {
            // Allow up to 0.5% drift before flagging (covers rounding in fractional fills)
            const pctDiff = Math.abs(alpacaQty - dbQty) / Math.max(alpacaQty, 0.0001);
            if (pctDiff > 0.005 && Math.abs(alpacaQty - dbQty) > 0.0001) {
                result.drifts.push({ symbol, dbQty, alpacaQty });
                logger.warn('[Reconcile] DRIFT detected', { userId, symbol, dbQty, alpacaQty });
            }
        }
    }

    for (const [symbol, alpacaQty] of alpacaMap) {
        if (!dbMap.has(symbol)) {
            result.shadows.push(symbol);
            logger.warn('[Reconcile] SHADOW detected', { userId, symbol, alpacaQty });
        }
    }

    // ── Step 4: auto-fix + write immutable audit row ──────────────────────────

    for (const symbol of result.phantoms) {
        const dbQty    = dbMap.get(symbol);
        const dbRow    = dbRows.find(r => r.symbol.toUpperCase() === symbol) || {};
        const entryPrice = parseFloat(dbRow.average_price || 0);

        // Guard against double-booking: if the app's OWN sell logic (quality-score decay,
        // trailing stop, etc.) already closed this exact position and logged its own SELL —
        // but for whatever reason left the `holdings` row behind — this loop would otherwise
        // see the same stale row as a fresh "phantom" and log a SECOND SELL for it, double-
        // counting the realized loss/gain. Found 2026-08-31: AVGO sold once for real at 13:34
        // (bot's own quality-decay exit, -$39.48), reconciler ran 18 min later, found the
        // still-present holdings row, and logged its own "reconciled" close for the same 6
        // shares (-$40.86) — same class of bug as the CEVA/ALGM double-count from 2026-08-15.
        // A recent same-symbol/same-qty SELL means this is a stale-row artifact, not a real
        // second exit — clean up the row but skip writing a duplicate trade record.
        const recentSell = await query(
            `SELECT id FROM trades
             WHERE user_id = $1 AND UPPER(symbol) = $2 AND action = 'SELL'
               AND ABS(quantity - $3) < 0.0001
               AND trade_date > NOW() - INTERVAL '2 hours'
             ORDER BY trade_date DESC LIMIT 1`,
            [userId, symbol, dbQty]
        );
        if (recentSell.rows.length > 0) {
            await query(`DELETE FROM holdings WHERE user_id = $1 AND UPPER(symbol) = $2`, [userId, symbol]);
            logger.warn('[Reconcile] Phantom matches a recent SELL already on record — cleaning up stale holdings row without double-logging', {
                userId, symbol, dbQty, matchingTradeId: recentSell.rows[0].id
            });
            continue;
        }

        // Prefer actual Alpaca FILL activity price for this symbol (most accurate).
        // Fall back to current_price, then stored stop price (least accurate — stop orders
        // may have been trailed up significantly since the original bracket was placed).
        let exitPrice = parseFloat(dbRow.current_price || 0);
        let exitTime = null; // real fill time, when found below — added 2026-09-14, see recordTrade(tradeDate) below
        let priceSource = 'current_price';
        let exitOrderId = null;
        let axiosBase = null, axiosHeaders = null;
        try {
            const userDb = require('./userDatabaseService');
            const creds  = await userDb.getUserAlpacaCredentials(userId);
            const axiosLib = require('axios');
            const base = (creds?.isPaper !== false) ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
            const headers = {
                'APCA-API-KEY-ID':     creds?.keyId || process.env.ALPACA_KEY_ID,
                'APCA-API-SECRET-KEY': creds?.secretKey || process.env.ALPACA_SECRET_KEY
            };
            axiosBase = base; axiosHeaders = headers;
            // Look for the most recent sell FILL for this symbol since the DB entry was created
            const since = dbRow.purchase_date || dbRow.created_at;
            const actRes = await axiosLib.get(`${base}/v2/account/activities`, {
                headers,
                params: { activity_type: 'FILL', after: since ? new Date(since).toISOString() : undefined },
                timeout: 8000
            });
            const fills = (actRes.data || []).filter(
                a => a.symbol === symbol && (a.side === 'sell' || a.side === 'sell_short') && parseFloat(a.price) > 0
            ).sort((a, b) => new Date(b.transaction_time) - new Date(a.transaction_time));
            if (fills.length > 0) {
                exitPrice   = parseFloat(fills[0].price);
                exitTime    = fills[0].transaction_time || null;
                priceSource = `alpaca_fill@${fills[0].transaction_time?.slice(0,10)}`;
                exitOrderId = fills[0].order_id || null;
            }
        } catch (_) {
            // If Alpaca activities call fails, fall through to stored stop price
            try {
                const stopRow = await query(
                    `SELECT metadata FROM order_audit_log
                     WHERE user_id = $1 AND UPPER(symbol) = $2 AND state = 'OPEN_WITH_STOP'
                     ORDER BY created_at DESC LIMIT 1`,
                    [userId, symbol]
                );
                const sp = parseFloat(stopRow.rows[0]?.metadata?.stopPrice || 0);
                if (sp > 0) { exitPrice = sp; priceSource = 'stop_order_estimate'; }
            } catch (_2) {}
        }

        // Classify what actually closed the position (stop / trailing stop / target /
        // partial) instead of lumping every reconciler-caught exit into one generic
        // bucket — the reconciler already has the fill's order_id, one more lookup gets
        // the order's real type. Falls back to the generic label if anything's missing
        // so this can never break the exit-logging path (found via ChatGPT review + our
        // own follow-up, 2026-07-11: "reconciler_detected" was 75% of all closed trades
        // and told analytics nothing about WHY the position closed).
        //
        // order.type alone isn't trustworthy for 'limit': this codebase places stop-loss
        // and take-profit as two SEPARATE standalone GTC orders per position (buyMarket,
        // ~line 504-519), not a linked Alpaca bracket/OCO pair — so a 'limit' order can
        // fill at a LOSS too (e.g. a repriced/defensive exit), and a real take-profit
        // should only be labeled as such if the fill actually beat entry price. This also
        // explains the recurring orphaned-stop-order bug from earlier this week (EXC/CL):
        // with no OCO link, the sibling order doesn't auto-cancel when one leg fills.
        let exitReasonTag = 'reconciler_detected';
        if (exitOrderId && axiosBase) {
            try {
                const axiosLib = require('axios');
                const orderRes = await axiosLib.get(`${axiosBase}/v2/orders/${exitOrderId}`, { headers: axiosHeaders, timeout: 8000 });
                const order = orderRes.data || {};
                const filledQty = parseFloat(order.filled_qty || order.qty || 0);
                const isPartial = filledQty > 0 && dbQty > 0 && filledQty < dbQty * 0.99;
                const beatEntry = entryPrice > 0 && exitPrice > entryPrice;
                if (order.type === 'trailing_stop') {
                    exitReasonTag = 'trailing_stop_reconciled';
                } else if (order.type === 'stop' || order.type === 'stop_limit') {
                    exitReasonTag = 'stop_loss_reconciled';
                } else if (order.type === 'limit') {
                    exitReasonTag = beatEntry ? (isPartial ? 'partial_profit_reconciled' : 'take_profit_reconciled') : 'protective_limit_reconciled';
                } else if (order.type === 'market') {
                    exitReasonTag = 'market_exit_reconciled';
                }
            } catch (orderErr) {
                logger.debug('[Reconcile] Could not classify exit order type — using generic tag', { userId, symbol, exitOrderId, error: orderErr.message });
            }
        }

        try {
            // 1. Delete the phantom holding (Alpaca is source of truth)
            await query(
                `DELETE FROM holdings WHERE user_id = $1 AND UPPER(symbol) = $2`,
                [userId, symbol]
            );

            // 2. Write a SELL to the trades table so transaction history stays complete.
            //    Marks the exit as reconciler-detected so analysts know the price is estimated.
            //    Also propagates ai_score from the matching BUY record so analytics can group by score.
            if (entryPrice > 0 && dbQty > 0) {
                const fillPrice = exitPrice > 0 ? exitPrice : entryPrice;
                const total     = parseFloat((fillPrice * dbQty).toFixed(4));
                const pnl       = parseFloat(((fillPrice - entryPrice) * dbQty).toFixed(4));
                const pnlPct    = parseFloat(((fillPrice - entryPrice) / entryPrice * 100).toFixed(4));

                // Look up ai_score, sector, entry_regime, and buy date from the most recent BUY
                let entryScore = null, entrySector = null, entryRegime = null, holdHours = null;
                try {
                    const buyRow = await query(
                        `SELECT ai_score, sector, entry_regime, trade_date FROM trades
                         WHERE user_id=$1 AND symbol=$2 AND action='BUY'
                         ORDER BY trade_date DESC LIMIT 1`,
                        [userId, symbol]
                    );
                    if (buyRow.rows[0]) {
                        entryScore   = buyRow.rows[0].ai_score;
                        entrySector  = buyRow.rows[0].sector;
                        entryRegime  = buyRow.rows[0].entry_regime;
                        if (buyRow.rows[0].trade_date) {
                            holdHours = parseFloat(
                                ((Date.now() - new Date(buyRow.rows[0].trade_date).getTime()) / 3600000).toFixed(2)
                            );
                        }
                    }
                } catch (_) {}

                // trade_date: real fill time when the account/activities lookup above found
                // one (exitTime), else NOW() — was unconditionally NOW() before 2026-09-14,
                // which silently recorded reconciler-discovery time as if it were the actual
                // exit time. Same bug shape, same fix, as the SHADOW buy-backfill a few dozen
                // lines below in this file (and the crypto stale_skip fix from 2026-09-12) —
                // cast+AT TIME ZONE for the same `timestamp without time zone` round-trip
                // reason documented on tradesDatabaseService.recordTrade's tradeDate param.
                await query(
                    `INSERT INTO trades
                         (user_id, symbol, action, quantity, price, total, trade_date,
                          executed_by, notes, pnl, pnl_percent, status,
                          ai_score, sector, entry_regime, hold_hours)
                     VALUES ($1, $2, 'SELL', $3, $4, $5,
                             COALESCE($13::timestamptz AT TIME ZONE 'America/Chicago', NOW()),
                             'reconciler', $8, $6, $7, 'CLOSED', $9, $10, $11, $12)`,
                    [userId, symbol, dbQty, fillPrice, total, pnl, pnlPct,
                     `Alpaca stop/exit detected by position reconciler — price source: ${priceSource}, exit type: ${exitReasonTag}`,
                     entryScore, entrySector, entryRegime, holdHours, exitTime]
                );

                // Stop-loss cooldown — added 2026-09-15. enhancedAITradingBot.js's own
                // live-detected hard-stop path (isHardStop) has always set a 5-day
                // COOLDOWN_<userId>_<symbol> row in asset_blacklist; this reconciler path
                // never did, even for the exact same kind of exit (a real stop order
                // firing) — it just happened to be caught here instead of live. Found
                // live: VEEA (paper account) got bought back by Blitz within 90 seconds
                // of a reconciler-caught stop-loss, immediately losing again, because
                // there was no cooldown row for Blitz's cross-strategy check (2026-09-14
                // fix, 74b4eb2) to find. Only fires for a genuine stop-loss exit
                // (exitReasonTag === 'stop_loss_reconciled') — not trailing stops, take
                // profits, or generic market exits, matching isHardStop's own scope.
                if (exitReasonTag === 'stop_loss_reconciled') {
                    try {
                        await query(
                            `INSERT INTO asset_blacklist (symbol, reason, added_by, expires_at)
                             VALUES ($1, $2, 'ai_bot_stop_loss', NOW() + INTERVAL '5 days')
                             ON CONFLICT (symbol) DO UPDATE
                               SET reason = EXCLUDED.reason,
                                   expires_at = GREATEST(EXCLUDED.expires_at, asset_blacklist.expires_at)`,
                            [`COOLDOWN_${userId}_${symbol}`, `Stop-loss cooldown for ${symbol} (exit: ${pnlPct.toFixed(1)}% @ $${fillPrice.toFixed(2)}, reconciler-caught)`]
                        );
                        logger.info('[Reconcile] Up-to-5-day re-entry cooldown set (reconciler-caught stop-loss)', { userId, symbol, fillPrice });
                    } catch (cooldownErr) {
                        logger.warn('[Reconcile] Failed to insert cooldown for reconciler-caught stop-loss', { userId, symbol, error: cooldownErr.message });
                    }
                }

                // Also close the matching trade_decision_journal row so this exit shows up in
                // trade_attribution — the view/analytics (win-rate-by-score-bucket, exit-reason
                // breakdown, score calibration) all read from that journal, not from `trades`.
                // Reconciler-detected exits (a stop/target firing between position snapshots)
                // were writing to `trades` only, so every stop-triggered exit was invisible to
                // that analysis — found investigating this week's zero trade_attribution rows
                // despite 6 real exits (2026-07-11). exitReasonTag (above) distinguishes the
                // real mechanism (stop/trailing-stop/target/partial) instead of one generic
                // "reconciler_detected" bucket that told analytics nothing about why the
                // position closed (raised in the same follow-up review).
                try {
                    const _outcome = pnlPct > 0.5 ? 'win' : pnlPct < -0.5 ? 'loss' : 'breakeven';
                    await tradeIntelligenceService.closeLatestOpenExecution(userId, {
                        botType: 'stock', symbol, exitPrice: fillPrice, pnl, pnlPercent: pnlPct,
                        outcome: _outcome,
                        metadata: {
                            reason: `Reconciler-detected exit (${exitReasonTag}) — fill found on Alpaca, DB still showed position open`,
                            exitReason: exitReasonTag,
                            winLossReason: _outcome === 'win' ? `${exitReasonTag}_gain` : _outcome === 'loss' ? `${exitReasonTag}_loss` : `${exitReasonTag}_flat`,
                            priceSource
                        }
                    });
                } catch (journalErr) {
                    logger.debug('[Reconcile] Failed to close trade_decision_journal entry for reconciler exit', { userId, symbol, error: journalErr.message });
                }
            }

            // 3. Close any open stop-order entries in order_audit_log so SENTINEL stays clean.
            await query(
                `INSERT INTO order_audit_log
                     (idempotency_key, symbol, state, user_id, metadata, created_at)
                 SELECT idempotency_key, symbol, 'CLOSED', user_id,
                        jsonb_build_object(
                            'reason',    'Alpaca stop-fill — reconciler-detected',
                            'exitPrice', $3::text
                        ),
                        NOW()
                 FROM order_audit_log
                 WHERE user_id = $1 AND UPPER(symbol) = $2 AND state = 'OPEN_WITH_STOP'
                   AND NOT EXISTS (
                       SELECT 1 FROM order_audit_log t2
                       WHERE t2.idempotency_key = order_audit_log.idempotency_key
                         AND t2.state IN ('STOPPED','CLOSED','CLOSED_MANUAL','CANCELED','REJECTED')
                   )`,
                [userId, symbol, exitPrice?.toFixed(2) || '0']
            );

            await _auditLog(userId, 'PHANTOM', symbol, dbQty, 0, 'DELETED',
                `DB held ${dbQty} shares; Alpaca: none. SELL recorded @ ~$${exitPrice.toFixed(2)}`, trigger);
            result.fixes.push(`PHANTOM fixed: deleted ${symbol} (DB had ${dbQty}, sell logged @ ~$${exitPrice.toFixed(2)})`);
            logger.info('[Reconcile] Fixed PHANTOM — deleted holding, logged SELL', { userId, symbol, dbQty, exitPrice });
        } catch (err) {
            await _auditLog(userId, 'PHANTOM', symbol, dbQty, 0, 'ERROR', err.message, trigger);
            result.errors.push(`Failed to delete phantom ${symbol}: ${err.message}`);
            result.ok = false;
            logger.error('[Reconcile] Failed to fix PHANTOM', { userId, symbol, err: err.message });
        }
    }

    for (const { symbol, dbQty, alpacaQty } of result.drifts) {
        try {
            await query(
                `UPDATE holdings SET quantity = $1, updated_at = NOW()
                 WHERE user_id = $2 AND UPPER(symbol) = $3`,
                [alpacaQty, userId, symbol]
            );
            await _auditLog(userId, 'DRIFT', symbol, dbQty, alpacaQty, 'UPDATED',
                `DB qty ${dbQty} corrected to Alpaca qty ${alpacaQty}`, trigger);
            result.fixes.push(`DRIFT fixed: ${symbol} DB=${dbQty} → ${alpacaQty}`);
            logger.info('[Reconcile] Fixed DRIFT — updated DB qty', { userId, symbol, dbQty, alpacaQty });
        } catch (err) {
            await _auditLog(userId, 'DRIFT', symbol, dbQty, alpacaQty, 'ERROR', err.message, trigger);
            result.errors.push(`Failed to fix drift ${symbol}: ${err.message}`);
            result.ok = false;
            logger.error('[Reconcile] Failed to fix DRIFT', { userId, symbol, err: err.message });
        }
    }

    for (const symbol of result.shadows) {
        const alpacaQty = alpacaMap.get(symbol);
        const alpacaPos = alpacaPositions.find(p => p.symbol.toUpperCase() === symbol);
        const avgPrice  = parseFloat(alpacaPos?.avg_entry_price || 0) ||
                          (alpacaPos?.cost_basis ? parseFloat(alpacaPos.cost_basis) / alpacaQty : 0);
        // Alpaca's position object already carries a live price — use it so a
        // restored row isn't left showing null/stale current_price until the
        // next regular-hours refresh tick picks it up.
        const currentPrice  = parseFloat(alpacaPos?.current_price || 0) || avgPrice;
        const marketValue   = parseFloat(alpacaPos?.market_value || 0) || (currentPrice * alpacaQty);
        const gainLoss       = parseFloat(alpacaPos?.unrealized_pl || 0) || (marketValue - (avgPrice * alpacaQty));
        const gainLossPct    = alpacaPos?.unrealized_plpc != null
            ? parseFloat(alpacaPos.unrealized_plpc) * 100
            : (avgPrice > 0 ? (gainLoss / (avgPrice * alpacaQty)) * 100 : 0);
        try {
            await query(
                `INSERT INTO holdings (user_id, symbol, quantity, average_price, current_price, market_value, gain_loss, gain_loss_percent, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
                 ON CONFLICT (user_id, symbol)
                 DO UPDATE SET quantity = $3, average_price = $4, current_price = $5, market_value = $6, gain_loss = $7, gain_loss_percent = $8, updated_at = NOW()`,
                [userId, symbol, alpacaQty, avgPrice, currentPrice, marketValue, gainLoss, gainLossPct]
            );

            // Also record the missing BUY in `trades` — a shadow means the entry order
            // filled at the broker but the app never wrote it down, most commonly an
            // extended-hours order (brokerService.buyLimitExtendedHours's 15s post-submit
            // wait gives up before a slow extended-hours fill completes, and nothing
            // re-checks it afterward). Without this, the position is real and protected
            // but permanently invisible to SAGE/LocalBrain/attribution — confirmed live
            // 2026-09-05: IOVA, 57 shares filled 2026-09-04 at the exact submitted limit
            // price, holdings row present, zero rows in trades. recordTrade() only writes
            // the audit row (no balance/holdings side effects — those are already handled
            // above), so it can't double-count anything.
            try {
                // Look up the REAL fill time/price via account activities (same
                // approach already used a few lines up for exit reconciliation) —
                // added 2026-09-14. Without this, trade_date defaulted to NOW()
                // (whenever the reconciler happened to run), which can be days
                // after the real fill. Confirmed live: ORCL (kmadined) and SOXL
                // (paper) both showed up dated "today" when the real fills were
                // 4 and 3 days old respectively — made two old positions look
                // like reckless same-day re-entries right after a stop-loss,
                // which they were not. Falls back to avgPrice/NOW() (the
                // pre-existing behavior) if the activity lookup fails or finds
                // nothing, exactly like the crypto stale_skip fix's fallback.
                let fillPrice = avgPrice;
                let fillTime  = null;
                let fillOrderId = null;
                try {
                    const axiosLib = require('axios');
                    const userDbLib = require('./userDatabaseService');
                    const creds = await userDbLib.getUserAlpacaCredentials(userId);
                    const base = (creds?.isPaper !== false) ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets';
                    const headers = {
                        'APCA-API-KEY-ID':     creds?.keyId || process.env.ALPACA_KEY_ID,
                        'APCA-API-SECRET-KEY': creds?.secretKey || process.env.ALPACA_SECRET_KEY
                    };
                    const actRes = await axiosLib.get(`${base}/v2/account/activities`, {
                        headers, params: { activity_type: 'FILL' }, timeout: 8000
                    });
                    const fills = (actRes.data || []).filter(
                        a => a.symbol === symbol && a.side === 'buy' && parseFloat(a.price) > 0
                    ).sort((a, b) => new Date(b.transaction_time) - new Date(a.transaction_time));
                    if (fills.length > 0) {
                        fillPrice = parseFloat(fills[0].price);
                        fillTime  = fills[0].transaction_time;
                        // 2026-09-19: real ORCL incident — this SHADOW path and the live
                        // executeBuyOrder path each independently recorded the same real
                        // fill with no broker_order_id on either row, so nothing could
                        // ever catch the duplicate. FILL activities carry the order_id
                        // that produced them; passing it through lets recordTrade's
                        // unique index catch this exact race if the live path already won it.
                        fillOrderId = fills[0].order_id || null;
                    }
                } catch (lookupErr) {
                    logger.debug('[Reconcile] SHADOW real-fill lookup failed, using cached avgPrice/NOW()', {
                        userId, symbol, error: lookupErr.message
                    });
                }

                const tradesDb = require('./tradesDatabaseService');
                const shadowTradeResult = await tradesDb.recordTrade({
                    userId, symbol, action: 'BUY',
                    quantity: alpacaQty,
                    price: fillPrice,
                    total: fillPrice * alpacaQty,
                    executedBy: 'reconciler',
                    tradeDate: fillTime,
                    brokerOrderId: fillOrderId,
                    notes: 'Shadow position — broker fill never reached trades (see positionReconciliationService SHADOW fix)'
                });
                if (shadowTradeResult?._duplicate) {
                    logger.info('[Reconcile] SHADOW backfill skipped — live path already recorded this exact fill', {
                        userId, symbol, existingTradeId: shadowTradeResult.id
                    });
                }
            } catch (tradeErr) {
                // Never let this block the holdings fix above — an unrecorded trade is a
                // data-completeness gap, not a live-position-safety issue.
                logger.warn('[Reconcile] SHADOW holding fixed but trades backfill failed', {
                    userId, symbol, err: tradeErr.message
                });
            }

            await _auditLog(userId, 'SHADOW', symbol, 0, alpacaQty, 'INSERTED',
                `Alpaca held ${alpacaQty} × ${symbol} @ $${avgPrice.toFixed(2)}; not in DB`, trigger);
            result.fixes.push(`SHADOW fixed: inserted ${symbol} × ${alpacaQty} @ $${avgPrice.toFixed(2)}`);
            logger.info('[Reconcile] Fixed SHADOW — inserted DB holding', { userId, symbol, alpacaQty, avgPrice });
        } catch (err) {
            await _auditLog(userId, 'SHADOW', symbol, 0, alpacaQty, 'ERROR', err.message, trigger);
            result.errors.push(`Failed to insert shadow ${symbol}: ${err.message}`);
            result.ok = false;
            logger.error('[Reconcile] Failed to fix SHADOW', { userId, symbol, err: err.message });
        }
    }

    // ── Step 5: fill-history reconciliation ──────────────────────────────────
    // Runs after the PHANTOM/DRIFT/SHADOW fixes above so their inserts are
    // already in `trades` and get matched, not duplicated. See
    // reconcileFillHistory's own doc comment for why this exists.
    // Note: fillResult.ok is intentionally never propagated into result.ok — this
    // whole step is retrospective ledger auditing (which historical fills got
    // recorded), never a signal about whether a CURRENT position is safe. It must
    // not be able to trip runMorningReconciliation's HALT_ALL circuit breaker, no
    // matter what fails inside it (a bad Alpaca fetch, a DB write failure, etc.).
    // fillErrors is kept separate from result.errors on purpose — it's surfaced in
    // its own non-blocking alert section rather than under "Auto-fix FAILED —
    // trading halted", since (per the note above) it can never actually halt anything.
    try {
        const fillResult = await reconcileFillHistory(userId, { trigger });
        result.missingFills = fillResult.missing;
        result.fillErrors   = fillResult.errors;
        result.fixes.push(...fillResult.fixes);
    } catch (err) {
        logger.error('[Reconcile] Fill-history reconciliation threw unexpectedly', { userId, err: err.message });
        result.missingFills = [];
        result.fillErrors   = [err.message];
        result.errors.push(`Fill-history reconciliation failed: ${err.message}`);
    }

    const totalIssues = result.phantoms.length + result.drifts.length + result.shadows.length + result.missingFills.length;
    if (totalIssues === 0) {
        logger.info('[Reconcile] Clean — no discrepancies', { userId, positions: dbMap.size, trigger });
    } else {
        logger.warn(`[Reconcile] ${totalIssues} discrepancy(s) | ${result.errors.length} error(s)`, {
            userId, trigger,
            phantoms: result.phantoms,
            missingFills: result.missingFills,
            drifts:   result.drifts.map(d => `${d.symbol}:${d.dbQty}→${d.alpacaQty}`),
            shadows:  result.shadows,
            errors:   result.errors
        });
    }

    return result;
}

/**
 * Run reconciliation for all active AI trading users, write the audit log,
 * send Telegram alerts for discrepancies, and set Redis HALT_ALL if any
 * auto-fix fails (bot should not trade with uncertain position state).
 *
 * @param {Array<{id:string|number, username:string}>} activeUsers
 * @param {{ trigger?: string }} opts
 */
async function runMorningReconciliation(activeUsers, { trigger = 'SCHEDULED' } = {}) {
    logger.info('[Reconcile] Starting reconciliation', { users: activeUsers.length, trigger });

    const alertService = require('./telegramAlertService');
    let totalIssues    = 0;
    let totalErrors    = 0;

    for (const user of activeUsers) {
        try {
            const r       = await reconcilePositions(user.id, { trigger });
            const issues  = r.phantoms.length + r.drifts.length + r.shadows.length;
            totalIssues  += issues;
            totalErrors  += r.errors.length;

            if (issues > 0 || r.errors.length > 0 || r.missingFills.length > 0 || r.fillErrors.length > 0) {
                const date  = new Date().toISOString().slice(0, 10);
                const lines = [
                    `⚖️ *Position Reconciliation — ${date}* _(${trigger})_`,
                    `${issues} discrepancy(s) | ${r.errors.length} error(s) | user: ${user.username}`,
                    ''
                ];
                if (r.phantoms.length)
                    lines.push(`🗑️ *Phantom* (DB only → deleted): ${r.phantoms.join(', ')}`);
                if (r.drifts.length)
                    lines.push(`📐 *Drift* (qty corrected): ${r.drifts.map(d => `${d.symbol} ${d.dbQty}→${d.alpacaQty}`).join(', ')}`);
                if (r.shadows.length)
                    lines.push(`👻 *Shadow* (Alpaca only → inserted): ${r.shadows.join(', ')}`);
                if (r.errors.length) {
                    lines.push('');
                    lines.push(`❌ *Auto-fix FAILED* — trading halted until resolved:`);
                    r.errors.forEach(e => lines.push(`  • ${e}`));
                }
                // Missing fills / lookup errors are reported but never gate the "halted"
                // language above — see reconcileFillHistory's doc comment for why this
                // whole category is detect-and-alert only, never an auto-fix, and never a
                // live-safety signal.
                if (r.missingFills.length) {
                    lines.push('');
                    lines.push(`📜 *Real fill(s) with no matching trades row — needs manual review:*`);
                    r.missingFills.forEach(m => lines.push(`  • ${m}`));
                }
                if (r.fillErrors.length) {
                    lines.push('');
                    lines.push(`⚠️ *Fill-history check issue(s)* (non-blocking, worth a manual look):`);
                    r.fillErrors.forEach(e => lines.push(`  • ${e}`));
                }
                lines.push('');
                lines.push(r.ok
                    ? '_All discrepancies corrected. Alpaca is source of truth._'
                    : '_⛔ Fix errors manually then clear Redis HALT\\_ALL to resume._'
                );

                try { await alertService.sendMessage(user.id, lines.join('\n')); } catch (_) {}
            }

            // If auto-fix of a real mismatch failed, halt trading until resolved manually.
            // Network errors (r.networkError=true) are transient — never halt for those.
            if (!r.ok && !r.networkError) {
                try {
                    const redisState = require('./redisStateService');
                    const reason = `RECON_FAILURE: position reconciliation errors for user ${user.id} — ${r.errors.join('; ')}`;
                    await redisState.setHaltAll(reason);
                    logger.error('[Reconcile] HALT_ALL set — reconciliation errors, trading suspended', {
                        userId: user.id, errors: r.errors
                    });
                } catch (redisErr) {
                    logger.warn('[Reconcile] Could not set Redis HALT_ALL', { err: redisErr.message });
                }
            }
        } catch (err) {
            logger.error('[Reconcile] Unexpected error for user', { userId: user.id, err: err.message });
            totalErrors++;
        }
    }

    logger.info('[Reconcile] Done', { trigger, totalIssues, totalErrors });
    return { totalIssues, totalErrors };
}

module.exports = {
    reconcilePositions,
    runMorningReconciliation,
    reconcileFillHistory // exported 2026-09-17 for testability
};
