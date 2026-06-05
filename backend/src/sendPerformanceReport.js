/**
 * My Performance Reports
 *
 * sendDailyPerformanceReport  — Mon–Fri 4:15 PM ET (right after market close)
 *   Today's P&L, win/loss count, best/worst trade, running balance,
 *   30-day win rate trend, open positions count.
 *
 * sendWeeklyPerformanceReport — Sunday 9:00 AM EST
 *   Full week recap: P&L, win rate, top symbols, go-live checklist,
 *   comparison to prior week.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');
const { query } = require('./config/database');
const { sendTelegramMessage } = require('./services/telegramService');
const { logger } = require('./utils/logger');

const BASE_URL = 'http://localhost:3001';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loginGetUserId() {
    const res = await axios.post(`${BASE_URL}/api/auth/login`, {
        username: process.env.BOT_USERNAME || 'user',
        password: process.env.BOT_PASSWORD || 'password'
    }, { timeout: 10000 });
    if (!res.data.token) throw new Error('Login failed');
    // Decode userId from JWT payload (base64 middle segment)
    const payload = JSON.parse(Buffer.from(res.data.token.split('.')[1], 'base64').toString());
    return payload.userId || payload.id || payload.sub;
}

function sign(n) {
    const v = parseFloat(n) || 0;
    return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function signUsd(n) {
    const v = parseFloat(n) || 0;
    const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v >= 0 ? '+$' : '-$') + abs;
}

function pct(n) { return (parseFloat(n) || 0).toFixed(1) + '%'; }

function bar(winRate, width = 10) {
    const filled = Math.round((parseFloat(winRate) || 0) / 100 * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function buildCoachingSummary({ winRate30, sharpe30, openPositions, bestWin, worstLoss, totalPnl, totalTrades, wins30, losses30, topTrades }) {
    const notes = [];
    const actions = [];
    const strengths = [];

    const totalPnlValue = parseFloat(totalPnl) || 0;
    const bestWinValue = parseFloat(bestWin) || 0;
    const worstLossValue = parseFloat(worstLoss) || 0;
    const tradeCount = parseInt(totalTrades, 10) || 0;
    const wins = parseInt(wins30, 10) || 0;
    const losses = parseInt(losses30, 10) || 0;

    const topTradePnl = topTrades
        .map(trade => parseFloat(trade.total || 0))
        .filter(value => value > 0)
        .reduce((sum, value) => sum + value, 0);
    const profitConcentration = totalPnlValue > 0 ? topTradePnl / totalPnlValue : 0;

    if (totalPnlValue > 0) {
        strengths.push(`• P&L is positive at ${signUsd(totalPnlValue)}. The system has a base to improve from.`);
    }

    if (tradeCount >= 30) {
        strengths.push(`• Sample size is becoming meaningful at ${tradeCount} trades, but it is still short of the 50–100 trade validation target.`);
    }

    strengths.push('• Tracking win rate and Sharpe is the right discipline. That makes weaknesses visible early.');

    if (wins + losses > 0 && losses > wins) {
        notes.push(`• Win rate is weak at ${pct(winRate30)} (${wins}W / ${losses}L). Too many low-quality setups are making it into execution.`);
        actions.push('• Reduce trade count by 30–50% and only allow the highest-confidence setups through.');
    } else if (winRate30 < 50) {
        notes.push(`• Win rate is still below a safe live threshold at ${pct(winRate30)}.`);
        actions.push('• Be more selective. Fewer trades with better confirmation should replace marginal entries.');
    }

    if (sharpe30 > 0 && sharpe30 < 0.3) {
        notes.push(`• Sharpe is only ${sharpe30.toFixed(2)}. That is the biggest red flag here: results still look close to random rather than repeatable.`);
        actions.push('• Focus on consistency first. Only enter when trend, momentum, and volume all confirm the setup.');
    } else if (sharpe30 > 0 && sharpe30 < 1) {
        notes.push(`• Sharpe is only ${sharpe30.toFixed(2)}. Returns are positive, but not stable enough for live capital.`);
        actions.push('• Reduce trade count by 30–50% and only take high-confidence signals.');
    }

    if (bestWinValue > 0 && worstLossValue < 0 && Math.abs(worstLossValue) > bestWinValue * 2) {
        const imbalance = Math.abs(worstLossValue) / bestWinValue;
        notes.push(`• Risk/reward is upside-down: best win ${signUsd(bestWinValue)} vs worst loss ${signUsd(worstLossValue)}. Losses are ${imbalance.toFixed(1)}x larger than the best win in this sample.`);
        actions.push('• Enforce a hard stop loss and require at least 1.5:1 to 2:1 reward-to-risk before a trade is allowed.');
    }

    if (totalPnlValue > 0 && topTradePnl > totalPnlValue) {
        notes.push(`• Profit is highly concentrated. The top 3 winners produced ${signUsd(topTradePnl)}, which is more than the full 30-day net P&L of ${signUsd(totalPnlValue)}. That means the rest of the trades gave back a large part of the gains.`);
        actions.push('• Raise entry quality and cut weak trades sooner so the month is not carried by a few outsized winners.');
    } else if (profitConcentration >= 0.75) {
        notes.push(`• Profit is concentrated. The top 3 winners contributed ${(profitConcentration * 100).toFixed(0)}% of total 30-day P&L, which means a few trades are carrying the month.`);
        actions.push('• Filter out marginal entries so performance does not depend on 2–3 outsized winners.');
    } else if (profitConcentration >= 0.5) {
        notes.push(`• Profit concentration is elevated. The top 3 winners contributed ${(profitConcentration * 100).toFixed(0)}% of total 30-day P&L.`);
    }

    if (openPositions > 5) {
        notes.push(`• Position count is too high (${openPositions} open positions) for this account size.`);
        actions.push('• Max 3–5 open positions at a time, with equalized 1–2% risk per trade.');
    }

    if (bestWinValue > 0 && worstLossValue < 0 && Math.abs(worstLossValue) > bestWinValue) {
        actions.push('• Cut losses faster. Never let a single loss exceed your average win profile.');
    }

    if (tradeCount < 50) {
        actions.push(`• Stay in paper mode until the sample reaches at least 50 trades, with 100 trades as the safer validation target. Current sample: ${tradeCount}.`);
    }

    if (actions.length === 0) {
        actions.push('• Keep paper trading until win rate, Sharpe, profit consistency, and trade sample size all improve together.');
    }

    const verdict = sharpe30 >= 1 && winRate30 >= 52 && totalPnlValue > 0 && tradeCount >= 50
        ? '🟢 Profitable and consistent enough to start discussing a controlled live rollout.'
        : totalPnlValue > 0
            ? '🔴 Positive P&L, but this still looks like a lucky profitable system rather than a reliable live-trading system.'
            : '🔴 Not live-ready yet. Treat this as paper-validation mode until the edge is clearer.';

    return [
        '🧠 *AI Coach*',
        verdict,
        '✅ *What is working*',
        ...strengths,
        '⚠️ *What needs work*',
        ...(notes.length ? notes : ['• No major statistical warning flags were triggered in this sample.']),
        '🔧 *Next Steps*',
        ...actions,
    ].join('\n');
}

async function sendChunked(chatId, text) {
    const MAX = 4000;
    let remaining = text;
    let chunks = 0;
    while (remaining.length > 0) {
        await sendTelegramMessage(chatId, remaining.slice(0, MAX));
        remaining = remaining.slice(MAX);
        chunks++;
        if (remaining.length > 0) await new Promise(r => setTimeout(r, 800));
    }
    return chunks;
}

// ─── Daily Report ─────────────────────────────────────────────────────────────

async function sendDailyPerformanceReport() {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) throw new Error('TELEGRAM_CHAT_ID not set');

    logger.info('[PerfReport] Building daily performance report...');

    let userId;
    try { userId = await loginGetUserId(); }
    catch (e) { logger.warn('[PerfReport] Login failed, using first active trader', { err: e.message }); }

    // If login fails, look up the same user by username/email (matches BOT_USERNAME creds)
    if (!userId) {
        const botUser = process.env.BOT_USERNAME;
        if (botUser) {
            const r = await query(`
                SELECT id FROM users WHERE username = $1 OR email = $1 LIMIT 1
            `, [botUser]);
            userId = r.rows[0]?.id;
        }
    }
    if (!userId) { logger.warn('[PerfReport] No active user found, skipping'); return; }

    const today = new Date().toISOString().split('T')[0];
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

    // Today's metrics
    const todayMetrics = await query(`
        SELECT
            COALESCE(SUM(total_profit_loss), 0)  AS pnl,
            COALESCE(SUM(total_trades), 0)        AS trades,
            COALESCE(SUM(winning_trades), 0)      AS wins,
            COALESCE(SUM(losing_trades), 0)       AS losses,
            COALESCE(MAX(largest_win), 0)         AS best_win,
            COALESCE(MIN(largest_loss), 0)        AS worst_loss,
            AVG(NULLIF(win_rate, 0))              AS win_rate
        FROM ai_performance_metrics
        WHERE user_id = $1 AND date = $2
    `, [userId, today]);

    // 30-day cumulative
    const rolling = await query(`
        SELECT
            COALESCE(SUM(total_profit_loss), 0)    AS total_pnl,
            COALESCE(SUM(total_trades), 0)          AS total_trades,
            COALESCE(SUM(winning_trades), 0)        AS wins,
            COALESCE(SUM(losing_trades), 0)         AS losses,
            AVG(NULLIF(win_rate, 0))                AS avg_win_rate,
            AVG(NULLIF(sharpe_ratio, 0))            AS avg_sharpe
        FROM ai_performance_metrics
        WHERE user_id = $1
          AND date >= CURRENT_DATE - INTERVAL '30 days'
    `, [userId]);

    // Account balance
    const acct = await query(`
        SELECT balance, initial_balance FROM trading_accounts WHERE user_id = $1
    `, [userId]);

    // Open positions count
    const positions = await query(`
        SELECT COUNT(*) AS open FROM holdings WHERE user_id = $1 AND quantity > 0
    `, [userId]);

    // Best & worst trade this month
    const topTrades = await query(`
        SELECT symbol, total, action, trade_date
        FROM trades
        WHERE user_id = $1
          AND action = 'SELL'
          AND trade_date >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY total DESC
        LIMIT 3
    `, [userId]);

    // Last 7 daily P&L for mini trend
    const trend = await query(`
        SELECT date, SUM(total_profit_loss) AS pnl
        FROM ai_performance_metrics
        WHERE user_id = $1
          AND date >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY date
        ORDER BY date ASC
    `, [userId]);

    const t = todayMetrics.rows[0];
    const r = rolling.rows[0];
    const balance = parseFloat(acct.rows[0]?.balance || 10000);
    const initial = parseFloat(acct.rows[0]?.initial_balance || 10000);
    const totalReturn = initial > 0 ? ((balance - initial) / initial * 100).toFixed(2) : '0.00';
    const openPos = parseInt(positions.rows[0]?.open || 0);
    const winRate30 = parseFloat(r.avg_win_rate || 0);
    const sharpe30 = parseFloat(r.avg_sharpe || 0);

    const todayDate = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    // 7-day P&L spark
    const sparkDays = trend.rows.map(d => {
        const v = parseFloat(d.pnl);
        return v > 0 ? '🟢' : v < 0 ? '🔴' : '⚪';
    }).join('');

    // Top symbols this month
    const topSymStr = topTrades.rows.map((t, i) =>
        `  ${['🥇','🥈','🥉'][i] || '  '} ${t.symbol}: ${signUsd(t.total)}`
    ).join('\n') || '  No closed trades yet';

    const coachingSummary = buildCoachingSummary({
        winRate30,
        sharpe30,
        openPositions: openPos,
        bestWin: t.best_win,
        worstLoss: t.worst_loss,
        totalPnl: r.total_pnl,
        totalTrades: r.total_trades,
        wins30: r.wins,
        losses30: r.losses,
        topTrades: topTrades.rows,
    });

    const msg =
`🤖 *AI BOT DAILY SUMMARY — ${todayDate}*
━━━━━━━━━━━━━━━━━━━━

💰 *Today's Results*
AI Bot P&L: *${signUsd(t.pnl)}*
Trades:    ${t.trades} total  (${t.wins}W / ${t.losses}L)
Win Rate:  ${t.wins > 0 || t.losses > 0 ? pct(parseFloat(t.wins) / (parseFloat(t.wins) + parseFloat(t.losses)) * 100) : '—'}
Best win:  ${parseFloat(t.best_win) > 0 ? signUsd(t.best_win) : '—'}
Worst:     ${parseFloat(t.worst_loss) < 0 ? signUsd(t.worst_loss) : '—'}

📈 *30-Day Rolling Summary*
Cumulative P&L:  *${signUsd(r.total_pnl)}*
Win Rate:        *${pct(winRate30)}* ${bar(winRate30, 10)} ${winRate30 >= 52 ? '✅' : '❌ (need 52%)'}
Sharpe Ratio:    *${sharpe30 > 0 ? sharpe30.toFixed(2) : '—'}*  ${sharpe30 >= 1 ? '✅' : sharpe30 > 0 ? '🔶 (need >1.0)' : '—'}
Total Trades:    ${r.total_trades}  (${r.wins}W / ${r.losses}L)

💼 *Account*
Balance:       *$${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}*
Total Return:  *${sign(totalReturn)}%*
Open Positions: ${openPos}

🏆 *Top Closes This Month*
${topSymStr}

📅 *Last 7 Days*  ${sparkDays || '—'}

🚦 *Go-Live Status*
${winRate30 >= 52 ? '✅' : '❌'} Win rate ≥ 52%  →  ${pct(winRate30)}
${sharpe30 >= 1   ? '✅' : '❌'} Sharpe > 1.0   →  ${sharpe30 > 0 ? sharpe30.toFixed(2) : '0.00'}
${parseFloat(r.total_pnl) > 0 ? '✅' : '❌'} Positive P&L   →  ${signUsd(r.total_pnl)}
${parseInt(r.total_trades, 10) >= 50 ? '✅' : '❌'} ≥ 50 trades    →  ${r.total_trades} trades

${coachingSummary}
━━━━━━━━━━━━━━━━━━━━
🤖 _KiranRock AI Bot · Paper Trading_`;

    await sendChunked(chatId, msg);
    logger.info('[PerfReport] ✓ Daily performance report sent', { userId, pnl: t.pnl });
    console.log(`[PerfReport] ✓ Daily report sent — Today: ${signUsd(t.pnl)} | 30d: ${signUsd(r.total_pnl)}`);
}

// ─── Weekly Report ────────────────────────────────────────────────────────────

async function sendWeeklyPerformanceReport() {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) throw new Error('TELEGRAM_CHAT_ID not set');

    logger.info('[PerfReport] Building weekly performance report...');

    let userId;
    try { userId = await loginGetUserId(); }
    catch (e) { logger.warn('[PerfReport] Login failed, fallback', { err: e.message }); }

    if (!userId) {
        const botUser = process.env.BOT_USERNAME;
        if (botUser) {
            const r = await query(`
                SELECT id FROM users WHERE username = $1 OR email = $1 LIMIT 1
            `, [botUser]);
            userId = r.rows[0]?.id;
        }
    }
    if (!userId) { logger.warn('[PerfReport] No active user, skipping weekly'); return; }

    // This week (Mon–Fri)
    const thisWeek = await query(`
        SELECT
            COALESCE(SUM(total_profit_loss), 0)   AS pnl,
            COALESCE(SUM(total_trades), 0)         AS trades,
            COALESCE(SUM(winning_trades), 0)       AS wins,
            COALESCE(SUM(losing_trades), 0)        AS losses,
            AVG(NULLIF(win_rate, 0))               AS avg_win_rate,
            COALESCE(MAX(largest_win), 0)          AS best_win,
            COALESCE(MIN(largest_loss), 0)         AS worst_loss,
            AVG(NULLIF(sharpe_ratio, 0))           AS sharpe
        FROM ai_performance_metrics
        WHERE user_id = $1
          AND date >= date_trunc('week', CURRENT_DATE)
    `, [userId]);

    // Prior week
    const priorWeek = await query(`
        SELECT
            COALESCE(SUM(total_profit_loss), 0)   AS pnl,
            COALESCE(SUM(total_trades), 0)         AS trades,
            AVG(NULLIF(win_rate, 0))               AS avg_win_rate
        FROM ai_performance_metrics
        WHERE user_id = $1
          AND date >= date_trunc('week', CURRENT_DATE) - INTERVAL '7 days'
          AND date <  date_trunc('week', CURRENT_DATE)
    `, [userId]);

    // 30-day rolling
    const rolling = await query(`
        SELECT
            COALESCE(SUM(total_profit_loss), 0)    AS total_pnl,
            COALESCE(SUM(total_trades), 0)          AS total_trades,
            COALESCE(SUM(winning_trades), 0)        AS wins,
            COALESCE(SUM(losing_trades), 0)         AS losses,
            AVG(NULLIF(win_rate, 0))                AS avg_win_rate,
            AVG(NULLIF(sharpe_ratio, 0))            AS avg_sharpe
        FROM ai_performance_metrics
        WHERE user_id = $1
          AND date >= CURRENT_DATE - INTERVAL '30 days'
    `, [userId]);

    // Account
    const acct = await query(`SELECT balance, initial_balance FROM trading_accounts WHERE user_id = $1`, [userId]);

    const positions = await query(`
        SELECT COUNT(*) AS open FROM holdings WHERE user_id = $1 AND quantity > 0
    `, [userId]);

    const topTrades = await query(`
        SELECT symbol, total, action, trade_date
        FROM trades
        WHERE user_id = $1
          AND action = 'SELL'
          AND trade_date >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY total DESC
        LIMIT 3
    `, [userId]);

    // Daily P&L this week
    const dailyThisWeek = await query(`
        SELECT date, SUM(total_profit_loss) AS pnl, SUM(total_trades) AS trades
        FROM ai_performance_metrics
        WHERE user_id = $1
          AND date >= date_trunc('week', CURRENT_DATE)
        GROUP BY date ORDER BY date ASC
    `, [userId]);

    // Top winning symbols this month
    const topSymbols = await query(`
        SELECT symbol,
            COUNT(*) FILTER (WHERE action = 'SELL') AS sells,
            SUM(CASE WHEN action = 'SELL' THEN total ELSE -total END) AS net
        FROM trades
        WHERE user_id = $1
          AND trade_date >= CURRENT_DATE - INTERVAL '30 days'
          AND action IN ('BUY','SELL')
        GROUP BY symbol
        ORDER BY net DESC
        LIMIT 5
    `, [userId]);

    const tw = thisWeek.rows[0];
    const pw = priorWeek.rows[0];
    const rw = rolling.rows[0];
    const balance = parseFloat(acct.rows[0]?.balance || 10000);
    const initial = parseFloat(acct.rows[0]?.initial_balance || 10000);
    const totalReturn = initial > 0 ? ((balance - initial) / initial * 100).toFixed(2) : '0.00';
    const openPos = parseInt(positions.rows[0]?.open || 0, 10);

    const winRate30 = parseFloat(rw.avg_win_rate || 0);
    const sharpe30  = parseFloat(rw.avg_sharpe   || 0);

    // Week-over-week change
    const weekPnlDiff = parseFloat(tw.pnl) - parseFloat(pw.pnl);
    const weekWrDiff  = (parseFloat(tw.avg_win_rate || 0) - parseFloat(pw.avg_win_rate || 0)).toFixed(1);

    // Daily breakdown for this week
    const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const weekDayLines = dailyThisWeek.rows.map(d => {
        const dt   = new Date(d.date);
        const name = dayNames[dt.getUTCDay()];
        const v    = parseFloat(d.pnl);
        const icon = v > 0 ? '🟢' : v < 0 ? '🔴' : '⚪';
        return `  ${icon} ${name}: ${signUsd(v)}  (${d.trades} trades)`;
    }).join('\n') || '  No data yet for this week';

    // Top symbols
    const symbolLines = topSymbols.rows.map((s, i) =>
        `  ${['🥇','🥈','🥉','4️⃣','5️⃣'][i]} ${s.symbol}: ${signUsd(s.net)}`
    ).join('\n') || '  No closed trades this month';

    const weekRange = (() => {
        const now = new Date();
        const dow = now.getDay();
        const mon = new Date(now.getTime() - ((dow === 0 ? 6 : dow - 1) * 86400000));
        const fri = new Date(mon.getTime() + 4 * 86400000);
        const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        return `${fmt(mon)} – ${fmt(fri)}, ${now.getFullYear()}`;
    })();

    const coachingSummary = buildCoachingSummary({
        winRate30,
        sharpe30,
        openPositions: openPos,
        bestWin: tw.best_win,
        worstLoss: tw.worst_loss,
        totalPnl: rw.total_pnl,
        totalTrades: rw.total_trades,
        wins30: rw.wins,
        losses30: rw.losses,
        topTrades: topTrades.rows,
    });

    const msg =
`📊 *MY WEEKLY PERFORMANCE*
_${weekRange}_
━━━━━━━━━━━━━━━━━━━━

📅 *This Week's Results*
P&L:        *${signUsd(tw.pnl)}*  (${weekPnlDiff >= 0 ? '▲' : '▼'} ${signUsd(weekPnlDiff)} vs last week)
Trades:     ${tw.trades}  (${tw.wins}W / ${tw.losses}L)
Win Rate:   *${pct(tw.avg_win_rate)}*  (${parseFloat(weekWrDiff) >= 0 ? '▲' : '▼'}${Math.abs(parseFloat(weekWrDiff)).toFixed(1)}pp vs last week)
Best day:   ${signUsd(tw.best_win)}
Worst day:  ${signUsd(tw.worst_loss)}

📅 *Daily Breakdown*
${weekDayLines}

📈 *30-Day Rolling*
Cumulative P&L:  *${signUsd(rw.total_pnl)}*
Win Rate:        *${pct(winRate30)}* ${bar(winRate30, 10)} ${winRate30 >= 52 ? '✅' : '❌'}
Sharpe Ratio:    *${sharpe30 > 0 ? sharpe30.toFixed(2) : '0.00'}* ${sharpe30 >= 1 ? '✅' : sharpe30 > 0 ? '🔶' : '—'}
Total Trades:    ${rw.total_trades}  (${rw.wins}W / ${rw.losses}L)

💼 *Account Summary*
Balance:       *$${balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}*
Started with:  $${initial.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
Total Return:  *${sign(totalReturn)}%*

🏆 *Top Symbols (30 days)*
${symbolLines}

🚦 *Go-Live Readiness*
${winRate30 >= 52 ? '✅' : '❌'} Win rate ≥ 52%     →  ${pct(winRate30)}
${sharpe30 >= 1   ? '✅' : '❌'} Sharpe > 1.0      →  ${sharpe30 > 0 ? sharpe30.toFixed(2) : '0.00'}
${parseFloat(rw.total_pnl) > 0 ? '✅' : '❌'} Positive 30d P&L  →  ${signUsd(rw.total_pnl)}
${parseInt(rw.total_trades, 10) >= 50 ? '✅' : '❌'} ≥ 50 trades      →  ${rw.total_trades} trades

${coachingSummary}

${winRate30 >= 52 && sharpe30 >= 1 && parseFloat(rw.total_pnl) > 0 && parseInt(rw.total_trades, 10) >= 50
    ? '🟢 *READY TO CONSIDER LIVE TRADING* — All criteria met!'
    : '🔴 *Not ready for live money yet.* Keep paper trading.'}
━━━━━━━━━━━━━━━━━━━━
🤖 _KiranRock AI Bot · Weekly Wrap-Up_`;

    await sendChunked(chatId, msg);
    logger.info('[PerfReport] ✓ Weekly performance report sent', { userId });
    console.log(`[PerfReport] ✓ Weekly report sent — Week: ${signUsd(tw.pnl)} | 30d: ${signUsd(rw.total_pnl)}`);
}

// ─── Admin: All-Users 30-Day Report ──────────────────────────────────────────

async function sendAdminMonthlyReport() {
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!chatId) throw new Error('TELEGRAM_CHAT_ID not set');

    logger.info('[AdminReport] Building all-users 30-day trading report...');

    // P&L is calculated by pairing SELL total minus the nearest prior BUY total for the same symbol/user.
    // Since the trades table has no profit_loss column, we use a CTE to estimate:
    //   SELL.total - BUY.total  per matched pair (FIFO approximation via AVG buy cost).

    // 1. Platform-wide aggregate stats — P&L estimated as SELL total - matched BUY cost
    const platformStats = await query(`
        WITH sell_trades AS (
            SELECT s.id, s.user_id, s.symbol, s.quantity, s.total AS sell_total, s.trade_date,
                   COALESCE((
                       SELECT AVG(b.price)
                       FROM trades b
                       WHERE b.user_id = s.user_id AND b.symbol = s.symbol
                         AND b.action = 'BUY' AND b.trade_date <= s.trade_date
                   ), s.price) AS avg_buy_price
            FROM trades s
            WHERE s.action = 'SELL'
              AND s.trade_date >= CURRENT_DATE - INTERVAL '30 days'
        ),
        pnl_trades AS (
            SELECT *, (sell_total - avg_buy_price * quantity) AS pnl
            FROM sell_trades
        )
        SELECT
            (SELECT COUNT(DISTINCT user_id) FROM trades
              WHERE trade_date >= CURRENT_DATE - INTERVAL '30 days') AS total_users,
            (SELECT COUNT(*) FROM trades
              WHERE trade_date >= CURRENT_DATE - INTERVAL '30 days') AS total_trades,
            COUNT(*) FILTER (WHERE pnl > 0)          AS winning_trades,
            COUNT(*) FILTER (WHERE pnl < 0)          AS losing_trades,
            (SELECT COUNT(*) FROM trades WHERE action='BUY'
              AND trade_date >= CURRENT_DATE - INTERVAL '30 days') AS buy_orders,
            COUNT(*)                                  AS sell_orders,
            COALESCE(SUM(pnl), 0)                    AS total_pnl,
            COALESCE(MAX(pnl), 0)                    AS best_trade_pnl,
            COALESCE(MIN(pnl), 0)                    AS worst_trade_pnl,
            COALESCE(AVG(pnl), 0)                    AS avg_trade_pnl
        FROM pnl_trades
    `);

    // 2. Per-user breakdown
    const perUser = await query(`
        WITH sell_trades AS (
            SELECT s.user_id, s.symbol, s.quantity, s.total AS sell_total, s.trade_date,
                   COALESCE((
                       SELECT AVG(b.price) FROM trades b
                       WHERE b.user_id = s.user_id AND b.symbol = s.symbol
                         AND b.action = 'BUY' AND b.trade_date <= s.trade_date
                   ), s.price) AS avg_buy_price
            FROM trades s
            WHERE s.action = 'SELL'
              AND s.trade_date >= CURRENT_DATE - INTERVAL '30 days'
        ),
        pnl_trades AS (
            SELECT *, (sell_total - avg_buy_price * quantity) AS pnl FROM sell_trades
        )
        SELECT
            u.username,
            COUNT(p.pnl)                                                      AS total_sells,
            COUNT(*) FILTER (WHERE p.pnl > 0)                                AS wins,
            COUNT(*) FILTER (WHERE p.pnl < 0)                                AS losses,
            COALESCE(SUM(p.pnl), 0)                                          AS net_pnl,
            COALESCE(MAX(p.pnl) FILTER (WHERE p.pnl > 0), 0)                AS best_win,
            COALESCE(MIN(p.pnl) FILTER (WHERE p.pnl < 0), 0)                AS worst_loss,
            COALESCE(ta.balance, 0)                                           AS current_balance
        FROM users u
        LEFT JOIN pnl_trades p ON p.user_id = u.id
        LEFT JOIN trading_accounts ta ON ta.user_id = u.id
        GROUP BY u.username, ta.balance
        ORDER BY net_pnl DESC
    `);

    // 3. Top winning trades across all users
    const topWins = await query(`
        SELECT u.username, s.symbol,
               (s.total - COALESCE((
                   SELECT AVG(b.price) FROM trades b
                   WHERE b.user_id = s.user_id AND b.symbol = s.symbol
                     AND b.action = 'BUY' AND b.trade_date <= s.trade_date
               ), s.price) * s.quantity) AS pnl,
               s.trade_date::date AS date
        FROM trades s
        JOIN users u ON u.id = s.user_id
        WHERE s.action = 'SELL'
          AND s.trade_date >= CURRENT_DATE - INTERVAL '30 days'
          AND (s.total - COALESCE((
                   SELECT AVG(b.price) FROM trades b
                   WHERE b.user_id = s.user_id AND b.symbol = s.symbol
                     AND b.action = 'BUY' AND b.trade_date <= s.trade_date
               ), s.price) * s.quantity) > 0
        ORDER BY pnl DESC
        LIMIT 5
    `);

    // 4. Top losing trades across all users
    const topLosses = await query(`
        SELECT u.username, s.symbol,
               (s.total - COALESCE((
                   SELECT AVG(b.price) FROM trades b
                   WHERE b.user_id = s.user_id AND b.symbol = s.symbol
                     AND b.action = 'BUY' AND b.trade_date <= s.trade_date
               ), s.price) * s.quantity) AS pnl,
               s.trade_date::date AS date
        FROM trades s
        JOIN users u ON u.id = s.user_id
        WHERE s.action = 'SELL'
          AND s.trade_date >= CURRENT_DATE - INTERVAL '30 days'
          AND (s.total - COALESCE((
                   SELECT AVG(b.price) FROM trades b
                   WHERE b.user_id = s.user_id AND b.symbol = s.symbol
                     AND b.action = 'BUY' AND b.trade_date <= s.trade_date
               ), s.price) * s.quantity) < 0
        ORDER BY pnl ASC
        LIMIT 5
    `);

    // 5. Most traded symbols
    const topSymbols = await query(`
        SELECT symbol, COUNT(*) AS trade_count,
               COALESCE(SUM(CASE WHEN action = 'SELL' THEN total ELSE -total END), 0) AS net_flow
        FROM trades
        WHERE trade_date >= CURRENT_DATE - INTERVAL '30 days'
          AND action IN ('BUY', 'SELL')
        GROUP BY symbol
        ORDER BY trade_count DESC
        LIMIT 5
    `);

    const p   = platformStats.rows[0];
    const now = new Date();
    const dateRange = `${new Date(now - 30 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const totalTrades  = parseInt(p.total_trades, 10);
    const winningCount = parseInt(p.winning_trades, 10);
    const losingCount  = parseInt(p.losing_trades, 10);
    const sellCount    = parseInt(p.sell_orders, 10);
    const winRate      = sellCount > 0 ? (winningCount / sellCount * 100).toFixed(1) : '0.0';

    const userLines = perUser.rows.map((u, i) => {
        const sells  = parseInt(u.total_sells, 10);
        const wins   = parseInt(u.wins, 10);
        const wr     = sells > 0 ? (wins / sells * 100).toFixed(0) : '0';
        const icon   = parseFloat(u.net_pnl) >= 0 ? '🟢' : '🔴';
        return `  ${icon} ${u.username.padEnd(14)} P&L: ${signUsd(u.net_pnl).padEnd(12)} WR: ${wr}%  (${u.wins}W/${u.losses}L)  Bal: $${parseFloat(u.current_balance).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
    }).join('\n') || '  No users found';

    const winLines = topWins.rows.map((t, i) =>
        `  ${['🥇','🥈','🥉','4️⃣','5️⃣'][i]} ${t.username} — ${t.symbol}: ${signUsd(t.pnl)}  (${t.date})`
    ).join('\n') || '  No winning trades found';

    const lossLines = topLosses.rows.map((t, i) =>
        `  ${i + 1}. ${t.username} — ${t.symbol}: ${signUsd(t.pnl)}  (${t.date})`
    ).join('\n') || '  No losing trades found';

    const symbolLines = topSymbols.rows.map(s =>
        `  ${s.symbol.padEnd(8)} ${s.trade_count} trades  Flow: ${signUsd(s.net_flow)}`
    ).join('\n') || '  No data';

    const overallIcon = parseFloat(p.total_pnl) >= 0 ? '🟢' : '🔴';

    const msg =
`👑 *KIRANROCK ADMIN — ALL USERS TRADING REPORT*
_${dateRange} (Last 30 Days)_
━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 *Platform Overview*
Total Users:       ${p.total_users}
Total Trades:      ${totalTrades}  (${p.buy_orders} buys / ${p.sell_orders} sells)
Winning Trades:    ${winningCount}  🟢
Losing Trades:     ${losingCount}  🔴
Win Rate:          *${winRate}%*  ${parseFloat(winRate) >= 52 ? '✅' : '❌'}

${overallIcon} *Platform Net P&L:  ${signUsd(p.total_pnl)}*
Best Single Trade: ${signUsd(p.best_trade_pnl)}
Worst Single Trade: ${signUsd(p.worst_trade_pnl)}
Avg Trade P&L:     ${signUsd(p.avg_trade_pnl)}

━━━━━━━━━━━━━━━━━━━━━━━━━━
👤 *User Performance Breakdown*

${userLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━
🏆 *Top 5 Winning Trades*
${winLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━
📉 *Top 5 Losing Trades*
${lossLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━
🔥 *Most Traded Symbols*
${symbolLines}

━━━━━━━━━━━━━━━━━━━━━━━━━━
🤖 _KiranRock AI Bot · Admin Report · ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET_`;

    await sendChunked(chatId, msg);
    logger.info('[AdminReport] ✓ All-users 30-day report sent to admin Telegram.');
    console.log('[AdminReport] ✓ All-users 30-day report sent.');
}

module.exports = { sendDailyPerformanceReport, sendWeeklyPerformanceReport, sendAdminMonthlyReport };

// CLI: node src/sendPerformanceReport.js daily|weekly
if (require.main === module) {
    const mode = process.argv[2] || 'daily';
    const fn = mode === 'weekly' ? sendWeeklyPerformanceReport : sendDailyPerformanceReport;
    fn()
        .then(() => process.exit(0))
        .catch(e => { console.error('[PerfReport] Failed:', e.message); process.exit(1); });
}
