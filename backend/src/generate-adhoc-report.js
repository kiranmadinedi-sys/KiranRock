/**
 * Ad-hoc Weekly Report Generator and Telegram Sender
 * Generates predictions and sends complete report to Telegram
 */

const { getWeeklyPredictions } = require('./services/weeklyPredictionService');
const { sendTelegramMessage } = require('./services/telegramService');
const users = require('../users.json');

async function generateAndSendReport() {
  console.log('========================================');
  console.log('AD-HOC WEEKLY REPORT GENERATOR');
  console.log('========================================\n');
  
  try {
    // Step 1: Generate predictions
    console.log('Step 1: Generating weekly predictions...');
    console.log('Analyzing ALL stocks from market screener...\n');
    
    const startTime = Date.now();
    const predictions = await getWeeklyPredictions({
      limit: 20,
      minScore: 60,
      universe: 'TOP_200'
    });
    
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✓ Predictions generated in ${elapsed}s`);
    console.log(`  - Universe size: ${predictions.universeSize || 'N/A'}`);
    console.log(`  - Top picks: ${predictions.topPicks?.length || 0}`);
    console.log(`  - Market context: ${predictions.marketContext?.averageScore || 'N/A'}\n`);
    
    if (!predictions.topPicks || predictions.topPicks.length === 0) {
      console.log('❌ No predictions generated - cannot send report\n');
      return;
    }
    
    // Step 2: Format report
    console.log('Step 2: Formatting report for Telegram...\n');
    const report = formatWeeklyReport(predictions);
    
    console.log(`Report size: ${report.length} characters`);
    console.log(`Telegram messages needed: ${Math.ceil(report.length / 4000)}\n`);
    
    // Step 3: Send to Telegram
    console.log('Step 3: Sending to Telegram...\n');
    
    const user = users.find(u => u.username === 'user' && u.phone);
    if (!user) {
      console.log('❌ User with phone number not found in users.json\n');
      return;
    }
    
    console.log(`Target: ${user.phone} (@KiranTradePro_bot)\n`);
    
    const MAX_LENGTH = 4000;
    const chunks = [];
    let text = report;
    
    while (text.length > 0) {
      chunks.push(text.slice(0, MAX_LENGTH));
      text = text.slice(MAX_LENGTH);
    }
    
    for (let i = 0; i < chunks.length; i++) {
      console.log(`Sending message ${i + 1}/${chunks.length}...`);
      await sendTelegramMessage(user.phone, chunks[i]);
      
      // Small delay between messages
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    console.log('\n✓ Report sent successfully!');
    console.log('\n========================================');
    console.log('REPORT PREVIEW (First 500 chars):');
    console.log('========================================');
    console.log(report.substring(0, 500) + '...\n');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
  }
}

function formatWeeklyReport(data) {
  const picks = data.topPicks || [];
  const marketContext = data.marketContext || {};
  
  let report = `📈 *WEEKLY STOCK PREDICTIONS*\n`;
  report += `━━━━━━━━━━━━━━━━━━━━\n`;
  report += `📅 Generated: ${new Date().toLocaleString('en-US', { 
    weekday: 'short', 
    month: 'short', 
    day: 'numeric', 
    hour: '2-digit', 
    minute: '2-digit' 
  })}\n`;
  report += `🎯 Horizon: Next 5-7 trading days\n\n`;
  
  // Market overview
  const avgScore = marketContext.averageScore || 60;
  const marketRegime = avgScore > 70 ? '🟢 Bullish' : avgScore < 50 ? '🔴 Bearish' : '🟡 Sideways';
  report += `📊 *MARKET OVERVIEW*\n`;
  report += `━━━━━━━━━━━━━━━━━━━━\n`;
  report += `Market Regime: ${marketRegime}\n`;
  report += `Avg Market Score: ${avgScore.toFixed(0)}/100\n\n`;
  
  // Top picks with tiers
  const tierA = picks.filter(p => p.tier === 'A');
  const tierB = picks.filter(p => p.tier === 'B');
  const tierC = picks.filter(p => p.tier === 'C');
  
  if (tierA.length > 0) {
    report += `🏆 *TIER A - HIGHEST CONVICTION* (${tierA.length})\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n`;
    tierA.forEach((pick, idx) => {
      report += formatStockPick(pick, idx + 1);
    });
  }
  
  if (tierB.length > 0) {
    report += `\n⭐ *TIER B - STRONG OPPORTUNITIES* (${tierB.length})\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n`;
    tierB.forEach((pick, idx) => {
      report += formatStockPick(pick, idx + 1);
    });
  }
  
  if (tierC.length > 0) {
    report += `\n💡 *TIER C - WATCH LIST* (${tierC.length})\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n`;
    tierC.forEach((pick, idx) => {
      report += formatStockPick(pick, idx + 1);
    });
  }
  
  report += `\n━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  // Summary stats
  report += `📊 *ANALYSIS SUMMARY*\n`;
  report += `━━━━━━━━━━━━━━━━━━━━\n`;
  report += `📈 Stocks analyzed: ${data.universeSize || 200}\n`;
  report += `🏆 Top picks: ${picks.length}\n`;
  report += `💯 Avg confidence: ${Math.round(picks.reduce((sum, p) => sum + p.prediction.confidence, 0) / picks.length)}%\n`;
  report += `📊 Avg score: ${Math.round(picks.reduce((sum, p) => sum + p.totalScore, 0) / picks.length)}/100\n`;
  report += `📉 Avg expected move: ${(picks.reduce((sum, p) => sum + parseFloat(p.prediction.expectedMove), 0) / picks.length).toFixed(1)}%\n\n`;
  
  report += `🔗 *Full Interactive Report*:\n`;
  report += `http://99.47.183.33:3000/weekly\n\n`;
  
  report += `━━━━━━━━━━━━━━━━━━━━\n`;
  report += `⚖️ *Legal*: Automated analysis for educational purposes only. Not investment advice. Trading involves substantial risk of loss. Do your own research.`;
  
  return report;
}

function formatStockPick(pick, idx) {
  const signal = pick.prediction.direction === 'UP' ? '🚀' : '📉';
  const confidence = pick.prediction.confidence;
  const confidenceEmoji = confidence > 85 ? '🔥' : confidence > 75 ? '💪' : '👍';
  
  const stopLoss = calculateStopLoss(pick.technicals?.volatility || 2, confidence);
  const riskReward = calculateRiskReward(pick.prediction.expectedMove, stopLoss);
  const positionSize = getPositionSize(pick.tier, confidence, pick.technicals?.volatility || 2);
  
  let text = `${idx}. *${pick.symbol}* - ${pick.company}\n`;
  text += `   ${signal} ${pick.prediction.direction} ${pick.prediction.expectedMove}% | `;
  text += `${confidenceEmoji} ${confidence}% confidence\n`;
  text += `   💯 Score: ${pick.totalScore}/100 | `;
  text += `📊 Sector: ${pick.sector || 'N/A'}\n`;
  text += `   📍 Entry: $${pick.currentPrice} | `;
  text += `🛑 Stop: ${stopLoss.toFixed(1)}%\n`;
  text += `   ⚖️ R:R ${riskReward}x | `;
  text += `💰 Size: ${positionSize}\n`;
  
  if (pick.prediction.reasoning) {
    const reason = pick.prediction.reasoning.substring(0, 100);
    text += `   💡 ${reason}${reason.length < pick.prediction.reasoning.length ? '...' : ''}\n`;
  }
  
  text += `\n`;
  return text;
}

function calculateStopLoss(volatility, confidence) {
  const baseStop = 3.0;
  const volatilityFactor = Math.min(volatility / 2, 3);
  const confidenceFactor = (100 - confidence) / 50;
  return Math.min(baseStop + volatilityFactor + confidenceFactor, 8);
}

function calculateRiskReward(expectedMove, stopLoss) {
  const reward = Math.abs(parseFloat(expectedMove));
  const risk = stopLoss;
  return (reward / risk).toFixed(1);
}

function getPositionSize(tier, confidence, volatility) {
  if (tier === 'A' && confidence > 85) return '8-10%';
  if (tier === 'A' || (tier === 'B' && confidence > 80)) return '5-8%';
  if (tier === 'B') return '3-5%';
  if (tier === 'C' && volatility < 2) return '2-4%';
  return '1-3%';
}

// Run the generator
generateAndSendReport().catch(console.error);
