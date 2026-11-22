#!/usr/bin/env node
/**
 * One-time repair (2026-11-22): recompute crypto_trades from the broker's real orders.
 *
 * Why: the "already closed at Alpaca" path sometimes recorded a sell from an OLDER trade
 * (SOL 11-06 booked +$126.75; the real result was about −$12.75), and P&L ignored Alpaca's
 * 0.25% crypto fees. The bot's table summed to about +$3; the broker showed about −$215.
 *
 * For each row: find the real entry buy (same pair, price match, closest time), then every
 * sell filled after that buy and before the next buy of that pair. Recompute exit price
 * (quantity-weighted), exit time, label and net P&L with fees. The old values are kept in
 * metadata.original so the change can be reversed.
 *
 * PAPER ONLY (refuses a live account). Dry run by default:
 *   node scripts/recomputeCryptoTrades.js            → prints what would change
 *   node scripts/recomputeCryptoTrades.js --apply    → writes the changes
 */
require('dotenv').config({ quiet: true });
const axios = require('axios');
const { query } = require('../src/config/database');
const { netPnl } = require('../src/services/cryptoDatabaseService');

const APPLY = process.argv.includes('--apply');
const BASE = 'https://paper-api.alpaca.markets/v2';

async function allClosedOrders(headers, symbol) {
    const out = [];
    let after = '2026-08-01T00:00:00Z';
    for (let i = 0; i < 50; i++) {
        const page = (await axios.get(`${BASE}/orders`, { headers, params: { status: 'closed', symbols: symbol, after, direction: 'asc', limit: 500 } })).data;
        out.push(...page);
        if (page.length < 500) break;
        after = page[page.length - 1].submitted_at;
    }
    const seen = new Set();
    return out.filter(o => !seen.has(o.id) && seen.add(o.id) && parseFloat(o.filled_qty) > 0 && o.filled_at);
}

const t = s => new Date(s).getTime();
const label = (sells) => (sells.some(o => /stop/.test(o.type || '')) ? 'broker-stop-filled' : null);

async function main() {
    const users = (await query(`SELECT DISTINCT user_id FROM crypto_trades`)).rows.map(r => r.user_id);
    let before = 0, after = 0, changed = 0, unmatched = 0;
    for (const userId of users) {
        const c = await require('../src/services/userDatabaseService').getUserAlpacaCredentials(userId);
        if (c.isPaper !== true) { console.log(`skip ${userId}: not a paper account`); continue; }
        const headers = { 'APCA-API-KEY-ID': c.keyId, 'APCA-API-SECRET-KEY': c.secretKey };
        const rows = (await query(`SELECT * FROM crypto_trades WHERE user_id = $1 ORDER BY entry_time`, [userId])).rows;
        const bySym = {};
        for (const sym of [...new Set(rows.map(r => r.symbol))]) bySym[sym] = await allClosedOrders(headers, sym);

        for (const r of rows) {
            if (r.metadata?.original) { before += +r.pnl; after += +r.pnl; continue; } // already repaired
            const orders = bySym[r.symbol];
            const buys = orders.filter(o => o.side === 'buy').sort((a, b) => t(a.filled_at) - t(b.filled_at));
            const entryPx = parseFloat(r.entry_price);
            const cands = buys.filter(o => Math.abs(parseFloat(o.filled_avg_price) / entryPx - 1) < 0.0005
                && Math.abs(t(o.filled_at) - t(r.entry_time)) < 6 * 3600e3);
            const buy = cands.sort((a, b) => Math.abs(t(a.filled_at) - t(r.entry_time)) - Math.abs(t(b.filled_at) - t(r.entry_time)))[0];
            before += +r.pnl;
            if (!buy) { unmatched++; after += +r.pnl; console.log(`NO MATCH  #${r.id} ${r.symbol} entry ${entryPx} @ ${new Date(r.entry_time).toISOString()} — left unchanged`); continue; }
            const next = buys.find(o => t(o.filled_at) > t(buy.filled_at));
            const sells = orders.filter(o => o.side === 'sell' && t(o.filled_at) >= t(buy.filled_at) && (!next || t(o.filled_at) < t(next.filled_at)));
            const soldQty = sells.reduce((a, o) => a + parseFloat(o.filled_qty), 0);
            if (!(soldQty > 0)) { unmatched++; after += +r.pnl; console.log(`NO SELL   #${r.id} ${r.symbol} — left unchanged`); continue; }
            const exitPrice = sells.reduce((a, o) => a + parseFloat(o.filled_qty) * parseFloat(o.filled_avg_price), 0) / soldQty;
            const exitTime = sells.map(o => o.filled_at).sort().pop();
            const n = netPnl({ entryPrice: entryPx, exitPrice, heldQty: parseFloat(r.quantity), buyQty: parseFloat(buy.filled_qty), soldQty });
            const reason = label(sells) || String(r.exit_reason).replace(/_stale_skip$|_corrected$/, '').replace(/^reconciliation_ghost$/, 'reconciliation_ghost-broker-fill');
            const newPnl = Math.round(n.pnl * 100) / 100;
            after += newPnl;
            const diff = newPnl - +r.pnl;
            if (Math.abs(diff) >= 0.01 || reason !== r.exit_reason) changed++;
            if (Math.abs(diff) >= 3) console.log(`#${r.id} ${r.symbol.padEnd(9)} ${new Date(r.entry_time).toISOString().slice(0, 10)} pnl ${(+r.pnl).toFixed(2)} → ${newPnl.toFixed(2)}  exit ${(+r.exit_price).toFixed(4)} → ${exitPrice.toFixed(4)}  ${r.exit_reason} → ${reason}`);
            if (APPLY) {
                const meta = { ...(r.metadata || {}), ...n.meta, buyOrderId: buy.id, sellOrderIds: sells.map(o => o.id), repairedAt: new Date().toISOString(),
                    original: { pnl: r.pnl, pnl_percent: r.pnl_percent, exit_price: r.exit_price, exit_time: r.exit_time, exit_reason: r.exit_reason } };
                await query(`UPDATE crypto_trades SET pnl = $2, pnl_percent = $3, exit_price = $4, exit_time = $5, exit_reason = $6, metadata = $7 WHERE id = $1`,
                    [r.id, newPnl, Math.round(n.pnlPercent * 10000) / 10000, exitPrice, exitTime, reason, JSON.stringify(meta)]);
            }
        }
    }
    console.log(`\nRows changed: ${changed}, unmatched (left as is): ${unmatched}`);
    console.log(`Total P&L: ${before.toFixed(2)} → ${after.toFixed(2)}  ${APPLY ? '(APPLIED)' : '(dry run — add --apply to write)'}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
