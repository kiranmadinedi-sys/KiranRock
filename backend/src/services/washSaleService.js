/**
 * Wash-sale tracker (2026-11-01). The swing bot often re-buys a stock within 30 days of selling it
 * at a loss; in a taxable account that loss is disallowed for now and added to the cost of the
 * replacement shares (it comes back when those are finally sold without another wash).
 *
 * Estimate only, from this account's own trades: Alpaca reports wash sales on the 1099-B, and
 * purchases in other accounts (IRA, another broker) also count but are invisible here. Options
 * and crypto are left out.
 *
 * Rule used: a loss sale is washed by shares bought within 30 days after it, or bought within
 * 30 days before it that were still held after the sale. Each replacement share washes one
 * loss share only. Disallowed = loss × matched shares / shares sold.
 */
const { query } = require('../config/database');

const DAY = 86400000;
const WINDOW_DAYS = 30;
const STOCK_SYMBOL = /^[A-Z][A-Z.]{0,5}$/;

/**
 * Pure: trades [{id, symbol, action, quantity, pnl, trade_date}] → wash-sale rows, one per loss
 * sale in [from, to) that was at least partly washed.
 */
function findWashSales(trades, { from, to = new Date(8.64e15) } = {}) {
    const fromT = from ? new Date(from).getTime() : -Infinity, toT = new Date(to).getTime();
    const bySym = new Map();
    for (const t of trades) {
        const sym = String(t.symbol || '').toUpperCase();
        if (!STOCK_SYMBOL.test(sym)) continue;
        if (!bySym.has(sym)) bySym.set(sym, []);
        bySym.get(sym).push({ ...t, symbol: sym, at: new Date(t.trade_date).getTime(), qty: Number(t.quantity) || 0 });
    }
    const out = [];
    for (const [symbol, list] of bySym) {
        list.sort((a, b) => a.at - b.at || a.id - b.id);
        const used = new Map(); // buy id → shares already used as replacement
        let pos = 0;
        for (const t of list) {
            const side = String(t.action).toUpperCase();
            if (side === 'BUY') { pos += t.qty; continue; }
            if (side !== 'SELL') continue;
            pos = Math.max(0, pos - t.qty);
            const loss = Number(t.pnl);
            if (!(loss < 0) || !(t.qty > 0) || t.at < fromT || t.at >= toT) continue;
            // Buys before the sale only count up to the shares still held after it.
            let need = t.qty, matched = 0, heldAfter = pos;
            const free = b => b.qty - (used.get(b.id) || 0);
            const take = (b, cap) => {
                const n = Math.min(free(b), need, cap);
                if (n <= 0) return 0;
                used.set(b.id, (used.get(b.id) || 0) + n);
                need -= n; matched += n;
                return n;
            };
            for (const b of list) {
                if (need <= 0 || heldAfter <= 0) break;
                if (String(b.action).toUpperCase() !== 'BUY' || b.at >= t.at || b.at < t.at - WINDOW_DAYS * DAY) continue;
                heldAfter -= take(b, heldAfter);
            }
            for (const b of list) {
                if (need <= 0) break;
                if (String(b.action).toUpperCase() !== 'BUY' || b.at <= t.at || b.at > t.at + WINDOW_DAYS * DAY) continue;
                take(b, Infinity);
            }
            if (matched > 0) {
                out.push({
                    symbol, saleId: t.id, saleDate: new Date(t.at).toISOString().slice(0, 10),
                    loss, sharesSold: t.qty, sharesMatched: matched,
                    disallowed: loss * Math.min(1, matched / t.qty),
                });
            }
        }
    }
    return out.sort((a, b) => a.saleDate.localeCompare(b.saleDate));
}

/** Year-to-date summary for one account: realized P&L, washed losses, and symbols still open. */
async function summary(userId, year = new Date().getFullYear()) {
    const r = await query(
        `SELECT id, symbol, action, quantity, pnl, trade_date FROM trades
         WHERE user_id::text = $1 AND action IN ('BUY', 'SELL') AND trade_date < $2::date
         ORDER BY trade_date, id`, [String(userId), `${year + 1}-02-01`]);
    const from = `${year}-01-01`, to = `${year + 1}-01-01`;
    const rows = findWashSales(r.rows, { from, to });
    const realized = r.rows
        .filter(t => t.action === 'SELL' && t.pnl != null && new Date(t.trade_date) >= new Date(from) && new Date(t.trade_date) < new Date(to))
        .reduce((s, t) => s + Number(t.pnl), 0);
    const held = new Set((await query(
        `SELECT UPPER(symbol) AS s FROM holdings WHERE user_id::text = $1 AND quantity > 0`, [String(userId)])).rows.map(x => x.s));
    const disallowed = rows.reduce((s, x) => s + x.disallowed, 0);
    // A washed loss is still deferred while its symbol is held (it returns when that position closes).
    const stillDeferred = rows.filter(x => held.has(x.symbol)).reduce((s, x) => s + x.disallowed, 0);
    const bySymbol = {};
    for (const x of rows) bySymbol[x.symbol] = (bySymbol[x.symbol] || 0) + x.disallowed;
    return { year, realized, disallowed, stillDeferred, count: rows.length, bySymbol, rows };
}

/** Lines for the Saturday report. */
async function reportLines(userId, year) {
    const s = await summary(userId, year);
    const usd = v => `${v < 0 ? '−' : ''}$${Math.abs(v).toFixed(2)}`;
    const top = Object.entries(s.bySymbol).sort((a, b) => a[1] - b[1]).slice(0, 5)
        .map(([sym, v]) => `${sym} ${usd(v)}`).join(', ');
    return [
        `${s.year} realized P&L ${usd(s.realized)} · ${s.count} loss sales washed (re-bought within 30 days): ${usd(s.disallowed)} of losses deferred`,
        ...(s.count ? [`Biggest: ${top}`] : []),
        ...(s.stillDeferred ? [`Still deferred in open positions: ${usd(s.stillDeferred)} — comes back when those positions close`] : []),
        'Estimate from this account only; Alpaca\'s 1099-B is the official number.',
    ];
}

module.exports = { findWashSales, summary, reportLines, WINDOW_DAYS };
