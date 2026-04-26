const { sendTelegramMessage } = require('./services/telegramService');
const users = require('../users.json');
const axios = require('axios');

/**
 * Calculate stop loss percentage based on volatility
 */
function calculateStopLoss(volatility, confidence) {
  // Higher volatility = wider stop loss
  // Lower confidence = wider stop loss
  const baseStop = 3.0; // Base 3% stop loss
  const volatilityFactor = Math.min(volatility / 2, 3); // Cap at 3%
  const confidenceFactor = (100 - confidence) / 50; // Lower confidence = higher factor
  return Math.min(baseStop + volatilityFactor + confidenceFactor, 8); // Max 8% stop
}

/**
 * Calculate risk/reward ratio
 */
function calculateRiskReward(expectedMove, stopLoss) {
  const reward = Math.abs(parseFloat(expectedMove));
  const risk = stopLoss;
  return (reward / risk).toFixed(1);
}

/**
 * Get position size recommendation
 */
function getPositionSize(tier, confidence, volatility) {
  if (tier === 'A' && confidence > 85) return '8-10%';
  if (tier === 'A' || (tier === 'B' && confidence > 80)) return '5-8%';
  if (tier === 'B') return '3-5%';
  if (tier === 'C' && volatility < 2) return '2-4%';
  return '1-3%';
}

/**
 * Get market regime indicator
 */
function getMarketRegime(marketContext) {
  if (!marketContext) return '🟡 Neutral';
  const avgScore = marketContext.averageScore || 60;
  if (avgScore > 70) return '🟢 Bullish';
  if (avgScore < 50) return '🔴 Bearish';
  return '🟡 Sideways';
}

/**
 * Get signal emoji
 */
function getSignalEmoji(signal) {
  switch (signal) {
    case 'Strong Buy': return '🚀';
    case 'Buy': return '📈';
    case 'Hold': return '⏸️';
    case 'Avoid': return '⛔';
    default: return '➡️';
  }
}

/**
 * Get risk level emoji
 */
function getRiskEmoji(riskScore) {
  if (riskScore < 40) return '🟢';
  if (riskScore < 60) return '🟡';
  return '🔴';
}

/**
 * Format enhanced weekly report with comprehensive analysis
 */
async function getWeeklyReport() {
  try {
    // Step 1: Login to get JWT token
    const loginRes = await axios.post('http://localhost:3001/api/auth/login', {
      username: 'user',
      password: 'password'
    });
    const token = loginRes.data.token;
    if (!token) throw new Error('No token received from login');

    // Step 2: Fetch backend API with enhanced data
    // Using MEGA_CAP (50 mega-cap stocks) for SPEED - generates in ~20 seconds
    // Falls back to cached TOP_200 if needed
    let res = null;
    
    try {
      console.log('[Report] Fetching MEGA_CAP predictions (~15-20 seconds)...');
      res = await axios.get('http://localhost:3001/api/weekly/predictions?limit=10&universe=MEGA_CAP', {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 120000 // 2 minute timeout for MEGA_CAP (should complete in <30 sec)
      });
    } catch (megaCapError) {
      console.log('[Report] MEGA_CAP timed out, trying TOP_200...');
      try {
        res = await axios.get('http://localhost:3001/api/weekly/predictions?limit=10&universe=TOP_200', {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 300000 // 5 minute timeout for TOP_200
        });
      } catch (top200Error) {
        throw new Error('All prediction universes failed: ' + top200Error.message);
      }
    }
    
    if (res.data && res.data.topPicks && res.data.topPicks.length > 0) {
      const picks = res.data.topPicks.slice(0, 10);
      const marketContext = res.data.marketContext;
      const performance = res.data.performance;
      const now = new Date();
      const dateStr = now.toLocaleDateString('en-US', { 
        weekday: 'long', 
        year: 'numeric', 
        month: 'long', 
        day: 'numeric' 
      });
      const timeStr = now.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      
      // Build comprehensive enhanced report
      let report = `📊 *WEEKLY STOCK PREDICTIONS*\n`;
      report += `━━━━━━━━━━━━━━━━━━━━\n`;
      report += `🕒 ${dateStr} at ${timeStr}\n\n`;
      
      // Market Context - NEW ENHANCED SECTION
      if (marketContext) {
        report += `🌍 *MARKET OVERVIEW*\n`;
        report += `━━━━━━━━━━━━━━━━━━━━\n`;
        
        // Market Regime
        if (marketContext.marketRegime) {
          const regime = marketContext.marketRegime;
          let regimeEmoji = '📊';
          if (regime === 'Trending') regimeEmoji = '📈';
          else if (regime === 'Range-Bound') regimeEmoji = '↔️';
          else if (regime === 'Volatile') regimeEmoji = '⚡';
          else if (regime === 'Rotation') regimeEmoji = '🔄';
          
          report += `${regimeEmoji} *Market Regime*: ${regime}\n`;
        }
        
        // Macro Trends
        if (marketContext.macroTrends) {
          const trends = marketContext.macroTrends;
          report += `\n📈 *Macro Trends*:\n`;
          if (trends.growthVsValue) {
            report += `   • Style: ${trends.growthVsValue > 55 ? 'Growth Leading' : trends.growthVsValue < 45 ? 'Value Leading' : 'Balanced'}\n`;
          }
          if (trends.riskAppetite) {
            report += `   • Risk Appetite: ${trends.riskAppetite > 60 ? 'High' : trends.riskAppetite < 40 ? 'Low' : 'Moderate'}\n`;
          }
          if (trends.volatilityRegime) {
            report += `   • Volatility: ${trends.volatilityRegime}\n`;
          }
        }
        
        // Sector Rotation - NEW
        if (marketContext.sectorRotation) {
          report += `\n🔄 *Sector Rotation*:\n`;
          if (marketContext.sectorRotation.rotatingIn && marketContext.sectorRotation.rotatingIn.length > 0) {
            report += `   📈 Hot: ${marketContext.sectorRotation.rotatingIn.join(', ')}\n`;
          }
          if (marketContext.sectorRotation.rotatingOut && marketContext.sectorRotation.rotatingOut.length > 0) {
            report += `   📉 Cold: ${marketContext.sectorRotation.rotatingOut.join(', ')}\n`;
          }
        }
        
        report += `\n`;
      }
      
      // Performance Tracking - NEW SECTION
      if (performance && performance.totalPredictions > 0) {
        report += `📊 *PAST PERFORMANCE*\n`;
        report += `━━━━━━━━━━━━━━━━━━━━\n`;
        report += `Last 4 Weeks Track Record:\n`;
        report += `   ✅ Hit Rate: ${performance.hitRate.toFixed(1)}%\n`;
        report += `   📈 Avg Return: ${performance.avgActualMove > 0 ? '+' : ''}${performance.avgActualMove.toFixed(1)}%\n`;
        report += `   🎯 Total Predictions: ${performance.totalPredictions}\n`;
        
        if (performance.bySignal) {
          report += `\nBy Signal Type:\n`;
          Object.entries(performance.bySignal).forEach(([signal, stats]) => {
            const emoji = getSignalEmoji(signal);
            report += `   ${emoji} ${signal}: ${stats.hitRate.toFixed(0)}% (${stats.hits}/${stats.total})\n`;
          });
        }
        
        report += `\n`;
      }
      
      report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Risk disclaimer
      report += `⚠️ *IMPORTANT DISCLAIMER*\n`;
      report += `This is NOT financial advice. For educational purposes only. Past performance does not guarantee future results. Always do your own research. Trading involves risk of loss.\n\n`;
      report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Top 3 HIGH CONVICTION picks with ENHANCED analysis
      report += `🏆 *TOP 3 HIGH CONVICTION PICKS*\n\n`;
      
      for (let i = 0; i < Math.min(3, picks.length); i++) {
        const p = picks[i];
        const riskAnalysis = p.riskAnalysis || {};
        const riskScore = riskAnalysis.riskScore || 50;
        const invalidation = p.invalidationTriggers || {};
        const signalEmoji = getSignalEmoji(p.prediction.signal);
        const riskEmoji = getRiskEmoji(riskScore);
        
        // Calculate stop loss from risk analysis or default
        const stopLoss = invalidation.stopLoss || calculateStopLoss(p.volatility || 2, p.prediction.confidence);
        const stopPrice = (parseFloat(p.currentPrice) * (1 - stopLoss / 100)).toFixed(2);
        const riskReward = p.rewardRiskRatio || calculateRiskReward(p.prediction.expectedMove, stopLoss);
        
        report += `${signalEmoji} *${i + 1}. ${p.symbol}* - ${p.name}\n`;
        report += `${riskEmoji} Risk: ${riskScore}/100 | ${riskAnalysis.riskLevel || 'Medium'} | ${p.tradeType || 'Momentum'}\n`;
        report += `${signalEmoji} *${p.prediction.signal}* (${p.prediction.confidence}% confidence)\n\n`;
        
        report += `💰 *ENTRY & TARGETS*\n`;
        report += `   Current: $${p.currentPrice}\n`;
        report += `   Target: $${p.prediction.targetPrice} (${p.prediction.expectedMove > 0 ? '+' : ''}${p.prediction.expectedMove}%)\n`;
        report += `   🛑 Stop Loss: $${stopPrice} (-${typeof stopLoss === 'number' ? stopLoss.toFixed(1) : stopLoss}%)\n`;
        report += `   ⚖️ Reward/Risk: ${riskReward}x\n\n`;
        
        // NEW: Risk Factors
        if (riskAnalysis.factors && riskAnalysis.factors.length > 0) {
          report += `⚠️ *Risk Factors*:\n`;
          riskAnalysis.factors.slice(0, 3).forEach(factor => {
            report += `   • ${factor}\n`;
          });
          report += `\n`;
        }
        
        // NEW: Invalidation Triggers
        if (invalidation.technical || invalidation.fundamental) {
          report += `🚨 *Exit If*:\n`;
          if (invalidation.technical) {
            report += `   • Technical: ${invalidation.technical}\n`;
          }
          if (invalidation.fundamental) {
            report += `   • Fundamental: ${invalidation.fundamental}\n`;
          }
          report += `\n`;
        }
        
        report += `📊 *METRICS*\n`;
        report += `   Score: ${p.totalScore}/100\n`;
        report += `   Sector: ${p.sector}\n`;
        report += `   Volatility: ${(p.volatility || 2).toFixed(1)}%\n`;
        
        // Component scores breakdown
        if (p.componentScores) {
          report += `   Tech: ${p.componentScores.technical || 0} | `;
          report += `Fund: ${p.componentScores.fundamental || 0} | `;
          report += `AI: ${p.componentScores.ai || 0}\n`;
        }
        
        report += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      }
      
      // Remaining picks (4-10) - ENHANCED Compact format
      if (picks.length > 3) {
        report += `💼 *ADDITIONAL OPPORTUNITIES (4-10)*\n\n`;
        
        for (let i = 3; i < picks.length; i++) {
          const p = picks[i];
          const riskScore = p.riskAnalysis?.riskScore || 50;
          const signalEmoji = getSignalEmoji(p.prediction.signal);
          const riskEmoji = getRiskEmoji(riskScore);
          const invalidation = p.invalidationTriggers || {};
          const stopLoss = invalidation.stopLoss || calculateStopLoss(p.volatility || 2, p.prediction.confidence);
          const stopPrice = (parseFloat(p.currentPrice) * (1 - stopLoss / 100)).toFixed(2);
          
          report += `${signalEmoji} *${i + 1}. ${p.symbol}* ${riskEmoji}\n`;
          report += `   *${p.prediction.signal}* (${p.prediction.confidence}%) | Score: ${p.totalScore}\n`;
          report += `   💰 $${p.currentPrice} → $${p.prediction.targetPrice} (${p.prediction.expectedMove > 0 ? '+' : ''}${p.prediction.expectedMove}%)\n`;
          report += `   🛑 Stop: $${stopPrice} | Risk: ${riskScore}/100\n`;
          report += `   📊 ${p.tradeType || 'Momentum'} | ${p.sector}\n\n`;
        }
      }
      
      report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Portfolio allocation summary - ENHANCED
      report += `💼 *PORTFOLIO STRATEGY*\n`;
      report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Signal distribution
      const signalCounts = {};
      picks.forEach(p => {
        signalCounts[p.prediction.signal] = (signalCounts[p.prediction.signal] || 0) + 1;
      });
      
      report += `📊 *Signal Distribution*:\n`;
      Object.entries(signalCounts).forEach(([signal, count]) => {
        const emoji = getSignalEmoji(signal);
        report += `   ${emoji} ${signal}: ${count} stock${count > 1 ? 's' : ''}\n`;
      });
      report += `\n`;
      
      // Risk distribution - NEW
      const lowRisk = picks.filter(p => (p.riskAnalysis?.riskScore || 50) < 40).length;
      const medRisk = picks.filter(p => {
        const risk = p.riskAnalysis?.riskScore || 50;
        return risk >= 40 && risk < 60;
      }).length;
      const highRisk = picks.filter(p => (p.riskAnalysis?.riskScore || 50) >= 60).length;
      
      report += `⚖️ *Risk Distribution*:\n`;
      if (lowRisk > 0) report += `   🟢 Low Risk: ${lowRisk} (40% portfolio max)\n`;
      if (medRisk > 0) report += `   🟡 Medium Risk: ${medRisk} (35% portfolio max)\n`;
      if (highRisk > 0) report += `   🔴 High Risk: ${highRisk} (25% portfolio max)\n`;
      report += `\n`;
      
      // Calculate sector diversification
      const sectors = {};
      picks.forEach(p => {
        sectors[p.sector] = (sectors[p.sector] || 0) + 1;
      });
      
      report += `🏢 *Sector Diversification*:\n`;
      Object.entries(sectors)
        .sort((a, b) => b[1] - a[1])
        .forEach(([sector, count]) => {
          report += `   • ${sector}: ${count} (${(count / picks.length * 100).toFixed(0)}%)\n`;
        });
      
      report += `\n⚠️ *Risk Management Rules*:\n`;
      report += `   ✓ Max 8-10% per stock (diversification)\n`;
      report += `   ✓ ALWAYS use stop losses - no exceptions\n`;
      report += `   ✓ Review positions daily\n`;
      report += `   ✓ Take profits at targets\n`;
      report += `   ✓ Cut losses quickly if stop hit\n`;
      report += `   ✓ Don't chase - wait for entry points\n\n`;
      
      report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Footer with key stats - ENHANCED
      report += `📊 *ANALYSIS SUMMARY*\n`;
      report += `━━━━━━━━━━━━━━━━━━━━\n`;
      report += `📈 Stocks analyzed: ${res.data.universeSize || 200}\n`;
      report += `🏆 Top picks: ${picks.length}\n`;
      report += `💯 Avg confidence: ${Math.round(picks.reduce((sum, p) => sum + p.prediction.confidence, 0) / picks.length)}%\n`;
      report += `📊 Avg score: ${Math.round(picks.reduce((sum, p) => sum + p.totalScore, 0) / picks.length)}/100\n`;
      report += `📉 Avg expected move: ${(picks.reduce((sum, p) => sum + parseFloat(p.prediction.expectedMove), 0) / picks.length).toFixed(1)}%\n`;
      
      // Average risk score - NEW
      const avgRisk = picks.reduce((sum, p) => sum + (p.riskAnalysis?.riskScore || 50), 0) / picks.length;
      report += `⚖️ Avg risk score: ${avgRisk.toFixed(0)}/100\n\n`;
      
      report += `🔗 *Full Interactive Report*:\n`;
      report += `http://99.47.183.33:3000/weekly\n\n`;
      
      report += `━━━━━━━━━━━━━━━━━━━━\n`;
      report += `⚖️ *Legal*: Automated analysis for educational purposes only. Not investment advice. Trading involves substantial risk of loss. Do your own research.`;
      
      return report;
    }
    
    // No predictions available yet - should not happen with polling logic
    console.log('[Weekly Report] WARNING: No predictions available - this should not happen with polling enabled');
    throw new Error('No predictions available - polling should have waited for them');
  } catch (err) {
    console.error('[Weekly Report] Error:', err);
    throw err; // Re-throw to let caller handle retry logic
  }
}

async function sendReport() {
  const user = users.find(u => u.username === 'user' && u.phone);
  if (!user) throw new Error('User with phone not found');
  const report = await getWeeklyReport();
  const MAX_LENGTH = 4000; // Telegram max message length (safe margin)
  const chunks = [];
  let text = 'Weekly Report:\n' + report;
  while (text.length > 0) {
    chunks.push(text.slice(0, MAX_LENGTH));
    text = text.slice(MAX_LENGTH);
  }
  try {
    for (let i = 0; i < chunks.length; i++) {
      await sendTelegramMessage(user.phone, chunks[i]);
      // Add delay between chunks to avoid rate limiting
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay
      }
    }
    console.log('Telegram message(s) sent.');
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
    throw err; // Re-throw to let caller handle retry
  }
}

if (require.main === module) {
  sendReport();
}

module.exports = { sendReport };
