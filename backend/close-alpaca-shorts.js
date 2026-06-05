/**
 * Close all negative (short) positions in the Alpaca paper account.
 * These were created when the bot tried to sell stocks it didn't hold in Alpaca.
 */
require('dotenv').config();

(async () => {
    const brokerService = require('./src/services/brokerService');

    console.log('Fetching Alpaca positions...');
    const positions = await brokerService.getPositions();

    const shorts = positions.filter(p => p.qty < 0);
    const longs  = positions.filter(p => p.qty > 0);

    console.log(`Total positions: ${positions.length} | Longs: ${longs.length} | Shorts (to close): ${shorts.length}`);
    longs.forEach(p  => console.log(`  LONG:  ${p.symbol.padEnd(6)} qty: ${p.qty}  value: $${p.marketValue?.toFixed(2)}`));
    shorts.forEach(p => console.log(`  SHORT: ${p.symbol.padEnd(6)} qty: ${p.qty}  value: $${p.marketValue?.toFixed(2)}`));

    if (shorts.length === 0) {
        console.log('\nNo short positions to close.');
        process.exit(0);
    }

    // Get the Alpaca client directly to close positions
    const Alpaca = require('@alpacahq/alpaca-trade-api');
    const client = new Alpaca({
        keyId:     process.env.ALPACA_KEY_ID,
        secretKey: process.env.ALPACA_SECRET_KEY,
        paper:     process.env.ALPACA_PAPER !== 'false'
    });

    console.log(`\nClosing ${shorts.length} short positions (buying to cover)...`);
    let closed = 0, failed = 0;

    for (const pos of shorts) {
        const buyQty = Math.abs(pos.qty); // buy back the short
        try {
            const order = await client.createOrder({
                symbol:        pos.symbol,
                qty:           buyQty,
                side:          'buy',
                type:          'market',
                time_in_force: 'day'
            });
            console.log(`  ✅ CLOSED SHORT ${pos.symbol}: bought ${buyQty} shares (order: ${order.id})`);
            closed++;
        } catch (err) {
            console.log(`  ❌ FAILED ${pos.symbol}: ${err.message}`);
            failed++;
        }
        // Small delay between orders
        await new Promise(r => setTimeout(r, 300));
    }

    console.log(`\nDone. Closed: ${closed} | Failed: ${failed}`);
    process.exit(0);
})().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
