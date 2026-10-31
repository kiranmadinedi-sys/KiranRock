/**
 * Weekly worst-trade look-back (2026-11-01). Each Saturday: the week's 3 worst swing exits per
 * account, what the bot saw when it bought, how the price moved while held and after the exit,
 * and a verdict — bad entry, gave back a winner, normal stop, overnight gap, one-session crash,
 * or a possible bug (loss far past a normal stop with neither). news_momentum took weeks to notice from totals
 * alone; this surfaces it per trade.
 *
 * Prices come from history_bars, which the Saturday market study tops up before the report.
 */
const { query } = require('../config/database');

const DAY = 86400000;
const OVERSHOOT_PCT = -6;   // a normal stop is ~3-5.5%; worse than this needs explaining
const BAD_ENTRY_MAX = 1;    // never rose more than 1% above entry
const WINNER_MIN = 3;       // was up 3%+ before turning into a loss
const RECOVER_MIN = 3;      // rose 3%+ within 5 trading days after the exit
const GAP_MIN = -3;         // overnight gap this size or worse — a stop can't fill above the open

/**
 * Pure: verdict for one losing trade. bestGainPct / afterPct / worstGapPct are null when bars
 * are missing. PM 2026-10-21 (−7.7%) was an earnings gap at the open, not a stop bug.
 */
function classify({ pnlPct, bestGainPct, afterPct, worstGapPct = null, worstSessionPct = null }) {
    let v;
    if (pnlPct <= OVERSHOOT_PCT && worstGapPct != null && worstGapPct <= GAP_MIN) {
        v = `Gapped down ${Math.abs(worstGapPct).toFixed(1)}% overnight (earnings/news?) — the stop couldn't fill higher`;
    } else if (pnlPct <= OVERSHOOT_PCT && worstSessionPct != null && worstSessionPct <= OVERSHOOT_PCT) {
        // VLO 2026-10-27: open → low −8.5% in one session; the stop filled on the way down
        v = `Fell ${Math.abs(worstSessionPct).toFixed(1)}% within one session — the stop filled on the way down`;
    } else if (pnlPct <= OVERSHOOT_PCT) {
        v = 'Possible bug — loss far past a normal stop with no overnight gap (check the stop order, or a fast fall)';
    } else if (bestGainPct == null) v = 'No price data for the hold';
    else if (bestGainPct < BAD_ENTRY_MAX) v = 'Bad entry — never went up';
    else if (bestGainPct >= WINNER_MIN) v = `Gave back a winner — was up ${bestGainPct.toFixed(1)}% first (exit issue)`;
    else v = 'Normal stop — small rise, then stopped';
    if (afterPct != null && afterPct >= RECOVER_MIN) v += `; then recovered +${afterPct.toFixed(1)}% within 5 days`;
    return v;
}

async function _bars(symbol, fromDay, count) {
    return (await query(
        `SELECT d::text AS d, o::float AS o, h::float AS h, l::float AS l, c::float AS c FROM history_bars
         WHERE symbol = $1 AND d >= $2::date ORDER BY d LIMIT $3`, [symbol, fromDay, count])).rows;
}

async function worstTrades(userId, now = new Date(), limit = 3) {
    const since = new Date(now.getTime() - 7 * DAY);
    const sells = (await query(
        `SELECT id, symbol, quantity::float AS qty, price::float AS price, pnl::float AS pnl, pnl_percent::float AS pnl_pct,
                hold_hours::float AS hold_hours, ai_score, entry_regime, notes, trade_date
         FROM trades WHERE user_id::text = $1 AND action = 'SELL' AND pnl < 0 AND trade_date >= $2 AND trade_date < $3
         ORDER BY pnl LIMIT $4`, [String(userId), since, now, limit])).rows;
    const out = [];
    for (const t of sells) {
        const sellAt = new Date(t.trade_date);
        const buyAt = new Date(sellAt.getTime() - (t.hold_hours || 0) * 3600000);
        const entry = t.qty > 0 ? t.price - t.pnl / t.qty : null;
        const sellDay = sellAt.toISOString().slice(0, 10);
        const held = (await _bars(t.symbol, buyAt.toISOString().slice(0, 10), 60)).filter(b => b.d <= sellDay);
        const bestGainPct = entry && held.length ? (Math.max(...held.map(b => b.h)) / entry - 1) * 100 : null;
        const gaps = held.slice(1).map((b, i) => (b.o / held[i].c - 1) * 100);
        const worstGapPct = gaps.length ? Math.min(...gaps) : null;
        const worstSessionPct = held.length ? Math.min(...held.map(b => (b.l / b.o - 1) * 100)) : null;
        const after = (await _bars(t.symbol, sellDay, 6)).filter(b => b.d > sellDay);
        const afterPct = after.length >= 5 ? (after[4].c / t.price - 1) * 100 : null;
        const j = (await query(
            `SELECT setup_family FROM trade_decision_journal
             WHERE user_id::text = $1 AND symbol = $2 AND setup_family IS NOT NULL AND created_at <= $3
             ORDER BY created_at DESC LIMIT 1`, [String(userId), t.symbol, new Date(buyAt.getTime() + 3600000)])).rows[0];
        const notes = String(t.notes || '');
        out.push({
            symbol: t.symbol, pnl: t.pnl, pnlPct: t.pnl_pct, score: t.ai_score, regime: t.entry_regime,
            setup: j?.setup_family || null, holdDays: (t.hold_hours || 0) / 24,
            // reconciler-caught exits say "... exit type: stop_loss_reconciled"
            exit: (notes.match(/exit type: (\w+)/)?.[1] || notes.split(/[:—(]/)[0]).trim().slice(0, 40),
            bestGainPct, afterPct, afterKnown: after.length >= 5,
            verdict: classify({ pnlPct: t.pnl_pct, bestGainPct, afterPct, worstGapPct, worstSessionPct }),
        });
    }
    return out;
}

/** Lines for the Saturday report. */
async function reportLines(userId, now = new Date()) {
    const rows = await worstTrades(userId, now);
    if (!rows.length) return ['No losing exits this week.'];
    return rows.map(r => [
        `${r.symbol} −$${Math.abs(r.pnl).toFixed(2)} (${r.pnlPct.toFixed(1)}%)`,
        `score ${r.score ?? '?'}, ${r.setup || 'setup ?'}, ${r.regime || '?'} market, held ${r.holdDays.toFixed(1)}d, exit: ${r.exit || '?'}`,
        `best while held ${r.bestGainPct == null ? 'n/a' : `+${r.bestGainPct.toFixed(1)}%`}, 5 days after exit ${r.afterKnown ? `${r.afterPct >= 0 ? '+' : ''}${r.afterPct.toFixed(1)}%` : 'too soon'}`,
        `→ ${r.verdict}`,
    ].join(' · '));
}

module.exports = { classify, worstTrades, reportLines };
