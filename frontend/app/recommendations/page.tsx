'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl } from '../config';

function isMarketHours(): boolean {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day  = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  return day >= 1 && day <= 5 && mins >= 9 * 60 + 30 && mins < 16 * 60;
}

interface Recommendation {
  symbol: string;
  name: string;
  sector: string;
  currentPrice: string;
  totalScore: number;
  category: string;
  reason: string;
  priority: number;
  prediction: {
    signal: string;
    confidence: number;
    expectedMove: string;
    targetPrice: string;
  };
  riskAnalysis: {
    riskScore: number;
    riskLevel: string;
  };
  rewardRiskRatio: string;
}

interface PortfolioAction {
  action: 'SELL' | 'TRIM' | 'ADD' | 'HOLD';
  symbol: string;
  currentValue: number;
  reason: string;
  urgency: 'high' | 'medium' | 'low';
  suggestedAmount?: number;
  prediction: {
    signal: string;
    currentPrice: string;
  };
}

interface PortfolioAnalysis {
  totalValue: number;
  sectorExposure: Record<string, number>;
  riskScore: number;
  diversificationScore: number;
  holdingsCount: number;
}

interface RiskProfile {
  tolerance: string;
  currentExposure: number;
  recommendation: string;
}

interface RecommendationData {
  recommendations: Recommendation[];
  portfolioActions: PortfolioAction[];
  portfolioAnalysis: PortfolioAnalysis;
  riskProfile: RiskProfile;
  summary: {
    newOpportunities: number;
    portfolioAdjustments: {
      sells: number;
      trims: number;
      adds: number;
    };
    topCategories: string[];
    message: string;
  };
}

export default function RecommendationsPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<RecommendationData | null>(null);
  const [riskTolerance, setRiskTolerance] = useState<'conservative' | 'moderate' | 'aggressive'>('moderate');
  const [universe, setUniverse] = useState<'MEGA_CAP' | 'TOP_200' | 'ALL'>('TOP_200');
  const [activeTab, setActiveTab] = useState<'new' | 'portfolio'>('new');
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchRecommendations = useCallback(async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        router.push('/login');
        return;
      }

      const response = await fetch(
        `${getApiBaseUrl()}/api/recommendations?riskTolerance=${riskTolerance}&universe=${universe}&maxRecommendations=15`,
        {
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );

      if (response.status === 401) {
        router.push('/login');
        return;
      }

      const result = await response.json();
      setData(result);
    } catch (error) {
      console.error('Error fetching recommendations:', error);
    } finally {
      setLoading(false);
    }
  }, [riskTolerance, universe, router]);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations]);

  // Auto-refresh every 5 minutes during market hours so live PANTHEON scores surface
  useEffect(() => {
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    refreshTimerRef.current = setInterval(() => {
      if (isMarketHours()) fetchRecommendations();
    }, 5 * 60 * 1000);
    return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current); };
  }, [fetchRecommendations]);

  const getSignalColor = (signal: string) => {
    switch (signal) {
      case 'Strong Buy': return 'text-green-600 bg-green-50';
      case 'Buy': return 'text-blue-600 bg-blue-50';
      case 'Hold': return 'text-yellow-600 bg-yellow-50';
      case 'Avoid': return 'text-red-600 bg-red-50';
      default: return 'text-gray-600 bg-gray-50';
    }
  };

  const getActionColor = (action: string) => {
    switch (action) {
      case 'SELL': return 'text-red-600 bg-red-50';
      case 'TRIM': return 'text-orange-600 bg-orange-50';
      case 'ADD': return 'text-green-600 bg-green-50';
      case 'HOLD': return 'text-gray-600 bg-gray-50';
      default: return 'text-gray-600 bg-gray-50';
    }
  };

  const getUrgencyBadge = (urgency: string) => {
    switch (urgency) {
      case 'high': return '🔴';
      case 'medium': return '🟡';
      case 'low': return '🟢';
      default: return '⚪';
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center py-20">
            <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-indigo-600 mx-auto"></div>
            <p className="mt-4 text-gray-600">Analyzing portfolio and generating recommendations...</p>
            <p className="text-sm text-gray-500 mt-2">
              {universe === 'MEGA_CAP' && '⚡ Quick scan (50 stocks, ~20 seconds)'}
              {universe === 'TOP_200' && '📊 Balanced scan (200 stocks, ~90 seconds)'}
              {universe === 'ALL' && '🌐 Comprehensive scan (800+ stocks, ~4 minutes)'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
        <div className="max-w-7xl mx-auto text-center">
          <p className="text-gray-600">Unable to load recommendations</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 mb-2">
                🎯 Personalized Recommendations
              </h1>
              <p className="text-gray-600">{data.summary?.message || 'No recommendations available'}</p>
            </div>
            
            <div className="flex gap-4">
              {/* Risk Tolerance Selector */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Risk Profile
                </label>
                <select
                  value={riskTolerance}
                  onChange={(e) => setRiskTolerance(e.target.value as any)}
                  className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="conservative">🛡️ Conservative</option>
                  <option value="moderate">⚖️ Moderate</option>
                  <option value="aggressive">🚀 Aggressive</option>
                </select>
              </div>

              {/* Universe Selector */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Analysis Scope
                </label>
                <select
                  value={universe}
                  onChange={(e) => setUniverse(e.target.value as any)}
                  className="px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="MEGA_CAP">⚡ Quick (50 stocks)</option>
                  <option value="TOP_200">📊 Balanced (200 stocks)</option>
                  <option value="ALL">🌐 All (800+ stocks)</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        {/* Risk & Portfolio Summary */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div className="bg-gradient-to-br from-indigo-500 to-purple-600 rounded-xl shadow-lg p-6 text-white">
            <h3 className="text-lg font-semibold mb-2">Portfolio Health</h3>
            <div className="text-3xl font-bold mb-1">
              ${(data.portfolioAnalysis?.totalValue || 0).toLocaleString()}
            </div>
            <p className="text-sm opacity-90">
              {data.portfolioAnalysis?.holdingsCount || 0} positions
            </p>
            <div className="mt-4 pt-4 border-t border-white/20">
              <div className="flex justify-between text-sm">
                <span>Diversification</span>
                <span className="font-semibold">
                  {data.portfolioAnalysis?.diversificationScore?.toFixed(0) || 0}%
                </span>
              </div>
            </div>
          </div>

          <div className="bg-gradient-to-br from-blue-500 to-cyan-600 rounded-xl shadow-lg p-6 text-white">
            <h3 className="text-lg font-semibold mb-2">Risk Profile</h3>
            <div className="text-3xl font-bold mb-1">
              {data.riskProfile?.currentExposure?.toFixed(0) || 0}/100
            </div>
            <p className="text-sm opacity-90">
              {(data.riskProfile?.tolerance || 'moderate').charAt(0).toUpperCase() + (data.riskProfile?.tolerance || 'moderate').slice(1)} tolerance
            </p>
            <div className="mt-4 pt-4 border-t border-white/20">
              <p className="text-xs">{data.riskProfile?.recommendation || 'Loading...'}</p>
            </div>
          </div>

          <div className="bg-gradient-to-br from-green-500 to-emerald-600 rounded-xl shadow-lg p-6 text-white">
            <h3 className="text-lg font-semibold mb-2">Opportunities</h3>
            <div className="text-3xl font-bold mb-1">
              {data.summary?.newOpportunities || 0}
            </div>
            <p className="text-sm opacity-90">New stocks to consider</p>
            <div className="mt-4 pt-4 border-t border-white/20">
              <p className="text-xs">
                {data.summary?.portfolioAdjustments?.sells || 0} sells • {' '}
                {data.summary?.portfolioAdjustments?.trims || 0} trims • {' '}
                {data.summary?.portfolioAdjustments?.adds || 0} adds
              </p>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <div className="bg-white rounded-xl shadow-lg mb-6">
          <div className="border-b border-gray-200">
            <div className="flex">
              <button
                onClick={() => setActiveTab('new')}
                className={`px-6 py-3 font-semibold ${
                  activeTab === 'new'
                    ? 'border-b-2 border-indigo-600 text-indigo-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                🌟 New Opportunities ({data.recommendations.length})
              </button>
              <button
                onClick={() => setActiveTab('portfolio')}
                className={`px-6 py-3 font-semibold ${
                  activeTab === 'portfolio'
                    ? 'border-b-2 border-indigo-600 text-indigo-600'
                    : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                📊 Portfolio Actions ({data.portfolioActions.length})
              </button>
            </div>
          </div>
        </div>

        {/* New Opportunities Tab */}
        {activeTab === 'new' && (
          <div className="space-y-4">
            {data.recommendations.map((rec, index) => (
              <div key={rec.symbol} className="bg-white rounded-xl shadow-lg p-6 hover:shadow-xl transition-shadow">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-2xl font-bold text-gray-900">#{index + 1}</span>
                      <div>
                        <h3 className="text-xl font-bold text-gray-900">{rec.symbol}</h3>
                        <p className="text-sm text-gray-600">{rec.name}</p>
                      </div>
                      <span className="px-3 py-1 rounded-full text-sm font-semibold bg-purple-100 text-purple-700">
                        {rec.category}
                      </span>
                    </div>
                    
                    <p className="text-gray-700 mb-3">{rec.reason}</p>
                    
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
                      <div>
                        <p className="text-xs text-gray-500">Current Price</p>
                        <p className="font-semibold text-gray-900">${rec.currentPrice}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Target Price</p>
                        <p className="font-semibold text-green-600">${rec.prediction.targetPrice}</p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Expected Move</p>
                        <p className={`font-semibold ${
                          parseFloat(rec.prediction.expectedMove) > 0 ? 'text-green-600' : 'text-red-600'
                        }`}>
                          {parseFloat(rec.prediction.expectedMove) > 0 ? '+' : ''}
                          {rec.prediction.expectedMove}%
                        </p>
                      </div>
                      <div>
                        <p className="text-xs text-gray-500">Reward/Risk</p>
                        <p className="font-semibold text-blue-600">{rec.rewardRiskRatio}x</p>
                      </div>
                    </div>
                    
                    <div className="flex gap-2">
                      <span className={`px-3 py-1 rounded-full text-sm font-semibold ${getSignalColor(rec.prediction.signal)}`}>
                        {rec.prediction.signal}
                      </span>
                      <span className="px-3 py-1 rounded-full text-sm font-semibold bg-gray-100 text-gray-700">
                        {rec.prediction.confidence}% confidence
                      </span>
                      <span className="px-3 py-1 rounded-full text-sm font-semibold bg-blue-100 text-blue-700">
                        Score: {rec.totalScore}
                      </span>
                      <span className={`px-3 py-1 rounded-full text-sm font-semibold ${
                        rec.riskAnalysis.riskScore < 40 ? 'bg-green-100 text-green-700' :
                        rec.riskAnalysis.riskScore < 60 ? 'bg-yellow-100 text-yellow-700' :
                        'bg-red-100 text-red-700'
                      }`}>
                        Risk: {rec.riskAnalysis.riskScore}/100
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            
            {data.recommendations.length === 0 && (
              <div className="bg-white rounded-xl shadow-lg p-12 text-center">
                <p className="text-gray-600">No new opportunities match your risk profile at this time.</p>
                <p className="text-sm text-gray-500 mt-2">Try adjusting your risk tolerance or analysis scope.</p>
              </div>
            )}
          </div>
        )}

        {/* Portfolio Actions Tab */}
        {activeTab === 'portfolio' && (
          <div className="space-y-4">
            {data.portfolioActions.map((action) => (
              <div key={action.symbol} className="bg-white rounded-xl shadow-lg p-6 hover:shadow-xl transition-shadow">
                <div className="flex justify-between items-start">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-xl">{getUrgencyBadge(action.urgency)}</span>
                      <div>
                        <h3 className="text-xl font-bold text-gray-900">{action.symbol}</h3>
                        <p className="text-sm text-gray-600">
                          Current value: ${action.currentValue.toLocaleString()}
                        </p>
                      </div>
                      <span className={`px-3 py-1 rounded-full text-sm font-semibold ${getActionColor(action.action)}`}>
                        {action.action}
                      </span>
                      <span className="px-3 py-1 rounded-full text-sm font-semibold bg-gray-100 text-gray-700">
                        {action.urgency.toUpperCase()} urgency
                      </span>
                    </div>
                    
                    <p className="text-gray-700 mb-3">{action.reason}</p>
                    
                    {action.suggestedAmount && (
                      <p className="text-sm text-indigo-600 font-semibold">
                        💡 Suggested: {action.action === 'TRIM' ? 'Reduce by' : 'Add'}{' '}
                        {(action.suggestedAmount * 100).toFixed(0)}% 
                        (${(action.currentValue * action.suggestedAmount).toLocaleString()})
                      </p>
                    )}
                    
                    <div className="mt-3">
                      <span className={`px-3 py-1 rounded-full text-sm font-semibold ${getSignalColor(action.prediction.signal)}`}>
                        {action.prediction.signal}
                      </span>
                      <span className="ml-2 text-sm text-gray-600">
                        @ ${action.prediction.currentPrice}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
            
            {data.portfolioActions.length === 0 && (
              <div className="bg-white rounded-xl shadow-lg p-12 text-center">
                <p className="text-gray-600">✅ Your portfolio looks great!</p>
                <p className="text-sm text-gray-500 mt-2">No immediate actions needed at this time.</p>
              </div>
            )}
          </div>
        )}

        {/* Sector Exposure Chart */}
        {(data.portfolioAnalysis?.holdingsCount || 0) > 0 && (
          <div className="bg-white rounded-xl shadow-lg p-6 mt-6">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Sector Exposure</h3>
            <div className="space-y-3">
              {Object.entries(data.portfolioAnalysis?.sectorExposure || {})
                .sort((a, b) => b[1] - a[1])
                .map(([sector, percentage]) => (
                  <div key={sector}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-gray-700 font-medium">{sector}</span>
                      <span className="text-gray-900 font-semibold">{percentage.toFixed(1)}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-indigo-600 h-2 rounded-full transition-all"
                        style={{ width: `${percentage}%` }}
                      ></div>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
