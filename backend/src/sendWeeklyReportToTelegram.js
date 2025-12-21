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
 * Format enhanced weekly report with professional analysis
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

    // Step 2: Fetch backend API for real prediction data using JWT
    const res = await axios.get('http://localhost:3001/api/weekly/predictions?limit=10', {
      headers: { Authorization: `Bearer ${token}` }
    });
    
    if (res.data && res.data.topPicks) {
      const picks = res.data.topPicks;
      const marketContext = res.data.marketContext;
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
      
      // Build comprehensive report
      let report = `📊 *Weekly Stock Analysis Report*\n`;
      report += `🕒 ${dateStr} at ${timeStr}\n`;
      report += `📈 Market Sentiment: ${getMarketRegime(marketContext)}\n`;
      report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Risk disclaimer
      report += `⚠️ *IMPORTANT DISCLAIMER*\n`;
      report += `This is NOT financial advice. This analysis is for educational purposes only. Past performance does not guarantee future results. Always do your own research and consult with a financial advisor before making investment decisions. Trading stocks involves risk of loss.\n\n`;
      report += `📊 *Data Source*: Yahoo Finance API\n`;
      report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Top 3 high conviction picks with detailed analysis
      report += `🏆 *TOP 3 HIGH CONVICTION PICKS*\n\n`;
      
      for (let i = 0; i < Math.min(3, picks.length); i++) {
        const p = picks[i];
        const stopLoss = calculateStopLoss(p.volatility, p.prediction.confidence);
        const stopPrice = (parseFloat(p.currentPrice) * (1 - stopLoss / 100)).toFixed(2);
        const riskReward = calculateRiskReward(p.prediction.expectedMove, stopLoss);
        const posSize = getPositionSize(p.tier, p.prediction.confidence, p.volatility);
        
        report += `*${i + 1}. ${p.symbol}* (Grade ${p.tier} | ${p.volatility < 2 ? 'Low' : p.volatility < 3 ? 'Medium' : 'High'} Risk)\n`;
        report += `   📈 Signal: *${p.prediction.signal}* | 💯 Confidence: ${p.prediction.confidence}%\n\n`;
        
        report += `   💰 Entry: $${p.currentPrice}\n`;
        report += `   🎯 Target: $${p.prediction.targetPrice} (+${p.prediction.expectedMove}%)\n`;
        report += `   🛑 Stop Loss: $${stopPrice} (-${stopLoss.toFixed(1)}%)\n`;
        report += `   ⚖️ Risk/Reward: 1:${riskReward}\n\n`;
        
        report += `   📊 Position Size: ${posSize} of portfolio\n`;
        report += `   ⏱️ Hold Period: 1-2 weeks\n`;
        report += `   📉 Volatility: ${p.volatility < 2 ? 'Low' : p.volatility < 3 ? 'Moderate' : 'High'} (${p.volatility.toFixed(2)})\n`;
        report += `   🔢 Technical Score: ${p.totalScore}/100\n\n`;
        
        // Add catalyst/rationale if available
        if (p.rationale && p.rationale.length > 0) {
          report += `   📝 Catalyst: ${p.rationale[0]}\n`;
        }
        
        report += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
      }
      
      // Remaining picks (4-10) - Compact format
      if (picks.length > 3) {
        report += `💼 *ADDITIONAL OPPORTUNITIES (Ranks 4-10)*\n\n`;
        
        for (let i = 3; i < picks.length; i++) {
          const p = picks[i];
          const stopLoss = calculateStopLoss(p.volatility, p.prediction.confidence);
          const stopPrice = (parseFloat(p.currentPrice) * (1 - stopLoss / 100)).toFixed(2);
          
          report += `*${i + 1}. ${p.symbol}* (${p.tier})\n`;
          report += `   📈 Signal: *${p.prediction.signal}* | 💯 Confidence: ${p.prediction.confidence}%\n`;
          report += `   💰 Price: $${p.currentPrice} | 🎯 Target: $${p.prediction.targetPrice} | 🛑 Stop: $${stopPrice}\n`;
          report += `   📊 Expected Move: ${p.prediction.expectedMove}% | 📉 Volatility: ${p.volatility.toFixed(2)}\n`;
          report += `   🔢 Score: ${p.totalScore}\n\n`;
        }
      }
      
      report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Portfolio allocation summary
      report += `💼 *PORTFOLIO ALLOCATION GUIDE*\n\n`;
      const tierA = picks.filter(p => p.tier === 'A').length;
      const tierB = picks.filter(p => p.tier === 'B').length;
      const tierC = picks.filter(p => p.tier === 'C').length;
      
      if (tierA > 0) report += `• Grade A (High Confidence): ${tierA} stocks - Allocate 30-40% total\n`;
      if (tierB > 0) report += `• Grade B (Good Confidence): ${tierB} stocks - Allocate 30-40% total\n`;
      if (tierC > 0) report += `• Grade C (Moderate): ${tierC} stocks - Allocate 20-30% total\n`;
      report += `\n`;
      
      // Calculate sector diversification
      const sectors = {};
      picks.forEach(p => {
        sectors[p.sector] = (sectors[p.sector] || 0) + 1;
      });
      
      report += `📊 *Sector Diversification*:\n`;
      Object.entries(sectors).forEach(([sector, count]) => {
        report += `   • ${sector}: ${count} stock${count > 1 ? 's' : ''}\n`;
      });
      
      report += `\n⚠️ *Risk Management*:\n`;
      report += `   • Max 10% per stock (diversification)\n`;
      report += `   • Always use stop losses\n`;
      report += `   • Don't invest more than you can afford to lose\n`;
      report += `   • Review positions daily\n\n`;
      
      report += `━━━━━━━━━━━━━━━━━━━━\n\n`;
      
      // Footer with key stats
      report += `📊 *Analysis Summary*\n`;
      report += `💡 Total stocks analyzed: ${res.data.totalAnalyzed || picks.length}\n`;
      report += `🏆 Top picks selected: ${picks.length}\n`;
      report += `📈 Avg confidence: ${Math.round(picks.reduce((sum, p) => sum + p.prediction.confidence, 0) / picks.length)}%\n`;
      report += `📉 Avg expected move: ${(picks.reduce((sum, p) => sum + parseFloat(p.prediction.expectedMove), 0) / picks.length).toFixed(2)}%\n\n`;
      
      report += `🔗 View full report: http://99.47.183.33:3000/weekly\n\n`;
      report += `━━━━━━━━━━━━━━━━━━━━\n`;
      report += `⚖️ *Legal Notice*: This report is generated by automated analysis and is for informational purposes only. Not investment advice. Trading involves substantial risk of loss.`;
      
      return report;
    }
    return 'No weekly picks available.';
  } catch (err) {
    console.error('[Weekly Report] Error:', err);
    return 'Error fetching weekly report: ' + err.message;
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
    }
    console.log('Telegram message(s) sent.');
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
  }
}

if (require.main === module) {
  sendReport();
}

module.exports = { sendReport };
