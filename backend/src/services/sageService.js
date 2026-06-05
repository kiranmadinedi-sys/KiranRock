const fs   = require('fs');
const path = require('path');
const { logger } = require('../utils/logger');
const { query }  = require('../config/database');

const SAGE_DIR              = path.join(__dirname, '../../data/sage');
const ADJUSTMENTS_FILE      = path.join(SAGE_DIR, 'learned_adjustments.json');
const EXPERIMENTAL_FILE     = path.join(SAGE_DIR, 'experimental_signals.txt');
const CHANGELOG_FILE        = path.join(SAGE_DIR, 'changelog.txt');
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

    async getStrategyMetrics() {
        try {
            const res = await query(
                "SELECT pnl FROM trades WHERE status = 'CLOSED' AND executed_by = 'ENHANCED_AI' AND pnl IS NOT NULL"
            );
            const completedTrades = res.rows;

            if (completedTrades.length < 20) {
                logger.warn(`[SAGE] Insufficient trade history (${completedTrades.length} trades). Using default metrics.`);
                return DEFAULT_METRICS;
            }

            const winningTrades   = completedTrades.filter(t => parseFloat(t.pnl) > 0);
            const losingTrades    = completedTrades.filter(t => parseFloat(t.pnl) <= 0);
            const winProbability  = winningTrades.length / completedTrades.length;

            const totalWin  = winningTrades.reduce((s, t) => s + parseFloat(t.pnl), 0);
            const totalLoss = Math.abs(losingTrades.reduce((s, t) => s + parseFloat(t.pnl), 0));

            if (losingTrades.length  === 0) return { winProbability, winLossRatio: 10 };
            if (winningTrades.length === 0) return { winProbability, winLossRatio: 0  };

            const winLossRatio = (totalWin / winningTrades.length) / (totalLoss / losingTrades.length);
            const metrics = { winProbability, winLossRatio };
            logger.info(`[SAGE] Metrics from ${completedTrades.length} trades`, metrics);
            return metrics;

        } catch (error) {
            logger.error('[SAGE] Error calculating strategy metrics:', error);
            return DEFAULT_METRICS;
        }
    }

    // ─── 2. Learning journal — analyse closed trades and write adjustments ───

    async generateLearnings() {
        try {
            // Pull closed AI trades with metadata from the last 90 days
            const res = await query(`
                SELECT
                    t.symbol,
                    t.pnl,
                    t.sector,
                    ti.setup_family    AS setup_family,
                    ti.metadata        AS metadata
                FROM trades t
                LEFT JOIN trade_intelligence ti
                       ON ti.trade_ref_id LIKE t.id::text || '%'
                WHERE t.status       = 'CLOSED'
                  AND t.executed_by  IN ('AI_BOT','ENHANCED_AI','AI_BRACKET')
                  AND t.pnl         IS NOT NULL
                  AND t.created_at  > NOW() - INTERVAL '90 days'
                ORDER BY t.created_at DESC
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

            const overallWinRate = (trades.filter(t => parseFloat(t.pnl) > 0).length / trades.length * 100).toFixed(1);
            const learnings = {
                generatedAt: new Date().toISOString(),
                tradeCount:  trades.length,
                setupAdj,
                sectorAdj,
                patternAdj,
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

            logger.info('[SAGE] Learned adjustments written', {
                file: ADJUSTMENTS_FILE,
                setups: Object.keys(setupAdj).length,
                sectors: Object.keys(sectorAdj).length,
                patterns: Object.keys(patternAdj).length,
                newSignals: newSignals.length,
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
     */
    applySageAdj(setupFamily, sector, oraclePattern) {
        const adj = this.getLearningAdjustments();
        if (!adj) return 0;

        const s  = adj.setupAdj?.[setupFamily]   || 0;
        const sec = adj.sectorAdj?.[sector]       || 0;
        const p  = adj.patternAdj?.[oraclePattern] || 0;

        // Combined cap ±5 — PANTHEON governance allows auto ±5 before Kiran review
        return Math.max(-5, Math.min(5, s + sec + p));
    }
}

module.exports = new SageService();
