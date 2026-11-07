/**
 * Research lab CLI (2026-11-07).
 *   node scripts/researchLab.js seed   — add the starter ideas (skips names already logged)
 *   node scripts/researchLab.js run    — test every queued idea
 *   node scripts/researchLab.js list   — show every idea and its result
 */
const lab = require('../src/services/researchLabService');
const { query } = require('../src/config/database');

const STARTER = [
    { name: 'burst4_5d', family: 'momentum', idea: 'Sanity check: +4% day on above-average volume (rejected 2026-11-07 by the stand-alone replay)',
      spec: { when: [['ret1', '>=', 4], ['volRatio', '>=', 1]], hold: 5 } },
    { name: 'high52_breakout_vol_10d', family: 'momentum', idea: 'Within 1% of the 52-week high on 1.5x volume, above the 200-day',
      spec: { when: [['high52Dist', '>=', -1], ['volRatio', '>=', 1.5], ['sma200Dist', '>', 0]], hold: 10 } },
    { name: 'uptrend_pullback_rsi40_5d', family: 'mean_reversion', idea: 'Uptrend (5%+ above 200-day) pulls back: RSI < 40 after a 3%+ week drop',
      spec: { when: [['sma200Dist', '>', 5], ['rsi14', '<', 40], ['ret5', '<', -3]], hold: 5 } },
    { name: 'uptrend_selloff8_5d', family: 'mean_reversion', idea: 'Above the 200-day but down 8%+ in a week',
      spec: { when: [['sma200Dist', '>', 0], ['ret5', '<=', -8]], hold: 5 } },
    { name: 'gapdown_reversal_5d', family: 'mean_reversion', idea: 'Gaps down 3%+ but closes in the top 30% of the day, above the 200-day',
      spec: { when: [['gap', '<=', -3], ['rangePos', '>=', 0.7], ['sma200Dist', '>', 0]], hold: 5 } },
    { name: 'quiet_near_high_10d', family: 'trend', idea: 'Volatility contraction near highs: within 5% of the 52-week high, ATR ≤ 2%, just above the 50-day',
      spec: { when: [['high52Dist', '>=', -5], ['atrPct', '<=', 2], ['sma50Dist', 'between', [0, 5]]], hold: 10 } },
    { name: 'momentum60_30_10d', family: 'momentum', idea: 'Up 30%+ in 60 days, above the 50-day, RSI 50-75 (not overheated)',
      spec: { when: [['ret60', '>=', 30], ['sma50Dist', '>', 0], ['rsi14', 'between', [50, 75]]], hold: 10 } },
    { name: 'market_dip_uptrend_5d', family: 'market', idea: 'SPY down 3%+ in 5 days; buy stocks still above their 200-day',
      spec: { when: [['spyRet5', '<=', -3], ['sma200Dist', '>', 0]], hold: 5 } },
    { name: 'spy_below200_uptrend_5d', family: 'market', idea: 'Stocks above their 200-day while SPY is below its own (relative strength in a weak market)',
      spec: { when: [['spyAbove200', '<', 0.5], ['sma200Dist', '>', 0]], hold: 5 } },
    { name: 'lowprice_volspike_3d', family: 'momentum', idea: '$3-10 stock, 3x volume, up 5%+',
      spec: { when: [['price', 'between', [3, 10]], ['volRatio', '>=', 3], ['ret1', '>=', 5]], hold: 3 } },
];

(async () => {
    const cmd = process.argv[2] || 'list';
    if (cmd === 'seed') {
        for (const h of STARTER) {
            const { created } = await lab.addHypothesis({ ...h, source: 'starter' });
            console.log(`${created ? 'added  ' : 'exists '} ${h.name}`);
        }
    } else if (cmd === 'run') {
        const rows = await lab.runQueued();
        rows.forEach(r => console.log(lab.formatResult(r)));
        if (!rows.length) console.log('Nothing queued.');
    } else {
        await lab.ensureTable();
        const rows = (await query(`SELECT * FROM research_hypotheses ORDER BY id`)).rows;
        rows.forEach(r => console.log(r.status === 'queued' ? `⏳ ${r.name} (queued)` : lab.formatResult(r)));
    }
    process.exit(0);
})().catch(err => { console.error(err.message); process.exit(1); });
