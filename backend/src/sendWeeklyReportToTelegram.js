const { sendTelegramMessage, getPrimaryTelegramRecipient } = require('./services/telegramService');
const axios = require('axios');
const {
  loadWeeklyPredictionSnapshot
} = require('./services/weeklyPredictionSnapshotService');
const {
  buildWeeklyPredictionCacheKey,
  WEEKLY_CACHE_TTL
} = require('./services/weeklyPredictionService');
const sectorMetadata = require('./services/sectorMetadataService');

const REPORT_PREDICTION_CONFIG = {
  // TOP_200 (~2-3 min) is the safe default. Override to ALL via env var only if pre-warming is in place.
  primaryUniverse: (process.env.TELEGRAM_REPORT_PRIMARY_UNIVERSE || 'TOP_200').toUpperCase(),
  fallbackUniverses: (process.env.TELEGRAM_REPORT_FALLBACK_UNIVERSES || 'MEGA_CAP')
    .split(',')
    .map(universe => universe.trim().toUpperCase())
    .filter(Boolean),
  fetchLimit: Math.max(10, Number.parseInt(process.env.TELEGRAM_REPORT_FETCH_LIMIT || '25', 10) || 25),
  // fetchTimeoutMs is used as the ALL-universe cap only. Per-universe timeouts are set in getUniverseTimeoutMs().
  fetchTimeoutMs: Math.max(120000, Number.parseInt(process.env.TELEGRAM_REPORT_FETCH_TIMEOUT_MS || '900000', 10) || 900000),
  // Minimum picks required before treating a universe response as usable.
  minTopPicks: Math.max(1, Number.parseInt(process.env.TELEGRAM_REPORT_MIN_TOP_PICKS || '3', 10) || 3),
  snapshotMaxAgeMs: Math.max(WEEKLY_CACHE_TTL, Number.parseInt(process.env.TELEGRAM_REPORT_SNAPSHOT_MAX_AGE_MS || `${12 * 60 * 60 * 1000}`, 10) || (12 * 60 * 60 * 1000)),
  priorityCount: 10,
  watchlistCount: 10
};

function buildPredictionRequestPlan() {
  return [...new Set([
    REPORT_PREDICTION_CONFIG.primaryUniverse,
    ...REPORT_PREDICTION_CONFIG.fallbackUniverses
  ])];
}

/**
 * Per-universe request timeouts that match expected scan durations.
 * ALL (820 stocks @ batch-3 + 2 s delay) ≈ 9–15 min → 600 s cap.
 * TOP_200 (200 stocks) ≈ 2–3 min → 240 s cap.
 * MEGA_CAP (50 stocks) ≈ 30–60 s → 90 s cap.
 */
function getUniverseTimeoutMs(universe) {
  const u = String(universe).toUpperCase();
  if (u === 'ALL' || u === 'COMPREHENSIVE' || u === 'FULL') return 600_000;
  if (u === 'TOP_200' || u === 'TOP200')                    return 240_000;
  return 90_000; // MEGA_CAP and any unknown universe
}

function buildReportPredictionOptions(universe = REPORT_PREDICTION_CONFIG.primaryUniverse) {
  return {
    limit: REPORT_PREDICTION_CONFIG.fetchLimit,
    minScore: 60,
    universe: String(universe).toUpperCase()
  };
}

async function fetchPredictionPayload(token) {
  const universes = buildPredictionRequestPlan();
  const errors = [];
  const minPicks = REPORT_PREDICTION_CONFIG.minTopPicks;

  for (const universe of universes) {
    const options = buildReportPredictionOptions(universe);
    const cacheKey = buildWeeklyPredictionCacheKey(options);
    const snapshot = loadWeeklyPredictionSnapshot(cacheKey, REPORT_PREDICTION_CONFIG.snapshotMaxAgeMs);

    if (snapshot?.payload?.topPicks?.length >= minPicks) {
      console.log(`[Report] Using persisted ${universe} snapshot (${snapshot.payload.topPicks.length} ranked picks available)...`);
      return {
        response: { data: snapshot.payload },
        universe,
        fallbackUsed: universe !== REPORT_PREDICTION_CONFIG.primaryUniverse,
        source: 'snapshot'
      };
    }

    try {
      const timeoutMs = getUniverseTimeoutMs(universe);
      console.log(`[Report] Fetching ${universe} predictions (${REPORT_PREDICTION_CONFIG.fetchLimit} ranked picks requested, timeout ${timeoutMs / 1000}s)...`);
      const response = await axios.get(
        `http://localhost:3001/api/weekly/predictions?limit=${REPORT_PREDICTION_CONFIG.fetchLimit}&universe=${encodeURIComponent(universe)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: timeoutMs
        }
      );

      const picks = response.data?.topPicks;
      if (!Array.isArray(picks) || picks.length < minPicks) {
        const reason = Array.isArray(picks)
          ? `only ${picks.length} picks (need ≥${minPicks}) — market filters may be too strict`
          : 'response missing topPicks';
        console.log(`[Report] ${universe} returned usable data but ${reason} — trying next universe`);
        errors.push(`${universe}: ${reason}`);
        continue;
      }

      return {
        response,
        universe,
        fallbackUsed: universe !== REPORT_PREDICTION_CONFIG.primaryUniverse,
        source: 'api'
      };
    } catch (error) {
      console.log(`[Report] ${universe} fetch failed: ${error.message}`);
      errors.push(`${universe}: ${error.message}`);
    }
  }

  throw new Error(`All prediction universes failed: ${errors.join(' | ')}`);
}

function summarizeRankedUniverse(predictions = []) {
  const summary = {
    count: predictions.length,
    avgScore: 0,
    avgConfidence: 0,
    avgExpectedMove: 0,
    signals: {},
    sectors: [],
    riskBuckets: { low: 0, medium: 0, high: 0 },
    strongSetups: 0
  };

  if (predictions.length === 0) {
    return summary;
  }

  let totalScore = 0;
  let totalConfidence = 0;
  let totalExpectedMove = 0;
  const sectorCounts = {};

  predictions.forEach(prediction => {
    totalScore += prediction.totalScore || 0;
    totalConfidence += prediction.prediction?.confidence || 0;
    totalExpectedMove += parseFloat(prediction.prediction?.expectedMove || 0);

    const signal = prediction.prediction?.signal || 'Unknown';
    summary.signals[signal] = (summary.signals[signal] || 0) + 1;

    const sector = sectorMetadata.resolveSector(prediction.symbol, prediction.sector);
    sectorCounts[sector] = (sectorCounts[sector] || 0) + 1;

    const riskScore = prediction.riskAnalysis?.riskScore || 50;
    if (riskScore < 40) {
      summary.riskBuckets.low += 1;
    } else if (riskScore < 60) {
      summary.riskBuckets.medium += 1;
    } else {
      summary.riskBuckets.high += 1;
    }

    if ((prediction.prediction?.confidence || 0) >= 85 &&
        (prediction.totalScore || 0) >= 80 &&
        (prediction.prediction?.signal === 'Strong Buy' || prediction.prediction?.signal === 'Buy')) {
      summary.strongSetups += 1;
    }
  });

  summary.avgScore = Math.round(totalScore / predictions.length);
  summary.avgConfidence = Math.round(totalConfidence / predictions.length);
  summary.avgExpectedMove = totalExpectedMove / predictions.length;
  summary.sectors = Object.entries(sectorCounts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([sector, count]) => ({ sector, count }));

  return summary;
}

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
      username: process.env.BOT_USERNAME || 'user',
      password: process.env.BOT_PASSWORD || 'password'
    });
    const token = loginRes.data.token;
    if (!token) throw new Error('No token received from login');

    // Step 2: Fetch ranked predictions with the full universe prioritized.
    const predictionPayload = await fetchPredictionPayload(token);
    const res = predictionPayload.response;
    
    // Fetch macro news + per-pick headlines in parallel (best-effort — failures don't block report)
    let macroNews = [];
    let pickNewsMap = {};

    if (res.data && res.data.topPicks && res.data.topPicks.length > 0) {
      const top3Symbols = res.data.topPicks.slice(0, 3).map(p => p.symbol);

      await Promise.allSettled([
        // Market-wide news
        axios.get('http://localhost:3001/api/news-aggregation/category/macro', {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000
        }).then(r => {
          macroNews = (r.data?.news || [])
            .filter(n => n.headline)
            .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))
            .slice(0, 5);
        }).catch(() => {}),

        // Per-pick news (top 3 only)
        ...top3Symbols.map(sym =>
          axios.get(`http://localhost:3001/api/news-aggregation/ticker/${sym}`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000
          }).then(r => {
            const articles = (r.data?.news || [])
              .filter(n => n.headline)
              .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
            if (articles.length > 0) pickNewsMap[sym] = articles[0];
          }).catch(() => {})
        )
      ]);
    }

    if (res.data && res.data.topPicks && res.data.topPicks.length > 0) {
      const rankedUniverse = Array.isArray(res.data.allAnalyzed) && res.data.allAnalyzed.length > 0
        ? res.data.allAnalyzed
        : res.data.topPicks;
      const picks = res.data.topPicks.slice(0, REPORT_PREDICTION_CONFIG.priorityCount);
      const watchlist = res.data.topPicks.slice(
        REPORT_PREDICTION_CONFIG.priorityCount,
        REPORT_PREDICTION_CONFIG.priorityCount + REPORT_PREDICTION_CONFIG.watchlistCount
      );
      const breadth = summarizeRankedUniverse(rankedUniverse);
      const marketContext = res.data.marketContext;
      const performance = res.data.performance;
      const coverage = res.data.universeSize > 0
        ? Math.round(((res.data.totalAnalyzed || rankedUniverse.length) / res.data.universeSize) * 100)
        : 0;
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
      let report = `📊 *TODAY'S PREDICTIONS*\n`;
      report += `━━━━━━━━━━━━━━━━━━━━\n`;
      report += `🕒 ${dateStr} at ${timeStr}\n\n`;
      report += `🔭 Universe priority: *${predictionPayload.universe}* ranked scan with the highest-conviction names first\n`;
      report += `📡 Coverage: ${res.data.totalAnalyzed || rankedUniverse.length}/${res.data.universeSize || rankedUniverse.length} stocks scored (${coverage}%)\n`;
      report += `🗃️ Data source: ${predictionPayload.source === 'snapshot' ? 'prewarmed snapshot' : 'live API generation'}\n`;
      if (predictionPayload.fallbackUsed) {
        report += `⚠️ Fallback mode active: ${predictionPayload.universe} used because ${REPORT_PREDICTION_CONFIG.primaryUniverse} was unavailable\n`;
      }
      report += `\n`;

      // Big News Section
      if (macroNews.length > 0) {
        report += `🗞️ *TODAY'S BIG NEWS*\n`;
        report += `━━━━━━━━━━━━━━━━━━━━\n`;
        macroNews.forEach(n => {
          const age = n.published_at
            ? Math.round((Date.now() - new Date(n.published_at)) / 3600000)
            : null;
          const ageStr = age !== null ? (age < 1 ? ' (just now)' : ` (${age}h ago)`) : '';
          const sourceIcon = n.source === 'X' ? '𝕏' : '📰';
          const engagementStr = n.source === 'X' && n.engagement > 0
            ? ` · ${n.engagement > 1000 ? (n.engagement / 1000).toFixed(1) + 'k' : n.engagement} engagements`
            : '';
          report += `${sourceIcon} ${n.headline}${ageStr}\n`;
          if (n.source) report += `  _— ${n.source}${engagementStr}_\n`;
        });
        report += `\n`;
      }

      // Market Context - NEW ENHANCED SECTION
      if (marketContext) {
        report += `🌍 *MARKET OVERVIEW*\n`;
        report += `━━━━━━━━━━━━━━━━━━━━\n`;
        
        // Market Regime
        if (marketContext.marketRegime) {
          const regimeObj = marketContext.marketRegime;
          const regimeLabel = regimeObj.regime || regimeObj.label || regimeObj.name || String(regimeObj);
          const regimeDesc  = regimeObj.description || '';
          let regimeEmoji = '📊';
          if (regimeLabel === 'Trending')    regimeEmoji = '📈';
          else if (regimeLabel === 'Range-Bound') regimeEmoji = '↔️';
          else if (regimeLabel === 'Volatile')    regimeEmoji = '⚡';
          else if (regimeLabel === 'Rotation')    regimeEmoji = '🔄';

          report += `${regimeEmoji} *Market Regime*: ${regimeLabel}\n`;
          if (regimeDesc) report += `   _${regimeDesc}_\n`;
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

      if (breadth.count > 0) {
        report += `🔎 *FULL-UNIVERSE VISIBILITY*\n`;
        report += `━━━━━━━━━━━━━━━━━━━━\n`;
        report += `Ranked universe: ${breadth.count} scored names from the ${res.data.universeSize || breadth.count}-stock list\n`;
        report += `High-conviction setups: ${breadth.strongSetups}\n`;
        report += `Average score: ${breadth.avgScore}/100 | Average confidence: ${breadth.avgConfidence}%\n`;
        report += `Average expected move: ${breadth.avgExpectedMove >= 0 ? '+' : ''}${breadth.avgExpectedMove.toFixed(1)}%\n\n`;

        report += `📊 *Signal Breadth*:\n`;
        Object.entries(breadth.signals)
          .sort((left, right) => right[1] - left[1])
          .forEach(([signal, count]) => {
            report += `   ${getSignalEmoji(signal)} ${signal}: ${count}\n`;
          });

        report += `\n🏢 *Top Sectors In The Ranked List*:\n`;
        breadth.sectors.forEach(({ sector, count }) => {
          report += `   • ${sector}: ${count}\n`;
        });

        report += `\n⚖️ *Risk Mix Across Ranked Names*:\n`;
        report += `   🟢 Low: ${breadth.riskBuckets.low}\n`;
        report += `   🟡 Medium: ${breadth.riskBuckets.medium}\n`;
        report += `   🔴 High: ${breadth.riskBuckets.high}\n\n`;
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
        
        report += `${signalEmoji} *${i + 1}. ${p.symbol}*\n`;
        report += `${riskEmoji} Risk: ${riskScore}/100 | ${riskAnalysis.riskLevel || 'Medium'} | ${p.tradeType || 'Momentum'}\n`;
        report += `${signalEmoji} *${p.prediction.signal}* (${p.prediction.confidence}% confidence)\n\n`;
        
        report += `💰 *ENTRY & TARGETS*\n`;
        report += `   Current: $${p.currentPrice}\n`;
        report += `   Target: $${p.prediction.targetPrice} (${p.prediction.expectedMove > 0 ? '+' : ''}${p.prediction.expectedMove}%)\n`;
        report += `   🛑 Stop Loss: $${stopPrice} (-${typeof stopLoss === 'number' ? stopLoss.toFixed(1) : stopLoss}%)\n`;
        report += `   ⚖️ Reward/Risk: ${riskReward}x\n\n`;
        
        // NEW: Risk Factors
        if (riskAnalysis.riskFactors && riskAnalysis.riskFactors.length > 0) {
          report += `⚠️ *Risk Factors*:\n`;
          riskAnalysis.riskFactors.slice(0, 3).forEach(factor => {
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

        // News sentiment from component score (50 = neutral, >70 = bullish, <30 = bearish)
        const sentScore = p.componentScores?.sentiment;
        if (sentScore !== undefined) {
          const sentLabel = sentScore > 70 ? '📰 Bullish news' :
                            sentScore < 30 ? '📰 Bearish news' : '📰 Neutral news';
          report += `   ${sentLabel} (sentiment: ${Math.round(sentScore)}/100)\n`;
        }

        // Why this pick — rationale generated by the prediction engine
        if (p.rationale) {
          report += `\n🔍 *Why this pick*: ${p.rationale}\n`;
        }

        // Upcoming events (earnings, etc.)
        if (p.upcomingEvents && p.upcomingEvents.length > 0) {
          report += `📅 *Upcoming*: ${p.upcomingEvents.slice(0, 2).join(', ')}\n`;
        }

        // Latest headline for this pick (fetched in parallel above)
        const pickNews = pickNewsMap[p.symbol];
        if (pickNews) {
          const pickIcon = pickNews.source === 'X' ? '𝕏' : '📰';
          const pickEng = pickNews.source === 'X' && pickNews.engagement > 0
            ? ` · ${pickNews.engagement > 1000 ? (pickNews.engagement / 1000).toFixed(1) + 'k' : pickNews.engagement} engagements`
            : '';
          report += `\n${pickIcon} *Latest*: "${pickNews.headline}"\n`;
          if (pickNews.source) report += `   _— ${pickNews.source}${pickEng}_\n`;
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
          
          const sentScore2 = p.componentScores?.sentiment;
          const sentEmoji = sentScore2 > 70 ? '📰+' : sentScore2 < 30 ? '📰-' : '';
          report += `${signalEmoji} *${i + 1}. ${p.symbol}* ${riskEmoji}${sentEmoji}\n`;
          report += `   *${p.prediction.signal}* (${p.prediction.confidence}%) | Score: ${p.totalScore}\n`;
          report += `   💰 $${p.currentPrice} → $${p.prediction.targetPrice} (${p.prediction.expectedMove > 0 ? '+' : ''}${p.prediction.expectedMove}%)\n`;
          report += `   🛑 Stop: $${stopPrice} | Risk: ${riskScore}/100\n`;
          report += `   📊 ${p.tradeType || 'Momentum'} | ${p.sector}\n\n`;
        }
      }

      if (watchlist.length > 0) {
        report += `🧭 *EXTENDED WATCHLIST (11-${10 + watchlist.length})*\n\n`;

        watchlist.forEach((pick, index) => {
          const rank = REPORT_PREDICTION_CONFIG.priorityCount + index + 1;
          report += `• ${rank}. ${pick.symbol} | ${pick.prediction.signal} | Score ${pick.totalScore} | `;
          report += `${pick.prediction.confidence}% conf | ${pick.sector}\n`;
        });

        report += `\n`;
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
      report += `📈 Universe requested: ${predictionPayload.universe}\n`;
      report += `📈 Stocks analyzed: ${res.data.totalAnalyzed || rankedUniverse.length} of ${res.data.universeSize || rankedUniverse.length}\n`;
      report += `🏆 Priority picks shown: ${picks.length}\n`;
      report += `🧭 Extended watchlist shown: ${watchlist.length}\n`;
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
  // Resolve chat ID: env var is the primary target, DB lookup is secondary
  const envChatId = process.env.TELEGRAM_CHAT_ID;
  let chatId = envChatId || null;

  if (!chatId) {
    // Fallback: look for any user with a stored telegram_chat_id
    const user = await getPrimaryTelegramRecipient('user');
    chatId = user?.telegram_chat_id || null;
  }

  if (!chatId) {
    throw new Error('No Telegram chat ID configured. Set TELEGRAM_CHAT_ID in .env');
  }

  const report = await getWeeklyReport();
  const MAX_LENGTH = 4000;
  const chunks = [];
  let text = report;
  while (text.length > 0) {
    chunks.push(text.slice(0, MAX_LENGTH));
    text = text.slice(MAX_LENGTH);
  }
  try {
    for (let i = 0; i < chunks.length; i++) {
      await sendTelegramMessage(chatId, chunks[i]);
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    console.log('Telegram message(s) sent.');
  } catch (err) {
    console.error('Failed to send Telegram message:', err.message);
    throw err;
  }
}

if (require.main === module) {
  sendReport();
}

module.exports = {
  sendReport,
  REPORT_PREDICTION_CONFIG,
  buildPredictionRequestPlan,
  buildReportPredictionOptions,
  summarizeRankedUniverse
};
