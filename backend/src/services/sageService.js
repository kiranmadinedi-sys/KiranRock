const fs   = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');
const { query }  = require('../config/database');

const SAGE_DIR              = path.join(__dirname, '../../data/sage');
const ADJUSTMENTS_FILE      = path.join(SAGE_DIR, 'learned_adjustments.json');
const EXPERIMENTAL_FILE     = path.join(SAGE_DIR, 'experimental_signals.txt');
const CHANGELOG_FILE        = path.join(SAGE_DIR, 'changelog.txt');
const FIRST_SEEN_FILE       = path.join(SAGE_DIR, 'signal_first_seen.json');
const MAX_ADJ_PER_ITEM      = 3; // PANTHEON governance: SAGE may auto-adjust ORACLE by at most ±3 pts
const EXPERIMENTAL_DAYS     = 30; // signals spend 30 days in experimental before promotion candidate

/**
 * SAGE Service — The Learning Brain of the PANTHEON system.
 *
 * Responsibilities:
 *  1. getStrategyMetrics()        — win rate + win/loss ratio for Kelly Criterion
 *  2. generateLearnings()         — analyse closed trades, write learned_adjustments.json
 *  3. getLearningAdjustments()    — read that file and return score tweaks for ORACLE
 */

const DEFAULT_METRICS = {
    winProbability: 0.55,
    winLossRatio:   1.5,
};

class SageService {
    constructor() {
        logger.info('[SAGE] Service initialized.');
        this._ensureSageDir();
    }

    _ensureSageDir() {
        try {
            if (!fs.existsSync(SAGE_DIR)) fs.mkdirSync(SAGE_DIR, { recursive: true });
        } catch (e) {
            logger.warn('[SAGE] Could not create data/sage directory', { err: e.message });
        }
    }

    // ─── 1. Kelly metrics ────────────────────────────────────────────────────

    async _fetchClosedTrades({ userId = null, liveOnly = false } = {}) {
        // executed_by NOT IN (...) rather than an include-list: matches whatever real
        // automated-trade tags exist (ALPACA_PAPER, ALPACA_LIVE, reconciler, AI_BOT, etc.)
        // instead of a specific value ('ENHANCED_AI') that was never actually used, which
        // made this always fall through to DEFAULT_METRICS (found 2026-08-05, same root
        // cause as the ActivationGate fix). pnl IS NOT NULL is the reliable "really closed"
        // signal — status='CLOSED' isn't set consistently for direct bot sells.
        const conditions = [
            `t.action = 'SELL'`,
            `t.pnl IS NOT NULL`,
            `t.executed_by NOT IN ('MANUAL', 'USER', 'health_monitor_dup')`,
        ];
        const params = [];
        let join = '';

        if (userId) {
            params.push(userId);
            conditions.push(`t.user_id = $${params.length}`);
        } else if (liveOnly) {
            // Blend across live accounts only — excludes any account still running on
            // shared/paper Alpaca credentials, so a high-volume paper test account can't
            // dilute the Kelly metrics that size real-money live positions (found 2026-09-05:
            // one paper account traded 5-6x kmadined's volume at a materially worse win rate,
            // pooled together with zero separation before this fix).
            join = 'JOIN users u ON u.id = t.user_id';
            conditions.push(`u.alpaca_paper = false`);
        }

        const res = await query(
            `SELECT t.pnl FROM trades t ${join} WHERE ${conditions.join(' AND ')}`,
            params
        );
        return res.rows;
    }

    _computeMetrics(completedTrades) {
        const winningTrades  = completedTrades.filter(t => parseFloat(t.pnl) > 0);
        const losingTrades   = completedTrades.filter(t => parseFloat(t.pnl) <= 0);
        const winProbability = winningTrades.length / completedTrades.length;

        const totalWin  = winningTrades.reduce((s, t) => s + parseFloat(t.pnl), 0);
        const totalLoss = Math.abs(losingTrades.reduce((s, t) => s + parseFloat(t.pnl), 0));

        if (losingTrades.length  === 0) return { winProbability, winLossRatio: 10 };
        if (winningTrades.length === 0) return { winProbability, winLossRatio: 0  };

        const winLossRatio = (totalWin / winningTrades.length) / (totalLoss / losingTrades.length);
        return { winProbability, winLossRatio };
    }

    /**
     * Kelly metrics, scoped to the calling account wherever there's enough of its own
     * history to trust. Falls back to a live-accounts-only blended pool, then to
     * DEFAULT_METRICS, rather than ever blending in a paper/test account's trades.
     *
     * @param {string|null} userId — omit for the old global-blend behavior (used by the
     *                                admin dashboard's system-wide view).
     */
    async getStrategyMetrics(userId = null) {
        try {
            if (userId) {
                const own = await this._fetchClosedTrades({ userId });
                if (own.length >= 20) {
                    const metrics = this._computeMetrics(own);
                    logger.info(`[SAGE] Metrics from ${own.length} of this account's own trades`, metrics);
                    return metrics;
                }
                logger.info(`[SAGE] Only ${own.length} own closed trades — falling back to live-account pool`);
            }

            const liveBlend = await this._fetchClosedTrades({ liveOnly: true });
            if (liveBlend.length >= 20) {
                const metrics = this._computeMetrics(liveBlend);
                logger.info(`[SAGE] Metrics from ${liveBlend.length} live-account trades (blended pool)`, metrics);
                return metrics;
            }

            logger.warn(`[SAGE] Insufficient live trade history (${liveBlend.length} trades). Using default metrics.`);
            return DEFAULT_METRICS;

        } catch (error) {
            logger.error('[SAGE] Error calculating strategy metrics:', error);
            return DEFAULT_METRICS;
        }
    }

    // ─── Experimental-hold bookkeeping ────────────────────────────────────────
    // Added 2026-09-05. Previously a "new" signal (setup/sector/pattern first crossing
    // the ≥5-trade threshold) was logged to experimental_signals.txt with a
    // promote_after date purely for a human to read — but applySageAdj() applied its
    // score adjustment to live scoring the very same cycle it appeared, regardless of
    // that date. The 30-day "experimental" period was cosmetic: nothing actually held
    // a new signal back from swinging real trades while it was still unproven. This
    // tracks each signal's first-ever-observed date permanently and genuinely
    // withholds its adjustment from applySageAdj() until EXPERIMENTAL_DAYS has
    // elapsed — closing the gap between what the governance doc claimed and what the
    // code did. A signal's raw adjustment keeps recomputing every 90-day window the
    // whole time (see toAdj() above), so by the time it's old enough to apply, its
    // value already reflects whatever happened across its full probation period —
    // if the edge decayed to 0 (or flipped sign) before promotion, that's exactly
    // what goes live, not the optimistic day-one reading.
    _loadFirstSeen() {
        try {
            if (!fs.existsSync(FIRST_SEEN_FILE)) return {};
            return JSON.parse(fs.readFileSync(FIRST_SEEN_FILE, 'utf8'));
        } catch {
            return {};
        }
    }

    _saveFirstSeen(firstSeen) {
        try {
            fs.writeFileSync(FIRST_SEEN_FILE, JSON.stringify(firstSeen, null, 2));
        } catch (e) {
            logger.warn('[SAGE] Could not persist signal_first_seen.json', { err: e.message });
        }
    }

    /**
     * Record first-observed dates for any newly-nonzero key, then split each
     * category's adjustments into "mature" (probation period elapsed — safe to
     * apply) using the persisted first-seen dates. Never un-sees a key once
     * recorded, even if it drifts back to 0 in between — the clock is "how long
     * have we been watching this," not "is it currently nonzero."
     */
    _applyExperimentalHold(categories, firstSeen) {
        const now = Date.now();
        const mature = {};
        for (const [category, adjMap] of Object.entries(categories)) {
            firstSeen[category] = firstSeen[category] || {};
            mature[category] = {};
            for (const [key, val] of Object.entries(adjMap)) {
                if (val !== 0 && !firstSeen[category][key]) {
                    firstSeen[category][key] = new Date().toISOString();
                }
                const seenAt = firstSeen[category][key];
                const ageMs  = seenAt ? now - new Date(seenAt).getTime() : 0;
                mature[category][key] = (seenAt && ageMs >= EXPERIMENTAL_DAYS * 86400000) ? val : 0;
            }
        }
        return mature;
    }

    // ─── 2. Learning journal — analyse closed trades and write adjustments ───

    async generateLearnings() {
        try {
            // Pull closed AI trades with metadata from the last 90 days.
            // trade_date (not created_at — that column doesn't exist on trades) and an
            // exclude-list on executed_by (not an include-list of tags like 'ENHANCED_AI'/
            // 'AI_BRACKET' that were never actually used) — same root cause and fix pattern
            // as the ActivationGate bug found 2026-08-04. Confirmed via data/sage/ having
            // never once written learned_adjustments.json before this fix.
            // JOIN users + alpaca_paper = false: this pool feeds setup/sector/pattern
            // adjustments applied to every account's ORACLE score, live and paper alike —
            // a high-volume paper test account shouldn't get a vote in adjustments that
            // then swing real-money live scoring (found 2026-09-05, same contamination
            // as the Kelly-metrics fix above).
            const res = await query(`
                SELECT
                    t.symbol,
                    t.pnl,
                    t.sector,
                    ti.setup_family    AS setup_family,
                    ti.metadata        AS metadata
                FROM trades t
                JOIN users u
                     ON u.id = t.user_id
                LEFT JOIN trade_intelligence ti
                       ON ti.trade_ref_id LIKE t.id::text || '%'
                WHERE t.action       = 'SELL'
                  AND t.pnl         IS NOT NULL
                  AND t.executed_by NOT IN ('MANUAL', 'USER', 'health_monitor_dup')
                  AND t.trade_date  > NOW() - INTERVAL '90 days'
                  AND u.alpaca_paper = false
                ORDER BY t.trade_date DESC
                LIMIT 500
            `);

            const trades = res.rows;
            if (trades.length < 10) {
                logger.info('[SAGE] Not enough closed trades to generate learnings yet');
                return null;
            }

            // ── Aggregate by category ──────────────────────────────────────
            const bySetup  = {};
            const bySector = {};
            const byPattern = {};

            for (const t of trades) {
                const pnl    = parseFloat(t.pnl);
                const setup  = t.setup_family  || 'unknown';
                const sector = t.sector         || 'unknown';
                const pattern = t.metadata?.oraclePattern || 'None';

                [bySetup, bySector, byPattern].forEach((bucket, idx) => {
                    const key = [setup, sector, pattern][idx];
                    if (!bucket[key]) bucket[key] = { wins: 0, losses: 0, totalPnl: 0, count: 0 };
                    bucket[key].count++;
                    bucket[key].totalPnl += pnl;
                    if (pnl > 0) bucket[key].wins++;
                    else bucket[key].losses++;
                });
            }

            const toAdj = (stats) => {
                if (stats.count < 5) return 0; // not enough data
                const wr = stats.wins / stats.count;
                const avgPnl = stats.totalPnl / stats.count;
                // ±3 max, proportional to edge
                if (wr >= 0.70 && avgPnl > 0) return  MAX_ADJ_PER_ITEM;
                if (wr >= 0.60 && avgPnl > 0) return  2;
                if (wr >= 0.50)               return  0;
                if (wr >= 0.40)               return -1;
                if (wr < 0.40 && avgPnl < 0) return -MAX_ADJ_PER_ITEM;
                return 0;
            };

            const setupAdj   = Object.fromEntries(Object.entries(bySetup).map(([k, v])  => [k, toAdj(v)]));
            const sectorAdj  = Object.fromEntries(Object.entries(bySector).map(([k, v]) => [k, toAdj(v)]));
            const patternAdj = Object.fromEntries(Object.entries(byPattern).map(([k, v])=> [k, toAdj(v)]));

            // Genuinely withhold unproven (< EXPERIMENTAL_DAYS old) signals from live
            // scoring — see _applyExperimentalHold's comment above.
            const firstSeen = this._loadFirstSeen();
            const mature = this._applyExperimentalHold(
                { setupAdj, sectorAdj, patternAdj },
                firstSeen
            );
            this._saveFirstSeen(firstSeen);

            const overallWinRate = (trades.filter(t => parseFloat(t.pnl) > 0).length / trades.length * 100).toFixed(1);
            const learnings = {
                generatedAt: new Date().toISOString(),
                tradeCount:  trades.length,
                // Raw values — every signal generateLearnings currently computes, regardless
                // of probation status. Kept for changelog/dashboard transparency.
                setupAdj,
                sectorAdj,
                patternAdj,
                // What applySageAdj() actually uses — same values, but zeroed for any signal
                // still inside its EXPERIMENTAL_DAYS probation window.
                setupAdjLive:   mature.setupAdj,
                sectorAdjLive:  mature.sectorAdj,
                patternAdjLive: mature.patternAdj,
                overallWinRate
            };

            // Load previous learnings to detect new signals (experimental routing)
            let previousLearnings = null;
            try {
                if (fs.existsSync(ADJUSTMENTS_FILE)) {
                    previousLearnings = JSON.parse(fs.readFileSync(ADJUSTMENTS_FILE, 'utf8'));
                }
            } catch { /* ignore parse errors */ }

            fs.writeFileSync(ADJUSTMENTS_FILE, JSON.stringify(learnings, null, 2));

            // ── Experimental signals: route newly-seen keys to experimental_signals.txt ──
            // A signal is "new" if it appears in this run but not in the previous learnings.
            const prevSetups    = new Set(Object.keys(previousLearnings?.setupAdj   || {}));
            const prevSectors   = new Set(Object.keys(previousLearnings?.sectorAdj  || {}));
            const prevPatterns  = new Set(Object.keys(previousLearnings?.patternAdj || {}));

            const newSignals = [
                ...Object.keys(setupAdj)  .filter(k => !prevSetups.has(k)   && setupAdj[k]   !== 0).map(k => `setup:${k}   adj=${setupAdj[k]}`),
                ...Object.keys(sectorAdj) .filter(k => !prevSectors.has(k)  && sectorAdj[k]  !== 0).map(k => `sector:${k}  adj=${sectorAdj[k]}`),
                ...Object.keys(patternAdj).filter(k => !prevPatterns.has(k) && patternAdj[k] !== 0).map(k => `pattern:${k} adj=${patternAdj[k]}`),
            ];

            if (newSignals.length > 0) {
                const promotionDate = new Date(Date.now() + EXPERIMENTAL_DAYS * 86400000).toISOString().slice(0, 10);
                const expLines = newSignals.map(
                    s => `[${new Date().toISOString().slice(0, 10)}] NEW  ${s}  (promote_after=${promotionDate})`
                ).join('\n') + '\n';
                fs.appendFileSync(EXPERIMENTAL_FILE, expLines);
                logger.info(`[SAGE] ${newSignals.length} new signal(s) routed to experimental_signals.txt`);
            }

            // ── Changelog: append every generation event ──────────────────────────────
            const changeEntries = [];
            if (previousLearnings) {
                for (const [k, v] of Object.entries(setupAdj)) {
                    const prev = previousLearnings.setupAdj?.[k];
                    if (prev !== undefined && prev !== v) changeEntries.push(`  setup.${k}: ${prev} → ${v}`);
                }
                for (const [k, v] of Object.entries(sectorAdj)) {
                    const prev = previousLearnings.sectorAdj?.[k];
                    if (prev !== undefined && prev !== v) changeEntries.push(`  sector.${k}: ${prev} → ${v}`);
                }
                for (const [k, v] of Object.entries(patternAdj)) {
                    const prev = previousLearnings.patternAdj?.[k];
                    if (prev !== undefined && prev !== v) changeEntries.push(`  pattern.${k}: ${prev} → ${v}`);
                }
            }
            const changelogEntry =
                `[${new Date().toISOString()}] SAGE generateLearnings\n` +
                `  trades=${trades.length} winRate=${overallWinRate}%\n` +
                (changeEntries.length > 0 ? changeEntries.join('\n') + '\n' : `  no adjustment changes\n`) +
                '\n';
            fs.appendFileSync(CHANGELOG_FILE, changelogEntry);

            const countHeld = (raw, live) =>
                Object.keys(raw).filter(k => raw[k] !== 0 && live[k] === 0).length;
            const heldInProbation =
                countHeld(setupAdj, mature.setupAdj) +
                countHeld(sectorAdj, mature.sectorAdj) +
                countHeld(patternAdj, mature.patternAdj);

            logger.info('[SAGE] Learned adjustments written', {
                file: ADJUSTMENTS_FILE,
                setups: Object.keys(setupAdj).length,
                sectors: Object.keys(sectorAdj).length,
                patterns: Object.keys(patternAdj).length,
                newSignals: newSignals.length,
                heldInProbation,
                winRate: overallWinRate + '%'
            });
            return learnings;

        } catch (err) {
            logger.error('[SAGE] generateLearnings failed', { err: err.message });
            return null;
        }
    }

    // ─── 3. Read adjustments for ORACLE to apply ─────────────────────────────

    getLearningAdjustments() {
        try {
            if (!fs.existsSync(ADJUSTMENTS_FILE)) return null;
            const raw  = fs.readFileSync(ADJUSTMENTS_FILE, 'utf8');
            const data = JSON.parse(raw);
            // Stale if older than 35 days
            if (Date.now() - new Date(data.generatedAt).getTime() > 35 * 86400000) return null;
            return data;
        } catch {
            return null;
        }
    }

    /**
     * Apply SAGE-learned score adjustments for a given opportunity.
     * Returns the total adjustment (capped at ±5 total to prevent over-riding ORACLE).
     *
     * Uses the *Live maps (probation-filtered — see _applyExperimentalHold) when
     * present. Falls back to the raw maps for a learned_adjustments.json written
     * before this fix existed, so a stale file doesn't silently go inert; the very
     * next generateLearnings() run upgrades it to the filtered format.
     */
    applySageAdj(setupFamily, sector, oraclePattern) {
        const adj = this.getLearningAdjustments();
        if (!adj) return 0;

        const setupMap   = adj.setupAdjLive   || adj.setupAdj   || {};
        const sectorMap   = adj.sectorAdjLive  || adj.sectorAdj  || {};
        const patternMap = adj.patternAdjLive || adj.patternAdj || {};

        const s   = setupMap[setupFamily]     || 0;
        const sec = sectorMap[sector]         || 0;
        const p   = patternMap[oraclePattern] || 0;

        // Combined cap ±5 — PANTHEON governance allows auto ±5 before Kiran review
        return Math.max(-5, Math.min(5, s + sec + p));
    }
}

module.exports = new SageService();
