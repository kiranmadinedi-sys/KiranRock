/**
 * Full reconciler exit audit
 * Finds all reconciler-recorded SELLs and cross-references against Alpaca fill activities.
 * Reports discrepancies and offers auto-fix.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./src/config/database');
const axios = require('axios');

const AUTO_FIX = process.argv.includes('--fix');
const USER = 'ca632c53-8798-46f4-be94-29be0fede7f2';

async function getAlpacaCreds() {
    const r = await query(`SELECT alpaca_key_id, alpaca_secret_key, alpaca_paper FROM users WHERE id=$1`, [USER]);
    const row = r.rows[0];
    return {
        keyId: row.alpaca_key_id,
        secretKey: row.alpaca_secret_key,
        paper: row.alpaca_paper,
        base: row.alpaca_paper ? 'https://paper-api.alpaca.markets' : 'https://api.alpaca.markets',
    };
}

async function fetchAlpacaFills(creds, after) {
    const r = await axios.get(`${creds.base}/v2/account/activities`, {
        headers: {
            'APCA-API-KEY-ID': creds.keyId,
            'APCA-API-SECRET-KEY': creds.secretKey,
        },
        params: { activity_type: 'FILL', after },
        timeout: 10000,
    });
    return r.data || [];
}

async function main() {
    const creds = await getAlpacaCreds();

    // 1. Get all reconciler-recorded SELLs
    const reconSells = await query(`
        SELECT id, symbol, price, quantity, pnl, pnl_percent, trade_date, notes
        FROM trades
        WHERE user_id=$1 AND action='SELL' AND status='CLOSED'
          AND (executed_by='reconciler' OR notes LIKE '%reconciler%')
        ORDER BY trade_date DESC
    `, [USER]);

    console.log(`Found ${reconSells.rows.length} reconciler-recorded SELL(s) to audit.\n`);

    // 2. Fetch all Alpaca FILL activities since Jun 1
    let fills = [];
    try {
        fills = await fetchAlpacaFills(creds, '2026-06-01T00:00:00Z');
        console.log(`Fetched ${fills.length} Alpaca FILL activities since Jun 1.\n`);
    } catch (e) {
        console.error('Failed to fetch Alpaca activities:', e.message);
        process.exit(1);
    }

    // Build lookup: symbol → sorted list of sell fills
    const sellFills = {};
    for (const f of fills) {
        if (f.side === 'sell' || f.side === 'sell_short') {
            if (!sellFills[f.symbol]) sellFills[f.symbol] = [];
            sellFills[f.symbol].push({
                price: parseFloat(f.price),
                qty: parseFloat(f.qty),
                time: f.transaction_time,
                side: f.side,
                orderId: f.order_id,
            });
        }
    }

    const discrepancies = [];
    const clean = [];

    for (const t of reconSells.rows) {
        const recorded = parseFloat(t.price);
        const symFills = sellFills[t.symbol] || [];

        // Find the closest sell fill by date and qty
        const tradeDate = new Date(t.trade_date);
        const nearFills = symFills.filter(f => {
            const fillDate = new Date(f.time);
            const dayDiff = Math.abs((fillDate - tradeDate) / (1000 * 60 * 60 * 24));
            return dayDiff <= 5 && Math.abs(f.qty - parseFloat(t.quantity)) < 0.01;
        });

        // Use the fill with largest price if multiple (likely the stop that fired)
        // For shorts that fired after close, prefer the non-short-sell
        const bestFill = nearFills
            .filter(f => f.side === 'sell')  // prefer regular sells
            .sort((a, b) => b.price - a.price)[0]
            || nearFills.sort((a, b) => b.price - a.price)[0];

        const actualPrice = bestFill?.price;
        const delta = actualPrice != null ? actualPrice - recorded : null;
        const pctDelta = delta != null ? (delta / recorded * 100) : null;

        if (actualPrice != null && Math.abs(delta) > 0.05) {
            // Significant discrepancy
            const correctedPnl = (actualPrice - (parseFloat(t.price) + parseFloat(t.pnl) / parseFloat(t.quantity))) * parseFloat(t.quantity);
            // Actually recompute from entry price
            // entry = price - pnl/qty (for a SELL: pnl = (exit-entry)*qty)
            const entryEst = actualPrice - parseFloat(t.pnl) / parseFloat(t.quantity); // wrong
            // Better: from recorded: entry = recorded_exit - (pnl / qty)
            const entryFromRecorded = recorded - parseFloat(t.pnl || 0) / parseFloat(t.quantity);
            const newPnl = (actualPrice - entryFromRecorded) * parseFloat(t.quantity);
            const newPnlPct = (actualPrice - entryFromRecorded) / entryFromRecorded * 100;

            discrepancies.push({
                id: t.id,
                symbol: t.symbol,
                date: t.trade_date,
                recordedPrice: recorded,
                actualPrice,
                delta: parseFloat(delta.toFixed(2)),
                recordedPnl: parseFloat(t.pnl || 0),
                correctedPnl: parseFloat(newPnl.toFixed(2)),
                correctedPnlPct: parseFloat(newPnlPct.toFixed(2)),
                fillTime: bestFill.time,
                fillSide: bestFill.side,
                orderId: bestFill.orderId,
            });
        } else if (actualPrice != null) {
            clean.push({ symbol: t.symbol, recorded: recorded.toFixed(2), actual: actualPrice.toFixed(2) });
        } else {
            clean.push({ symbol: t.symbol, recorded: recorded.toFixed(2), actual: 'NO ALPACA FILL FOUND (>5d ago or no match)' });
        }
    }

    // ── Report ──────────────────────────────────────────────────────────────────
    console.log('=== DISCREPANCIES ===');
    if (discrepancies.length === 0) {
        console.log('None found — all reconciler exits match Alpaca fills. ✓');
    } else {
        let totalSwing = 0;
        for (const d of discrepancies) {
            const swing = d.correctedPnl - d.recordedPnl;
            totalSwing += swing;
            console.log(
                `  ${d.symbol} (trade id=${d.id}, ${d.date?.toISOString?.()?.slice(0,10) || d.date})`
                + `\n    Recorded: $${d.recordedPrice.toFixed(2)} → P&L $${d.recordedPnl.toFixed(2)}`
                + `\n    Actual:   $${d.actualPrice.toFixed(2)} → P&L $${d.correctedPnl.toFixed(2)} (${d.correctedPnlPct.toFixed(1)}%)`
                + `\n    Swing:    ${swing >= 0 ? '+' : ''}$${swing.toFixed(2)}`
                + `\n    Fill at: ${d.fillTime?.slice(0,16)} (${d.fillSide}), order ${d.orderId}`
            );
        }
        console.log(`\nTotal P&L swing if corrected: ${totalSwing >= 0 ? '+' : ''}$${totalSwing.toFixed(2)}`);

        if (AUTO_FIX) {
            console.log('\n[--fix] Applying corrections...');
            for (const d of discrepancies) {
                const entryFromRecorded = d.recordedPrice - (parseFloat(
                    reconSells.rows.find(t => t.id === d.id)?.pnl || 0
                ) / parseFloat(reconSells.rows.find(t => t.id === d.id)?.quantity || 1));
                const corrNote = ` [CORRECTED: actual Alpaca fill $${d.actualPrice} on ${d.fillTime?.slice(0,10)}]`;
                await query(`
                    UPDATE trades
                    SET price=$1, pnl=$2, pnl_percent=$3,
                        notes=COALESCE(notes,'') || $4
                    WHERE id=$5 AND user_id=$6
                `, [d.actualPrice, d.correctedPnl, d.correctedPnlPct, corrNote, d.id, USER]);
                console.log(`  Fixed ${d.symbol} (id=${d.id}): $${d.recordedPrice} → $${d.actualPrice}`);
            }
            console.log('Done. ✓');
        } else {
            console.log('\nRun with --fix to apply corrections.');
        }
    }

    console.log('\n=== CLEAN (no discrepancy) ===');
    clean.forEach(c => console.log(`  ${c.symbol}: recorded $${c.recorded} | alpaca: ${c.actual}`));

    process.exit(0);
}
main().catch(e => { console.error(e.message, e.stack); process.exit(1); });
