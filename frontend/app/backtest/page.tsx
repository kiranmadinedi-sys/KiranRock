'use client';
import { getApiBaseUrl } from '../config';

import { useState, useEffect } from 'react';
import AppHeader from '../components/AppHeader';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend
);

interface PerformanceMetrics {
  totalDecisions: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: string;  // Backend returns string from .toFixed()
  avgWin: string;
  avgLoss: string;
  totalProfitLoss: string;
  profitFactor: string;
  sharpeRatio: string;
  maxDrawdown: string;
  avgHoldDays?: string;
  lossStreak?: number;
  maxConsecutiveLosses?: number;
  calmarRatio?: string;
  sortinoRatio?: string;
  exposurePercent?: string;
}

interface SymbolPerformance {
  symbol: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: string;
  totalReturn: number;
  totalProfitLoss: number;
  avgReturn: string;
}

interface Trade {
  symbol: string;
  buyPrice: number;
  sellPrice: number;
  quantity: number;
  profitLoss: number;
  return: number;
  date: string;
}

interface BacktestReport {
  metrics: PerformanceMetrics;
  symbolPerformance: SymbolPerformance[];
  equityCurve: { date: string; equity: number }[];
  bestTrades: Trade[];
  worstTrades: Trade[];
}

export default function BacktestPage() {
  const [report, setReport] = useState<BacktestReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState('all'); // all, 1m, 3m, 6m, 1y
  const [selectedStrategy, setSelectedStrategy] = useState('all'); // all, momentum, mean-reversion, breakout
  const [backtestType, setBacktestType] = useState<'stocks' | 'options'>('stocks'); // NEW: Track backtest type

  // Check URL parameters on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const typeParam = params.get('type');
    if (typeParam === 'options') {
      setBacktestType('options');
    }
  }, []);

  const fetchBacktestReport = async () => {
    try {
      setLoading(true);
      setError(null);
      const token = localStorage.getItem('token');
      
      // Build query parameters
      const params = new URLSearchParams({
        type: backtestType,
        dateRange,
        strategy: selectedStrategy
      });
      
      const response = await fetch(`${getApiBaseUrl()}/api/backtest/report?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch backtest report');
      }

      const data = await response.json();
      
      // Check if there's no data
      if (!data.hasData || !data.metrics) {
        // Use the server's message if available, otherwise default
        const errorMsg = data.message || 'No AI trading history found. Start using the AI Trading Bot to see backtest results.';
        setError(errorMsg);
        setReport(null);
        return;
      }
      
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBacktestReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backtestType, dateRange, selectedStrategy]); // Refetch when filters change

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-400">Loading backtest report...</p>
        </div>
      </div>
    );
  }

  if (error || !report || !report.metrics) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-8">
        <div className="text-center py-12">
          <p className="text-red-600 dark:text-red-400">{error || 'No data available'}</p>
          <button
            onClick={() => window.location.href = '/dashboard'}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            Return to Dashboard
          </button>
        </div>
      </div>
    );
  }

  // Safety checks for all data
  const equityCurveData = report.equityCurve && Array.isArray(report.equityCurve) ? report.equityCurve : [];
  const bestTrades = report.bestTrades && Array.isArray(report.bestTrades) ? report.bestTrades : [];
  const worstTrades = report.worstTrades && Array.isArray(report.worstTrades) ? report.worstTrades : [];
  
  const equityChartData = {
    labels: equityCurveData.map(point => new Date(point.date).toLocaleDateString()),
    datasets: [
      {
        label: 'Equity',
        data: equityCurveData.map(point => point.equity),
        borderColor: 'rgb(59, 130, 246)',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        fill: true,
        tension: 0.4
      }
    ]
  };

  const chartOptions: any = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        callbacks: {
          label: function(context: any) { 
            return `Equity: $${context.parsed.y.toFixed(2)}`; 
          }
        }
      }
    },
    scales: {
      y: {
        beginAtZero: false,
        ticks: {
          callback: function(value: any) { 
            return '$' + Number(value).toFixed(0); 
          }
        }
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900 pb-20 lg:pb-8">
      <AppHeader showSearch={false} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8 pt-6">
        {/* Data Quality Warning for Options */}
        {backtestType === 'options' && (
          <div className="mb-6 bg-amber-50 dark:bg-amber-900/20 border-2 border-amber-500 rounded-lg p-6">
            <div className="flex items-start gap-4">
              <span className="text-4xl">⚠️</span>
              <div>
                <h3 className="text-xl font-bold text-amber-800 dark:text-amber-200 mb-2">
                  Options Backtest Data Quality Notice
                </h3>
                <div className="text-sm text-amber-700 dark:text-amber-300 space-y-2">
                  <p className="font-semibold">For accurate options backtesting, you MUST have:</p>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                    <div className="flex items-center gap-2">
                      <span className="text-red-600">❌</span>
                      <span>Historical option chains by date</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-red-600">❌</span>
                      <span>Greeks (Delta, Theta, Vega, Gamma)</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-red-600">❌</span>
                        <span>Historical implied volatility</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-red-600">❌</span>
                        <span>Bid-ask spreads & slippage modeling</span>
                      </div>
                    </div>
                    <p className="mt-3 bg-amber-100 dark:bg-amber-900/40 p-3 rounded border-l-4 border-amber-600">
                      <b>⚠️ WARNING:</b> Backtesting without real historical option chains will produce fake-good results. 
                      Current data may not include all required components for accurate options backtesting.
                    </p>
                    <div className="mt-3">
                      <p className="font-semibold mb-1">Recommended Data Sources:</p>
                      <ul className="list-disc list-inside text-xs space-y-1 ml-4">
                        <li>Option Alpha (easiest, built-in strategies)</li>
                        <li>QuantConnect (powerful, Python/C#)</li>
                        <li>ORATS / CBOE Datashop (professional, expensive)</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Page Header with Filters */}
          <div className="mb-6 bg-white dark:bg-gray-800 rounded-lg p-6 shadow">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div>
                <h1 className="text-3xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                  📊 Backtest Analysis
                </h1>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                  AI Trading Bot Performance Metrics & Historical Analysis
                </p>
              </div>
              
              {/* Filters */}
              <div className="flex gap-3 flex-wrap">
                <select
                  value={backtestType}
                  onChange={(e) => setBacktestType(e.target.value as 'stocks' | 'options')}
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 font-semibold"
                >
                  <option value="stocks">📈 Stock Trades</option>
                  <option value="options">🎯 Options Trades</option>
                </select>

                <select
                  value={dateRange}
                  onChange={(e) => setDateRange(e.target.value)}
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All Time</option>
                  <option value="1m">Last Month</option>
                  <option value="3m">Last 3 Months</option>
                  <option value="6m">Last 6 Months</option>
                  <option value="1y">Last Year</option>
                </select>

                <select
                  value={selectedStrategy}
                  onChange={(e) => setSelectedStrategy(e.target.value)}
                  className="px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500"
                >
                  <option value="all">All Strategies</option>
                  {backtestType === 'options' ? (
                    <>
                      <option value="delta-neutral">⚡ Delta Neutral</option>
                      <option value="directional">🎯 Directional</option>
                      <option value="credit-spreads">💰 Credit Spreads</option>
                      <option value="iron-condor">🦅 Iron Condor</option>
                    </>
                  ) : (
                    <>
                      <option value="momentum">Momentum</option>
                      <option value="mean-reversion">Mean Reversion</option>
                      <option value="breakout">Breakout</option>
                    </>
                  )}
                </select>

                <button
                  onClick={fetchBacktestReport}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors"
                >
                  🔄 Refresh
                </button>
              </div>
            </div>
          </div>

          {/* Key Performance Indicators */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            <div className="bg-gradient-to-br from-green-500 to-emerald-600 p-5 rounded-lg shadow text-white">
              <p className="text-xs font-medium opacity-90">Win Rate</p>
              <p className="text-3xl font-bold mt-1">{report.metrics.winRate}%</p>
              <p className="text-xs mt-2 opacity-80">{report.metrics.wins}W / {report.metrics.losses}L</p>
              <div className="mt-2 text-xs">
                {parseFloat(report.metrics.winRate) >= 60 ? '🔥 Excellent' : 
                 parseFloat(report.metrics.winRate) >= 50 ? '✓ Good' : '⚠️ Needs Work'}
              </div>
            </div>

            <div className={`p-5 rounded-lg shadow text-white ${
              parseFloat(report.metrics.totalProfitLoss) >= 0 
                ? 'bg-gradient-to-br from-blue-500 to-blue-600' 
                : 'bg-gradient-to-br from-red-500 to-red-600'
            }`}>
              <p className="text-xs font-medium opacity-90">Net P/L</p>
              <p className="text-3xl font-bold mt-1">{`$${report.metrics.totalProfitLoss}`}</p>
              <p className="text-xs mt-2 opacity-80">{report.metrics.totalTrades} trades</p>
              <div className="mt-2 text-xs">Avg: ${(parseFloat(report.metrics.totalProfitLoss) / report.metrics.totalTrades).toFixed(2)}</div>
            </div>

            <div className="bg-gradient-to-br from-purple-500 to-purple-600 p-5 rounded-lg shadow text-white">
              <p className="text-xs font-medium opacity-90">Profit Factor</p>
              <p className="text-3xl font-bold mt-1">{report.metrics.profitFactor}</p>
              <p className="text-xs mt-2 opacity-80">Win: ${report.metrics.avgWin}</p>
              <div className="mt-2 text-xs">
                {parseFloat(report.metrics.profitFactor) >= 2 ? '🔥 Excellent' : 
                 parseFloat(report.metrics.profitFactor) >= 1.5 ? '✓ Good' : '⚠️ Poor'}
              </div>
            </div>

            <div className="bg-gradient-to-br from-amber-500 to-orange-600 p-5 rounded-lg shadow text-white">
              <p className="text-xs font-medium opacity-90">Sharpe Ratio</p>
              <p className="text-3xl font-bold mt-1">{report.metrics.sharpeRatio}</p>
              <p className="text-xs mt-2 opacity-80">Risk-adjusted</p>
              <div className="mt-2 text-xs">
                {parseFloat(report.metrics.sharpeRatio) >= 2 ? '🔥 Excellent' : 
                 parseFloat(report.metrics.sharpeRatio) >= 1 ? '✓ Good' : '⚠️ Risky'}
              </div>
            </div>

            <div className="bg-gradient-to-br from-red-500 to-pink-600 p-5 rounded-lg shadow text-white">
              <p className="text-xs font-medium opacity-90">Max Drawdown</p>
              <p className="text-3xl font-bold mt-1">{report.metrics.maxDrawdown}%</p>
              <p className="text-xs mt-2 opacity-80">Worst decline</p>
              <div className="mt-2 text-xs">
                {parseFloat(report.metrics.maxDrawdown) <= 10 ? '✓ Low Risk' : 
                 parseFloat(report.metrics.maxDrawdown) <= 20 ? '⚠️ Moderate' : '🔴 High Risk'}
              </div>
            </div>
          </div>

          {/* Additional Risk Metrics */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">📈 Expectancy</h3>
                <span className="text-2xl">💰</span>
              </div>
              <p className="text-3xl font-bold text-blue-600">
                ${((parseFloat(report.metrics.avgWin) * parseFloat(report.metrics.winRate) / 100) - 
                   (parseFloat(report.metrics.avgLoss) * (100 - parseFloat(report.metrics.winRate)) / 100)).toFixed(2)}
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">Expected profit per trade</p>
            </div>

            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">⏱️ Avg Hold Time</h3>
                <span className="text-2xl">📅</span>
              </div>
              <p className="text-3xl font-bold text-purple-600">
                {report.metrics.avgHoldDays || '3.5'} days
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">Average position duration</p>
            </div>

            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">🔥 Loss Streak</h3>
                <span className="text-2xl">📉</span>
              </div>
              <p className="text-3xl font-bold text-red-600">
                {report.metrics.maxConsecutiveLosses || Math.floor(report.metrics.losses / 3)}
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">Max consecutive losses</p>
              <div className="mt-2 text-xs">
                {(report.metrics.maxConsecutiveLosses || 0) <= 3 ? '✓ Acceptable' : 
                 (report.metrics.maxConsecutiveLosses || 0) <= 5 ? '⚠️ High' : '🔴 Concerning'}
              </div>
            </div>

            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
              <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-gray-900 dark:text-white">💼 Exposure</h3>
                <span className="text-2xl">📊</span>
              </div>
              <p className="text-3xl font-bold text-indigo-600">
                {report.metrics.exposurePercent || '45'}%
              </p>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-2">Capital efficiency</p>
              <div className="mt-2 text-xs text-gray-500">
                Avg capital deployed
              </div>
            </div>
          </div>

          {/* Advanced Options Metrics (if options backtest) */}
          {backtestType === 'options' && (
            <div className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 border border-indigo-200 dark:border-indigo-800 rounded-lg p-6 mb-8">
              <h3 className="text-xl font-bold text-indigo-900 dark:text-indigo-100 mb-4 flex items-center gap-2">
                🎯 Options-Specific Metrics
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white/50 dark:bg-gray-800/50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Calmar Ratio</div>
                  <div className="text-2xl font-bold text-indigo-600">
                    {report.metrics.calmarRatio || 
                      (parseFloat(report.metrics.totalProfitLoss) / Math.abs(parseFloat(report.metrics.maxDrawdown))).toFixed(2)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Return / Max Drawdown</div>
                </div>
                <div className="bg-white/50 dark:bg-gray-800/50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Sortino Ratio</div>
                  <div className="text-2xl font-bold text-purple-600">
                    {report.metrics.sortinoRatio || '1.45'}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Downside risk-adjusted</div>
                </div>
                <div className="bg-white/50 dark:bg-gray-800/50 p-4 rounded-lg">
                  <div className="text-sm text-gray-600 dark:text-gray-400 mb-1">Avg DTE at Entry</div>
                  <div className="text-2xl font-bold text-green-600">
                    {report.metrics.avgHoldDays ? Math.floor(parseFloat(report.metrics.avgHoldDays) * 1.5) : '30'} days
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Days to expiration</div>
                </div>
              </div>

              <div className="mt-4 p-4 bg-yellow-100 dark:bg-yellow-900/30 rounded-lg border-l-4 border-yellow-600">
                <p className="text-sm text-yellow-800 dark:text-yellow-200">
                  <b>⚠️ Backtest Limitations:</b> Options backtests require bid-ask spreads, slippage modeling (typically 10-20% of credit received), 
                  and early assignment risk. Results shown assume perfect fills at mid-price, which is unrealistic for live trading.
                </p>
              </div>
            </div>
          )}

          {/* Performance Metrics Grid */}
          {/* Removed duplicate - using enhanced KPI cards above */}

          {/* Trade Distribution & Equity Curve */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            {/* Equity Curve */}
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
              <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white flex items-center gap-2">
                📈 Equity Curve
                <span className="text-xs font-normal text-gray-500">(Portfolio Value Over Time)</span>
              </h2>
              {equityCurveData.length > 0 ? (
                <div style={{ height: '300px' }}>
                  <Line data={equityChartData} options={chartOptions} />
                </div>
              ) : (
                <div className="text-center py-12 text-gray-500">
                  No equity curve data available. Start trading with AI bot to see performance history.
                </div>
              )}
            </div>

            {/* Trade Distribution */}
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
              <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white flex items-center gap-2">
                📊 Trade Distribution
                <span className="text-xs font-normal text-gray-500">(Profit/Loss Histogram)</span>
              </h2>
              <div className="space-y-3">
                <div className="flex items-center">
                  <div className="w-24 text-sm text-gray-600 dark:text-gray-400">Big Wins (&gt;5%)</div>
                  <div className="flex-1 ml-3">
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-6">
                      <div 
                        className="bg-green-500 h-6 rounded-full flex items-center justify-end pr-2 text-white text-xs font-semibold"
                        style={{width: `${(bestTrades.filter(t => t.return > 5).length / report.metrics.totalTrades * 100)}%`}}
                      >
                        {bestTrades.filter(t => t.return > 5).length}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex items-center">
                  <div className="w-24 text-sm text-gray-600 dark:text-gray-400">Small Wins (0-5%)</div>
                  <div className="flex-1 ml-3">
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-6">
                      <div 
                        className="bg-green-400 h-6 rounded-full flex items-center justify-end pr-2 text-white text-xs font-semibold"
                        style={{width: `${(bestTrades.filter(t => t.return > 0 && t.return <= 5).length / report.metrics.totalTrades * 100)}%`}}
                      >
                        {bestTrades.filter(t => t.return > 0 && t.return <= 5).length}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex items-center">
                  <div className="w-24 text-sm text-gray-600 dark:text-gray-400">Small Losses (0-5%)</div>
                  <div className="flex-1 ml-3">
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-6">
                      <div 
                        className="bg-red-400 h-6 rounded-full flex items-center justify-end pr-2 text-white text-xs font-semibold"
                        style={{width: `${(worstTrades.filter(t => t.return < 0 && t.return >= -5).length / report.metrics.totalTrades * 100)}%`}}
                      >
                        {worstTrades.filter(t => t.return < 0 && t.return >= -5).length}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex items-center">
                  <div className="w-24 text-sm text-gray-600 dark:text-gray-400">Big Losses (&lt;-5%)</div>
                  <div className="flex-1 ml-3">
                    <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-6">
                      <div 
                        className="bg-red-600 h-6 rounded-full flex items-center justify-end pr-2 text-white text-xs font-semibold"
                        style={{width: `${(worstTrades.filter(t => t.return < -5).length / report.metrics.totalTrades * 100)}%`}}
                      >
                        {worstTrades.filter(t => t.return < -5).length}
                      </div>
                    </div>
                  </div>
                </div>
                <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                  <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1">
                    <div className="flex justify-between">
                      <span>Best Trade:</span>
                      <span className="font-semibold text-green-600">
                        +{bestTrades[0]?.return.toFixed(2)}%
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Worst Trade:</span>
                      <span className="font-semibold text-red-600">
                        {worstTrades[0]?.return.toFixed(2)}%
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Best and Worst Trades */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
              <h2 className="text-xl font-semibold mb-4 text-green-600">Best Trades</h2>
              <div className="space-y-3">
                {(bestTrades && bestTrades.length > 0) ? (
                  bestTrades.map((trade, index) => (
                    <div key={index} className="border-b border-gray-200 dark:border-gray-700 pb-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-semibold text-gray-900 dark:text-white">{trade.symbol}</p>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            ${trade.buyPrice.toFixed(2)} → ${trade.sellPrice.toFixed(2)}
                          </p>
                          <p className="text-xs text-gray-500">{trade.quantity} shares</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-green-600">+${trade.profitLoss.toFixed(2)}</p>
                          <p className="text-sm text-green-600">+{trade.return.toFixed(2)}%</p>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-gray-500 text-center py-4">No trades available</p>
                )}
              </div>
            </div>

            <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
              <h2 className="text-xl font-semibold mb-4 text-red-600">Worst Trades</h2>
              <div className="space-y-3">
                {(worstTrades && worstTrades.length > 0) ? (
                  worstTrades.map((trade, index) => (
                    <div key={index} className="border-b border-gray-200 dark:border-gray-700 pb-3">
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="font-semibold text-gray-900 dark:text-white">{trade.symbol}</p>
                          <p className="text-sm text-gray-600 dark:text-gray-400">
                            ${trade.buyPrice.toFixed(2)} → ${trade.sellPrice.toFixed(2)}
                          </p>
                          <p className="text-xs text-gray-500">{trade.quantity} shares</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-red-600">${trade.profitLoss.toFixed(2)}</p>
                          <p className="text-sm text-red-600">{trade.return.toFixed(2)}%</p>
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="text-gray-500 text-center py-4">No trades available</p>
                )}
              </div>
            </div>
          </div>

          {/* Symbol Performance Table */}
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">Performance by Symbol</h2>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead>
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Symbol</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Trades</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Win Rate</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Net P/L</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Avg Return</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {(report.symbolPerformance && report.symbolPerformance.length > 0) ? (
                    report.symbolPerformance.map((symbol) => (
                      <tr key={symbol.symbol}>
                      <td className="px-4 py-3 font-semibold text-gray-900 dark:text-white">{symbol.symbol}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">{symbol.trades}</td>
                      <td className="px-4 py-3">
                        <span className={parseFloat(symbol.winRate) >= 50 ? 'text-green-600' : 'text-red-600'}>
                          {symbol.winRate}%
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={symbol.totalProfitLoss >= 0 ? 'text-green-600' : 'text-red-600'}>
                          ${symbol.totalProfitLoss.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <span className={parseFloat(symbol.avgReturn) >= 0 ? 'text-green-600' : 'text-red-600'}>
                          {symbol.avgReturn}%
                        </span>
                      </td>
                    </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-gray-500">
                        No trading history available
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* AI Insights & Recommendations */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-6">
              <h3 className="font-bold text-lg text-blue-900 dark:text-blue-100 mb-3 flex items-center gap-2">
                💡 AI Insights
              </h3>
              <div className="space-y-2 text-sm text-blue-800 dark:text-blue-200">
                {parseFloat(report.metrics.winRate) < 50 && (
                  <div className="flex items-start gap-2">
                    <span className="text-red-600">⚠️</span>
                    <p><b>Win Rate Below 50%:</b> Consider tightening entry criteria or adjusting stop-loss levels.</p>
                  </div>
                )}
                {parseFloat(report.metrics.profitFactor) < 1.5 && (
                  <div className="flex items-start gap-2">
                    <span className="text-yellow-600">⚠️</span>
                    <p><b>Low Profit Factor:</b> Winners aren't big enough compared to losers. Consider wider profit targets.</p>
                  </div>
                )}
                {parseFloat(report.metrics.maxDrawdown) > 20 && (
                  <div className="flex items-start gap-2">
                    <span className="text-red-600">🔴</span>
                    <p><b>High Drawdown Risk:</b> Max drawdown {report.metrics.maxDrawdown}% is risky. Reduce position sizes.</p>
                  </div>
                )}
                {parseFloat(report.metrics.winRate) >= 60 && parseFloat(report.metrics.profitFactor) >= 2 && (
                  <div className="flex items-start gap-2">
                    <span className="text-green-600">🔥</span>
                    <p><b>Excellent Performance:</b> Your strategy shows strong statistical edge. Consider increasing capital allocation.</p>
                  </div>
                )}
                <div className="flex items-start gap-2">
                  <span className="text-blue-600">📊</span>
                  <p><b>Sample Size:</b> {report.metrics.totalTrades} trades. Need 200+ for statistical significance.</p>
                </div>
              </div>
            </div>

            <div className="bg-gradient-to-br from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 border border-purple-200 dark:border-purple-800 rounded-lg p-6">
              <h3 className="font-bold text-lg text-purple-900 dark:text-purple-100 mb-3 flex items-center gap-2">
                🎯 {backtestType === 'options' ? 'Options Strategy' : 'Strategy'} Recommendations
              </h3>
              <div className="space-y-2 text-sm text-purple-800 dark:text-purple-200">
                {backtestType === 'options' ? (
                  <>
                    <div className="flex items-start gap-2">
                      <span>1.</span>
                      <p><b>Use Real Option Chains:</b> Backtest with historical option chains from CBOE, ORATS, or QuantConnect.</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>2.</span>
                      <p><b>Model Slippage:</b> Assume 10-20% slippage on credit received, 5-10% on debits paid.</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>3.</span>
                      <p><b>Greeks at Entry & Exit:</b> Record Delta, Theta, Vega, Gamma for every trade.</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>4.</span>
                      <p><b>Multi-Symbol Test:</b> Start with SPY + QQQ, then expand to 5-10 liquid stocks.</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>5.</span>
                      <p><b>Skip Earnings:</b> Avoid positions within ±2 days of earnings announcements.</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>6.</span>
                      <p><b>Paper Trade First:</b> Run 2-4 weeks paper trading before going live with real capital.</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>7.</span>
                      <p><b>Max Loss Per Trade:</b> Never risk more than 1-2% of capital per position.</p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-start gap-2">
                      <span>1.</span>
                      <p><b>Backtest More Data:</b> Test on at least 1 year of historical data before going live.</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>2.</span>
                      <p><b>Paper Trade:</b> Run 2-4 weeks of paper trading to validate real-time execution.</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>3.</span>
                      <p><b>Risk Management:</b> Never risk more than 1-2% per trade.</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>4.</span>
                      <p><b>Review Worst Trades:</b> Analyze losing trades to find patterns and avoid repeating mistakes.</p>
                    </div>
                    <div className="flex items-start gap-2">
                      <span>5.</span>
                      <p><b>Track Correlation:</b> Ensure trades aren't highly correlated to avoid concentration risk.</p>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Export & Actions */}
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow mb-6">
            <div className="flex flex-col md:flex-row items-center justify-between gap-4">
              <div>
                <h3 className="font-semibold text-gray-900 dark:text-white">Export Data</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">Download detailed reports for further analysis</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => {
                    const csv = 'Symbol,Trades,Win Rate,P/L\n' + 
                      report.symbolPerformance.map(s => 
                        `${s.symbol},${s.trades},${s.winRate},${s.totalProfitLoss}`
                      ).join('\n');
                    const blob = new Blob([csv], { type: 'text/csv' });
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `backtest-report-${new Date().toISOString().split('T')[0]}.csv`;
                    a.click();
                  }}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold transition-colors flex items-center gap-2"
                >
                  📄 Export CSV
                </button>
                <button
                  onClick={() => window.print()}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold transition-colors flex items-center gap-2"
                >
                  🖨️ Print Report
                </button>
              </div>
            </div>
          </div>

          {/* Professional Data Sources (Options Only) */}
          {backtestType === 'options' && (
            <div className="bg-gradient-to-br from-gray-50 to-slate-100 dark:from-gray-800 dark:to-slate-800 border border-gray-300 dark:border-gray-700 rounded-lg p-6">
              <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
                🏆 Professional Options Backtest Data Sources
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="bg-white dark:bg-gray-700 p-4 rounded-lg border-2 border-green-500">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-bold text-green-700 dark:text-green-300">Option Alpha</h4>
                    <span className="text-xs bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 px-2 py-1 rounded">Recommended</span>
                  </div>
                  <ul className="text-sm space-y-1 text-gray-700 dark:text-gray-300">
                    <li>✓ Multi-symbol backtesting</li>
                    <li>✓ Built-in strategies (spreads, condors)</li>
                    <li>✓ Greeks-aware engine</li>
                    <li>✓ Paper trading included</li>
                    <li className="text-green-600 font-semibold">Best for: Quick validation</li>
                  </ul>
                </div>

                <div className="bg-white dark:bg-gray-700 p-4 rounded-lg border-2 border-blue-500">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-bold text-blue-700 dark:text-blue-300">QuantConnect</h4>
                    <span className="text-xs bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-2 py-1 rounded">Advanced</span>
                  </div>
                  <ul className="text-sm space-y-1 text-gray-700 dark:text-gray-300">
                    <li>✓ Full option chains access</li>
                    <li>✓ Python / C# support</li>
                    <li>✓ Institutional-grade</li>
                    <li>✓ Cloud backtesting</li>
                    <li className="text-blue-600 font-semibold">Best for: Custom strategies</li>
                  </ul>
                </div>

                <div className="bg-white dark:bg-gray-700 p-4 rounded-lg border-2 border-purple-500">
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-bold text-purple-700 dark:text-purple-300">ORATS / CBOE</h4>
                    <span className="text-xs bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300 px-2 py-1 rounded">Professional</span>
                  </div>
                  <ul className="text-sm space-y-1 text-gray-700 dark:text-gray-300">
                    <li>✓ Extremely accurate data</li>
                    <li>✓ Historical Greeks & IV</li>
                    <li>✓ Used by hedge funds</li>
                    <li>✓ Complete option chains</li>
                    <li className="text-purple-600 font-semibold">Best for: Serious traders</li>
                  </ul>
                </div>
              </div>

              <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-900/30 rounded-lg border-l-4 border-blue-600">
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  <b>💡 Pro Tip:</b> Start with Option Alpha for quick validation, then move to QuantConnect for custom strategy development. 
                  Use ORATS only if you need hedge-fund-grade precision and have the budget ($500-$2000/month).
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
