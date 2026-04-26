'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';
import { useRouter } from 'next/navigation';
import AppHeader from '../components/AppHeader';

interface StockPrediction {
  symbol: string;
  totalScore: number;
  tier: string;
  componentScores: {
    ai: number;
    technical: number;
    fundamental: number;
    momentum: number;
    sentiment: number;
    volume: number;
    volatility: number;
  };
  prediction: {
    signal: string;
    expectedMove: string;
    confidence: number;
    targetPrice: string;
  };
  currentPrice: string;
  priceChange1w: string;
  rationale: string;
  upcomingEvents: any[];
  technicalSignals: Array<{ type: string; direction: string }>;
  analystRatings: any;
  sector: string;
  volatility: number;
  riskAnalysis: {
    riskScore: number;
    riskFactors: string[];
    riskLevel: string;
  };
  invalidationTriggers: Array<{
    type: string;
    level?: string;
    description: string;
  }>;
  rewardRiskRatio: string;
  tradeType: string;
}

interface MarketContext {
  marketSentiment: string;
  averageScore: number;
  distribution: {
    bullish: number;
    bearish: number;
    neutral: number;
  };
  topSectors: Array<{ sector: string; avgScore: number; count: number }>;
  macroTrends: {
    growthVsValue: string;
    riskAppetite: string;
    volatilityRegime: string;
    momentumStrength: string;
  };
  sectorRotation: {
    rotatingInto: string[];
    rotatingOutOf: string[];
    leadingSector: string;
    laggingSector: string;
  };
  marketRegime: {
    regime: string;
    description: string;
    recommendation: string;
  };
  summary: string;
}

interface PerformanceStats {
  totalPredictions: number;
  hits: number;
  misses: number;
  hitRate: string;
  avgActualMove: string;
  avgPredictedMove: string;
  avgConfidence: string;
  avgHitReturn: string;
  avgMissReturn: string;
  tierPerformance: Array<{
    tier: string;
    count: number;
    hits: number;
    hitRate: string;
    avgReturn: string;
  }>;
  weeksTracked: number;
}

export default function WeeklyPredictionsPage() {
  const router = useRouter();
  const [predictions, setPredictions] = useState<StockPrediction[]>([]);
  const [marketContext, setMarketContext] = useState<MarketContext | null>(null);
  const [performance, setPerformance] = useState<PerformanceStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedTier, setSelectedTier] = useState<string>('all');
  const [selectedSector, setSelectedSector] = useState<string>('all');
  const [selectedSignal, setSelectedSignal] = useState<string>('all');
  const [selectedUniverse, setSelectedUniverse] = useState<string>('TOP_200');
  const [showDetails, setShowDetails] = useState<Record<string, boolean>>({});
  const [token, setToken] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'score' | 'confidence' | 'risk'>('score');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // Download CSV logic
  const downloadCSV = () => {
    if (!filteredPredictions.length) return;
    const headers = [
      'Symbol', 'Tier', 'Score', 'Signal', 'Expected Move', 'Confidence', 'Current Price', '1W Change', 'Target Price', 'Volatility', 'Rationale'
    ];
    const rows = filteredPredictions.map(pred => [
      pred.symbol,
      pred.tier,
      pred.totalScore,
      pred.prediction.signal,
      pred.prediction.expectedMove,
      pred.prediction.confidence,
      pred.currentPrice,
      pred.priceChange1w,
      pred.prediction.targetPrice,
      pred.volatility,
      pred.rationale.replace(/\n/g, ' ')
    ]);
    const csvContent = [headers, ...rows]
      .map(row => row.map(String).map(v => `"${v.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `weekly-predictions-${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    const storedToken = localStorage.getItem('token');
    if (!storedToken) {
      router.push('/login');
    } else {
      setToken(storedToken);
    }
  }, [router]);

  useEffect(() => {
    if (!token) return;
    fetchWeeklyPredictions();
  }, [token, selectedUniverse]); // Re-fetch when universe changes

  const fetchWeeklyPredictions = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `${getApiBaseUrl()}/api/weekly/predictions?limit=100&minScore=50&universe=${selectedUniverse}`,
        {
          headers: { Authorization: `Bearer ${token}` }
        }
      );
      if (response.ok) {
        const data = await response.json();
        setPredictions(data.topPicks || []);
        setMarketContext(data.marketContext);
        setPerformance(data.performance);
      } else {
        console.error('Failed to fetch predictions:', response.status);
      }
    } catch (error) {
      console.error('Error fetching weekly predictions:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    router.push('/login');
  };

  const getTierColor = (tier: string) => {
    switch (tier) {
      case 'A': return 'bg-green-500 text-white';
      case 'B': return 'bg-blue-500 text-white';
      case 'C': return 'bg-yellow-500 text-white';
      case 'D': return 'bg-orange-500 text-white';
      case 'F': return 'bg-red-500 text-white';
      default: return 'bg-gray-500 text-white';
    }
  };

  const getSignalColor = (signal: string) => {
    switch (signal) {
      case 'Strong Buy':
      case 'Buy': return 'text-green-600 dark:text-green-400';
      case 'Sell': return 'text-red-600 dark:text-red-400';
      case 'Avoid': return 'text-orange-600 dark:text-orange-400';
      default: return 'text-yellow-600 dark:text-yellow-400';
    }
  };

  const getRiskColor = (riskLevel: string) => {
    switch (riskLevel) {
      case 'Very Low':
      case 'Low': return 'text-green-500';
      case 'Moderate': return 'text-yellow-500';
      case 'High': return 'text-orange-500';
      case 'Very High': return 'text-red-500';
      default: return 'text-gray-500';
    }
  };

  const handleSort = (column: 'score' | 'confidence' | 'risk') => {
    if (sortBy === column) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(column);
      setSortOrder('desc');
    }
  };

  const filteredPredictions = predictions
    .filter(pred => {
      if (selectedTier !== 'all' && pred.tier !== selectedTier) return false;
      if (selectedSector !== 'all' && pred.sector !== selectedSector) return false;
      if (selectedSignal !== 'all' && pred.prediction.signal !== selectedSignal) return false;
      return true;
    })
    .sort((a, b) => {
      let comparison = 0;
      if (sortBy === 'score') {
        comparison = a.totalScore - b.totalScore;
      } else if (sortBy === 'confidence') {
        comparison = a.prediction.confidence - b.prediction.confidence;
      } else if (sortBy === 'risk') {
        comparison = (a.riskAnalysis?.riskScore || 50) - (b.riskAnalysis?.riskScore || 50);
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });

  const uniqueSectors = Array.from(new Set(predictions.map(p => p.sector))).sort();

  if (loading) {
    const estimatedTime = selectedUniverse === 'ALL' ? '3-5 minutes' : 
                         selectedUniverse === 'TOP_200' ? '60-90 seconds' : '15-20 seconds';
    const stockCount = selectedUniverse === 'ALL' ? '800+' : 
                      selectedUniverse === 'TOP_200' ? '200' : '50';
    
    return (
      <div className="min-h-screen bg-[var(--color-bg-primary)] flex items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold text-[var(--color-text-primary)] mb-4">
            🔮 Analyzing {stockCount} stocks...
          </div>
          <div className="text-[var(--color-text-secondary)]">
            Estimated time: {estimatedTime}
          </div>
          <div className="mt-4 animate-pulse text-blue-500">
            Running AI models, calculating risk scores, detecting patterns...
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900">
      <AppHeader showSearch={false} />

      <div className="max-w-[1800px] mx-auto px-3 sm:px-4 py-3 sm:py-4">
        {/* Page Title */}
        <div className="mb-3 sm:mb-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold text-[var(--color-text-primary)] mb-2 flex items-center gap-2">
              <span>🔮</span>
              Top Weekly Stock Predictions
            </h1>
            <p className="text-xs sm:text-sm text-[var(--color-text-secondary)]">
              AI-powered analysis of {predictions.length}+ major stocks | Updated: {new Date().toLocaleDateString()}
            </p>
          </div>
          <div className="flex gap-2 w-full lg:w-auto">
            <select
              value={selectedUniverse}
              onChange={(e) => setSelectedUniverse(e.target.value)}
              className="px-3 py-2 bg-purple-500 hover:bg-purple-600 text-white rounded-md font-semibold text-xs sm:text-sm shadow transition-colors flex-1 lg:flex-none"
            >
              <option value="MEGA_CAP">⚡ Quick (50 stocks)</option>
              <option value="TOP_200">📊 Balanced (200 stocks)</option>
              <option value="ALL">🌐 All (800+ stocks)</option>
            </select>
            <button
              onClick={() => router.push('/recommendations')}
              className="px-3 sm:px-4 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-md font-semibold text-xs sm:text-sm shadow transition-colors whitespace-nowrap"
              title="Get personalized recommendations"
            >
              🎯 Recommendations
            </button>
            <button
              onClick={downloadCSV}
              className="px-3 sm:px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-md font-semibold text-xs sm:text-sm shadow transition-colors whitespace-nowrap"
              disabled={!filteredPredictions.length}
              title={filteredPredictions.length ? 'Download CSV' : 'No data to download'}
            >
              ⬇️ CSV
            </button>
          </div>
        </div>

        {/* Market Context */}
        {marketContext && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 mb-4 sm:mb-6">
            <div className="bg-[var(--color-card)] rounded-lg p-3 sm:p-4 border border-[var(--color-border)]">
              <h3 className="text-xs sm:text-sm font-semibold text-[var(--color-text-secondary)] mb-2">Market Sentiment</h3>
              <div className={`text-xl sm:text-2xl font-bold ${
                marketContext.marketSentiment === 'Bullish' ? 'text-green-500' :
                marketContext.marketSentiment === 'Bearish' ? 'text-red-500' : 'text-yellow-500'
              }`}>
                {marketContext.marketSentiment}
              </div>
              <p className="text-xs text-[var(--color-text-secondary)] mt-2">
                Avg Score: {marketContext.averageScore}/100
              </p>
            </div>

            <div className="bg-[var(--color-card)] rounded-lg p-3 sm:p-4 border border-[var(--color-border)]">
              <h3 className="text-xs sm:text-sm font-semibold text-[var(--color-text-secondary)] mb-2">Distribution</h3>
              <div className="flex flex-wrap gap-3 sm:gap-4 text-xs sm:text-sm">
                <div>
                  <span className="text-green-500 font-bold">{marketContext.distribution.bullish}</span>
                  <span className="text-[var(--color-text-secondary)] ml-1">Bullish</span>
                </div>
                <div>
                  <span className="text-red-500 font-bold">{marketContext.distribution.bearish}</span>
                  <span className="text-[var(--color-text-secondary)] ml-1">Bearish</span>
                </div>
                <div>
                  <span className="text-yellow-500 font-bold">{marketContext.distribution.neutral}</span>
                  <span className="text-[var(--color-text-secondary)] ml-1">Neutral</span>
                </div>
              </div>
            </div>

            <div className="bg-[var(--color-card)] rounded-lg p-4 border border-[var(--color-border)]">
              <h3 className="text-sm font-semibold text-[var(--color-text-secondary)] mb-2">Top Sectors</h3>
              <div className="space-y-1 text-xs">
                {marketContext.topSectors.slice(0, 3).map((sector, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span>{sector.sector}</span>
                    <span className="font-semibold">{sector.avgScore}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Performance Tracking */}
        {performance && (
          <div className="bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-2 border-blue-500/30 rounded-lg p-4 mb-6">
            <h3 className="text-lg font-bold text-[var(--color-text-primary)] mb-3 flex items-center gap-2">
              📊 Last 4 Weeks Performance
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-4">
              <div>
                <div className="text-xs text-[var(--color-text-secondary)]">Hit Rate</div>
                <div className="text-2xl font-bold text-green-500">{performance.hitRate}%</div>
                <div className="text-xs text-[var(--color-text-secondary)]">{performance.hits}/{performance.totalPredictions}</div>
              </div>
              <div>
                <div className="text-xs text-[var(--color-text-secondary)]">Avg Return (Hits)</div>
                <div className="text-2xl font-bold text-green-500">+{performance.avgHitReturn}%</div>
              </div>
              <div>
                <div className="text-xs text-[var(--color-text-secondary)]">Avg Return (Miss)</div>
                <div className="text-2xl font-bold text-red-500">{performance.avgMissReturn}%</div>
              </div>
              <div>
                <div className="text-xs text-[var(--color-text-secondary)]">Confidence</div>
                <div className="text-2xl font-bold text-blue-500">{performance.avgConfidence}%</div>
              </div>
              {performance.tierPerformance && performance.tierPerformance[0] && (
                <>
                  <div>
                    <div className="text-xs text-[var(--color-text-secondary)]">Tier A Hit Rate</div>
                    <div className="text-xl font-bold text-green-500">
                      {performance.tierPerformance.find(t => t.tier === 'A')?.hitRate || 'N/A'}%
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[var(--color-text-secondary)]">Tier B Hit Rate</div>
                    <div className="text-xl font-bold text-blue-500">
                      {performance.tierPerformance.find(t => t.tier === 'B')?.hitRate || 'N/A'}%
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Macro Market Overlay */}
        {marketContext?.macroTrends && (
          <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-4 mb-6">
            <h3 className="text-lg font-bold text-[var(--color-text-primary)] mb-3 flex items-center gap-2">
              🌍 Macro Market Context
            </h3>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div>
                <h4 className="text-sm font-semibold text-[var(--color-text-secondary)] mb-2">Market Regime</h4>
                <div className="bg-[var(--color-bg-tertiary)] rounded p-3">
                  <div className="text-lg font-bold text-blue-500 mb-1">
                    {marketContext.marketRegime.regime}
                  </div>
                  <div className="text-xs text-[var(--color-text-secondary)] mb-2">
                    {marketContext.marketRegime.description}
                  </div>
                  <div className="text-xs text-green-500 font-semibold">
                    💡 {marketContext.marketRegime.recommendation}
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-[var(--color-text-secondary)] mb-2">Sector Rotation</h4>
                <div className="bg-[var(--color-bg-tertiary)] rounded p-3">
                  {marketContext.sectorRotation.rotatingInto.length > 0 && (
                    <div className="mb-2">
                      <div className="text-xs text-green-500 font-semibold">📈 Rotating Into:</div>
                      <div className="text-xs text-[var(--color-text-primary)]">
                        {marketContext.sectorRotation.rotatingInto.join(', ')}
                      </div>
                    </div>
                  )}
                  {marketContext.sectorRotation.rotatingOutOf.length > 0 && (
                    <div>
                      <div className="text-xs text-red-500 font-semibold">📉 Rotating Out:</div>
                      <div className="text-xs text-[var(--color-text-primary)]">
                        {marketContext.sectorRotation.rotatingOutOf.join(', ')}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-[var(--color-text-secondary)] mb-2">Trends</h4>
                <div className="bg-[var(--color-bg-tertiary)] rounded p-3 space-y-1 text-xs text-[var(--color-text-primary)]">
                  <div>📊 {marketContext.macroTrends.growthVsValue}</div>
                  <div>🎯 {marketContext.macroTrends.riskAppetite}</div>
                  <div>📉 {marketContext.macroTrends.volatilityRegime}</div>
                  <div>⚡ {marketContext.macroTrends.momentumStrength}</div>
                </div>
              </div>

              <div>
                <h4 className="text-sm font-semibold text-[var(--color-text-secondary)] mb-2">Summary</h4>
                <div className="bg-[var(--color-bg-tertiary)] rounded p-3 text-xs text-[var(--color-text-primary)]">
                  {marketContext.summary}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-[var(--color-card)] rounded-lg p-4 mb-6 border border-[var(--color-border)]">
          <div className="flex flex-wrap gap-4 items-center">
            <div>
              <label className="text-sm text-[var(--color-text-secondary)] mr-2">Tier:</label>
              <select
                value={selectedTier}
                onChange={(e) => setSelectedTier(e.target.value)}
                className="px-3 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
              >
                <option value="all">All Tiers</option>
                <option value="A">A - Excellent</option>
                <option value="B">B - Good</option>
                <option value="C">C - Fair</option>
                <option value="D">D - Poor</option>
              </select>
            </div>

            <div>
              <label className="text-sm text-[var(--color-text-secondary)] mr-2">Signal:</label>
              <select
                value={selectedSignal}
                onChange={(e) => setSelectedSignal(e.target.value)}
                className="px-3 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
              >
                <option value="all">All Signals</option>
                <option value="Strong Buy">Strong Buy</option>
                <option value="Buy">Buy</option>
                <option value="Hold">Hold</option>
                <option value="Avoid">Avoid</option>
              </select>
            </div>

            <div>
              <label className="text-sm text-[var(--color-text-secondary)] mr-2">Sector:</label>
              <select
                value={selectedSector}
                onChange={(e) => setSelectedSector(e.target.value)}
                className="px-3 py-1 rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)]"
              >
                <option value="all">All Sectors</option>
                {uniqueSectors.map(sector => (
                  <option key={sector} value={sector}>{sector}</option>
                ))}
              </select>
            </div>

            <div className="ml-auto text-sm text-[var(--color-text-secondary)]">
              Showing {filteredPredictions.length} of {predictions.length} stocks
            </div>
          </div>
        </div>

        {/* Predictions Table */}
        <div className="bg-[var(--color-card)] rounded-lg border border-[var(--color-border)] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-[var(--color-bg-tertiary)] border-b border-[var(--color-border)]">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)]">Rank</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)]">Symbol</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)]">Tier</th>
                  <th 
                    className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)] cursor-pointer hover:text-blue-500 select-none"
                    onClick={() => handleSort('score')}
                  >
                    Score {sortBy === 'score' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)]">Signal</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)]">Expected Move</th>
                  <th 
                    className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)] cursor-pointer hover:text-blue-500 select-none"
                    onClick={() => handleSort('confidence')}
                  >
                    Confidence {sortBy === 'confidence' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th 
                    className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)] cursor-pointer hover:text-blue-500 select-none"
                    onClick={() => handleSort('risk')}
                  >
                    Risk {sortBy === 'risk' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)]">Type</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)]">Rationale</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-[var(--color-text-secondary)]">Details</th>
                </tr>
              </thead>
              <tbody>
                {filteredPredictions.map((pred, idx) => (
                  <React.Fragment key={pred.symbol}>
                    <tr className="border-b border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)] transition-colors">
                      <td className="px-4 py-3 text-sm font-semibold text-[var(--color-text-primary)]">#{idx + 1}</td>
                      <td className="px-4 py-3">
                        <div className="font-bold text-[var(--color-text-primary)]">{pred.symbol}</div>
                        <div className="text-xs text-[var(--color-text-secondary)]">{pred.sector}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-1 rounded font-bold text-sm ${getTierColor(pred.tier)}`}>
                          {pred.tier}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm font-bold text-[var(--color-text-primary)]">{pred.totalScore}</div>
                        <div className="w-16 h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500"
                            style={{ width: `${pred.totalScore}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className={`font-bold ${getSignalColor(pred.prediction.signal)}`}>
                          {pred.prediction.signal}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className={`font-semibold ${parseFloat(pred.prediction.expectedMove) > 0 ? 'text-green-500' : 'text-red-500'}`}>
                          {parseFloat(pred.prediction.expectedMove) > 0 ? '+' : ''}{pred.prediction.expectedMove}%
                        </div>
                        <div className="text-xs text-[var(--color-text-secondary)]">
                          Target: ${pred.prediction.targetPrice}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm font-semibold text-[var(--color-text-primary)]">
                          {pred.prediction.confidence}%
                        </div>
                      </td>
                      <td className="px-4 py-3 max-w-xs">
                        <div className="text-xs text-[var(--color-text-secondary)] truncate">
                          {pred.rationale}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <button
                          onClick={() => setShowDetails(prev => ({ ...prev, [pred.symbol]: !prev[pred.symbol] }))}
                          className="text-blue-500 hover:text-blue-600 text-xs font-semibold"
                        >
                          {showDetails[pred.symbol] ? '▼ Hide' : '▶ Show'}
                        </button>
                      </td>
                    </tr>
                    
                    {showDetails[pred.symbol] && (
                      <tr>
                        <td colSpan={9} className="px-4 py-4 bg-[var(--color-bg-tertiary)]">
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                            {/* Component Scores */}
                            <div>
                              <h4 className="font-semibold text-sm mb-2 text-[var(--color-text-primary)]">Component Scores</h4>
                              <div className="space-y-1 text-xs">
                                <div className="flex justify-between">
                                  <span>AI Signal:</span>
                                  <span className="font-semibold">{pred.componentScores.ai}/100</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Technical:</span>
                                  <span className="font-semibold">{pred.componentScores.technical}/100</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Fundamental:</span>
                                  <span className="font-semibold">{pred.componentScores.fundamental}/100</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Momentum:</span>
                                  <span className="font-semibold">{pred.componentScores.momentum}/100</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Sentiment:</span>
                                  <span className="font-semibold">{pred.componentScores.sentiment}/100</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Volume:</span>
                                  <span className="font-semibold">{pred.componentScores.volume}/100</span>
                                </div>
                              </div>
                            </div>

                            {/* Technical Signals */}
                            <div>
                              <h4 className="font-semibold text-sm mb-2 text-[var(--color-text-primary)]">Technical Signals</h4>
                              <div className="space-y-1 text-xs">
                                {pred.technicalSignals.map((signal, idx) => (
                                  <div key={idx} className="flex items-center gap-2">
                                    <span className={`
                                      ${signal.direction === 'bullish' ? 'text-green-500' : ''}
                                      ${signal.direction === 'bearish' ? 'text-red-500' : ''}
                                      ${signal.direction === 'neutral' ? 'text-yellow-500' : ''}
                                    `}>
                                      {signal.direction === 'bullish' ? '📈' : signal.direction === 'bearish' ? '📉' : '⏸️'}
                                    </span>
                                    <span>{signal.type}</span>
                                  </div>
                                ))}
                                {pred.technicalSignals.length === 0 && (
                                  <div className="text-[var(--color-text-secondary)]">No notable signals</div>
                                )}
                              </div>
                            </div>

                            {/* Price Info */}
                            <div>
                              <h4 className="font-semibold text-sm mb-2 text-[var(--color-text-primary)]">Price Information</h4>
                              <div className="space-y-1 text-xs">
                                <div className="flex justify-between">
                                  <span>Current Price:</span>
                                  <span className="font-semibold">${pred.currentPrice}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>1W Change:</span>
                                  <span className={`font-semibold ${parseFloat(pred.priceChange1w) > 0 ? 'text-green-500' : 'text-red-500'}`}>
                                    {parseFloat(pred.priceChange1w) > 0 ? '+' : ''}{pred.priceChange1w}%
                                  </span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Target Price:</span>
                                  <span className="font-semibold">${pred.prediction.targetPrice}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span>Volatility:</span>
                                  <span className="font-semibold">{pred.volatility.toFixed(2)}%</span>
                                </div>
                              </div>
                            </div>
                          </div>
                          
                          {/* Full Rationale */}
                          <div className="mt-4 p-3 bg-[var(--color-card)] rounded border border-[var(--color-border)]">
                            <h4 className="font-semibold text-sm mb-1 text-[var(--color-text-primary)]">Full Analysis</h4>
                            <p className="text-xs text-[var(--color-text-secondary)]">{pred.rationale}</p>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {filteredPredictions.length === 0 && (
          <div className="text-center py-12 text-[var(--color-text-secondary)]">
            No stocks match the selected filters
          </div>
        )}
      </div>
    </div>
  );
}
