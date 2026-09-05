/**
 * LOCAL BRAIN — Historical Pattern Intelligence
 *
 * Reads closed trade history from PostgreSQL and builds a single, shared
 * win-rate lookup table by (sector × pattern × marketRegime), applied to
 * every account's scoring. Despite the name, this is NOT scoped to "this"
 * account — one global cache, blended across every account, updated every
 * 4 hours (corrected 2026-09-05; the comment used to claim per-account
 * scoping the code never actually did).
 *
 * As of 2026-09-05 the underlying query excludes paper/test accounts
 * (users.alpaca_paper = true) so a high-volume paper account can't dilute
 * the pattern stats that then boost/penalize real-money live scoring —
 * the same contamination found in SAGE's Kelly metrics. It is still one
 * blended brain across every LIVE account, not per-account.
 *
 * Score contribution: −6 to +6 (added into ORACLE scoring pipeline)
 * Minimum trades threshold before any adjustment fires: 5 per cell.
 *
 * This is the "EVOLVE lite" — a statistical learning layer that
 * doesn't need a GPU or an ML library. It's purely trade data.
 */

const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const MIN_TRADES_FOR_ADJ  = 5;   // minimum closed trades before we trust a cell
const MAX_BOOST           = 6;   // ± cap per PANTHEON governance

let _cache = null;
let _lastRefresh = 0;

// ── Data model ────────────────────────────────────────────────────────────────
// _cache = {
//   bySector:  { 'Technology': { wins, losses, winRate }, ... }
//   byPattern: { 'VCP': { wins, losses, winRate }, ... }
//   byRegime:  { 'BULL': { wins, losses, winRate }, ... }
//   byCombined:{ 'Technology|VCP|BULL': { wins, losses, winRate }, ... }
//   totalTrades: N
//   overallWinRate: 0.xx
//   generatedAt: ISO string
// }

async function _buildBrain() {
    try {
        // Derive PnL by pairing BUY→SELL on the same symbol per user.
        // trades table schema: id, user_id, symbol, action, quantity, price,
        //   total, commission, trade_date, executed_by, notes, ai_score, sector
        const res = await query(`
            WITH buys AS (
                SELECT t.id, t.user_id, t.symbol, t.price AS buy_price, t.quantity,
                       t.trade_date AS buy_date,
                       EXTRACT(HOUR FROM t.trade_date AT TIME ZONE 'America/New_York') AS entry_hour,
                       t.executed_by, t.sector, t.ai_score, t.notes
                FROM trades t
                JOIN users u ON u.id = t.user_id
                WHERE t.action = 'BUY'
                  AND t.executed_by LIKE 'ALPACA%'
                  AND u.alpaca_paper = false
            ),
            sells AS (
                SELECT t.user_id, t.symbol, t.price AS sell_price, t.quantity,
                       t.trade_date AS sell_date
                FROM trades t
                JOIN users u ON u.id = t.user_id
                WHERE t.action = 'SELL'
                  AND u.alpaca_paper = false
            ),
            matched AS (
                SELECT DISTINCT ON (b.id)
                    b.symbol,
                    b.sector,
                    b.ai_score,
                    b.notes,
                    b.entry_hour,
                    (s.sell_price - b.buy_price) * b.quantity AS pnl,
                    s.sell_price,
                    b.buy_price
                FROM buys b
                JOIN sells s
                  ON s.user_id = b.user_id
                 AND s.symbol  = b.symbol
                 AND s.sell_date >= b.buy_date
                ORDER BY b.id, s.sell_date ASC
            )
            SELECT symbol, sector, ai_score, notes, entry_hour, pnl
            FROM matched
            ORDER BY pnl DESC
            LIMIT 2000
        `);

        const trades = res.rows;

        if (trades.length < 5) {
            logger.info('[LocalBrain] Insufficient paired trade history — brain inactive', { count: trades.length });
            return null;
        }

        const bySector    = {};
        const byPattern   = {};
        const byRegime    = {};
        const byCombined  = {};
        const byHourOfDay = {}; // hour (0-23 ET) → win/loss cell

        for (const t of trades) {
            const pnl     = parseFloat(t.pnl);
            const win     = pnl > 0;
            const sector  = t.sector || 'Unknown';
            // notes field stores JSON-stringified metadata in some bot versions
            let meta = {};
            try { meta = JSON.parse(t.notes || '{}'); } catch { /* notes is plain text */ }
            const pattern = meta.oraclePattern || meta.pattern || 'None';
            const regime  = meta.regime || 'UNKNOWN';
            const hour    = t.entry_hour != null ? String(parseInt(t.entry_hour)) : null;

            const cells = [
                [bySector,   sector],
                [byPattern,  pattern],
                [byRegime,   regime],
                [byCombined, `${sector}|${pattern}|${regime}`],
            ];
            if (hour !== null) cells.push([byHourOfDay, hour]);

            for (const [bucket, key] of cells) {
                if (!bucket[key]) bucket[key] = { wins: 0, losses: 0, totalPnl: 0 };
                bucket[key].totalPnl += pnl;
                if (win) bucket[key].wins++; else bucket[key].losses++;
            }
        }

        // Compute win rates
        const addWinRate = (bucket) => {
            for (const v of Object.values(bucket)) {
                const total = v.wins + v.losses;
                v.total   = total;
                v.winRate = total > 0 ? v.wins / total : 0;
                v.avgPnl  = total > 0 ? v.totalPnl / total : 0;
            }
        };
        addWinRate(bySector);
        addWinRate(byPattern);
        addWinRate(byRegime);
        addWinRate(byCombined);
        addWinRate(byHourOfDay);

        const overallWins = trades.filter(t => parseFloat(t.pnl) > 0).length;

        const brain = {
            bySector, byPattern, byRegime, byCombined, byHourOfDay,
            totalTrades:    trades.length,
            overallWinRate: overallWins / trades.length,
            generatedAt:    new Date().toISOString(),
        };

        logger.info('[LocalBrain] Brain built', {
            trades:    trades.length,
            winRate:   (brain.overallWinRate * 100).toFixed(1) + '%',
            sectors:   Object.keys(bySector).length,
            patterns:  Object.keys(byPattern).length,
            regimes:   Object.keys(byRegime).length,
            combos:    Object.keys(byCombined).length,
            hours:     Object.keys(byHourOfDay).length,
        });

        return brain;
    } catch (err) {
        logger.warn('[LocalBrain] Brain build failed', { err: err.message });
        return null;
    }
}

async function _ensureFresh() {
    const now = Date.now();
    if (_cache && (now - _lastRefresh) < REFRESH_INTERVAL_MS) return _cache;
    _cache = await _buildBrain();
    _lastRefresh = now;
    return _cache;
}

/**
 * Compute score boost for a given trade opportunity using local history.
 *
 * @param {object} params
 * @param {string} params.sector       — e.g. 'Technology'
 * @param {string} params.pattern      — e.g. 'VCP', 'Cup&Handle', 'None'
 * @param {string} params.regime       — e.g. 'BULL', 'BEAR', 'SIDEWAYS'
 * @returns {Promise<{ boost: number, reason: string, confidence: string }>}
 */
async function getScoreBoost({ sector = 'Unknown', pattern = 'None', regime = 'UNKNOWN', entryHour = null } = {}) {
    const brain = await _ensureFresh();

    if (!brain) {
        return { boost: 0, reason: 'no_data', confidence: 'NONE' };
    }

    const overallWR = brain.overallWinRate;

    // ── Combined cell (most specific — highest priority) ─────────────────────
    const comboKey  = `${sector}|${pattern}|${regime}`;
    const comboCell = brain.byCombined[comboKey];

    if (comboCell && comboCell.total >= MIN_TRADES_FOR_ADJ) {
        const edge = comboCell.winRate - overallWR;
        const boost = _edgeToBoost(edge, comboCell.avgPnl, comboCell.total);
        return {
            boost,
            reason: `combo:${comboKey} wr=${(comboCell.winRate * 100).toFixed(0)}% n=${comboCell.total}`,
            confidence: comboCell.total >= 15 ? 'HIGH' : 'MEDIUM',
        };
    }

    // ── Pattern cell (second priority) ───────────────────────────────────────
    const patCell = brain.byPattern[pattern];
    if (patCell && patCell.total >= MIN_TRADES_FOR_ADJ && pattern !== 'None') {
        const edge  = patCell.winRate - overallWR;
        const boost = _edgeToBoost(edge, patCell.avgPnl, patCell.total);
        return {
            boost,
            reason: `pattern:${pattern} wr=${(patCell.winRate * 100).toFixed(0)}% n=${patCell.total}`,
            confidence: patCell.total >= 15 ? 'HIGH' : 'MEDIUM',
        };
    }

    // ── Sector cell ──────────────────────────────────────────────────────────
    const secCell = brain.bySector[sector];
    if (secCell && secCell.total >= MIN_TRADES_FOR_ADJ) {
        const edge  = secCell.winRate - overallWR;
        const boost = _edgeToBoost(edge, secCell.avgPnl, secCell.total);

        // ── Time-of-day addend (stacks on top, capped at ±3) ─────────────────
        let hourAddend = 0;
        if (entryHour !== null && brain.byHourOfDay) {
            const hourCell = brain.byHourOfDay[String(entryHour)];
            if (hourCell && hourCell.total >= MIN_TRADES_FOR_ADJ) {
                const hourEdge = hourCell.winRate - overallWR;
                hourAddend = Math.max(-3, Math.min(3, Math.round((hourEdge / 0.20) * 3)));
            }
        }

        return {
            boost: Math.max(-MAX_BOOST, Math.min(MAX_BOOST, boost + hourAddend)),
            reason: `sector:${sector} wr=${(secCell.winRate * 100).toFixed(0)}% n=${secCell.total}` +
                    (hourAddend !== 0 ? ` | hour:${entryHour} adj:${hourAddend > 0 ? '+' : ''}${hourAddend}` : ''),
            confidence: 'LOW',
        };
    }

    // ── Time-of-day only (fallback when no sector data) ───────────────────────
    if (entryHour !== null && brain.byHourOfDay) {
        const hourCell = brain.byHourOfDay[String(entryHour)];
        if (hourCell && hourCell.total >= MIN_TRADES_FOR_ADJ) {
            const edge  = hourCell.winRate - overallWR;
            const boost = Math.max(-3, Math.min(3, Math.round((edge / 0.20) * 3)));
            if (boost !== 0) {
                return {
                    boost,
                    reason: `hour:${entryHour} wr=${(hourCell.winRate * 100).toFixed(0)}% n=${hourCell.total}`,
                    confidence: 'LOW',
                };
            }
        }
    }

    return { boost: 0, reason: 'insufficient_data', confidence: 'NONE' };
}

/**
 * Map edge (win-rate above baseline) + avgPnl direction → capped score boost.
 * Strong positive edge AND positive average PnL → full +6.
 * Negative edge AND negative average PnL → full −6.
 */
function _edgeToBoost(edge, avgPnl, sampleSize) {
    // Scale linearly: ±20% win-rate edge = ±6 pts (max)
    let raw = (edge / 0.20) * MAX_BOOST;
    raw = Math.max(-MAX_BOOST, Math.min(MAX_BOOST, raw));

    // Attenuate slightly for small samples (< 20 trades)
    if (sampleSize < 20) raw *= 0.7;
    if (sampleSize < 10) raw *= 0.5;

    // Flip direction if PnL sign contradicts win rate (edge might be from tiny wins + big losses)
    if (raw > 0 && avgPnl < 0) raw = Math.max(0, raw * 0.3);
    if (raw < 0 && avgPnl > 0) raw = Math.min(0, raw * 0.3);

    return Math.round(raw); // integer, ±6 max
}

/**
 * Return the full brain snapshot (for API/dashboard inspection).
 */
async function getBrainSnapshot() {
    const brain = await _ensureFresh();
    if (!brain) return { active: false, reason: 'insufficient_trade_history' };
    return { active: true, ...brain };
}

/**
 * Force a refresh of the brain cache (call after a trading session ends).
 */
async function refresh() {
    _cache = await _buildBrain();
    _lastRefresh = Date.now();
    return _cache;
}

module.exports = { getScoreBoost, getBrainSnapshot, refresh };
