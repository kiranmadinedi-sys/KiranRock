
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

  useEffect(() => {
    fetchBacktestReport();
  }, []);

  const fetchBacktestReport = async () => {
    try {
      setLoading(true);
      const token = localStorage.getItem('token');
  const response = fetch(`${getApiBaseUrl()}/api/backtest/report`, {
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

  if (error || !report) {
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

  // Safety check for equity curve data
  const equityCurveData = report.equityCurve && Array.isArray(report.equityCurve) ? report.equityCurve : [];
  
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

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false
      },
      tooltip: {
        callbacks: {
          label: (context: any) => `Equity: $${context.parsed.y.toFixed(2)}`
        }
      }
    },
    scales: {
      y: {
        beginAtZero: false,
        ticks: {
          callback: (value: any) => '$' + value.toFixed(0)
        }
      }
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900 pb-20 lg:pb-8">
      <AppHeader showSearch={false} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8 pt-6">
        {/* Performance Metrics Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
            <p className="text-sm text-gray-600 dark:text-gray-400">Win Rate</p>
            <p className={`text-3xl font-bold ${parseFloat(report.metrics.winRate) >= 50 ? 'text-green-600' : 'text-red-600'}`}>
              {report.metrics.winRate}%
            </p>
            <p className="text-xs text-gray-500 mt-2">
              {report.metrics.wins}W / {report.metrics.losses}L
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
            <p className="text-sm text-gray-600 dark:text-gray-400">Net Profit/Loss</p>
            <p className={`text-3xl font-bold ${parseFloat(report.metrics.totalProfitLoss) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              ${report.metrics.totalProfitLoss}
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Total: {report.metrics.totalTrades} completed trades
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
            <p className="text-sm text-gray-600 dark:text-gray-400">Profit Factor</p>
            <p className={`text-3xl font-bold ${parseFloat(report.metrics.profitFactor) >= 1.5 ? 'text-green-600' : 'text-yellow-600'}`}>
              {report.metrics.profitFactor}
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Avg Win: ${report.metrics.avgWin}
            </p>
          </div>

          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
            <p className="text-sm text-gray-600 dark:text-gray-400">Sharpe Ratio</p>
            <p className={`text-3xl font-bold ${parseFloat(report.metrics.sharpeRatio) >= 1 ? 'text-green-600' : 'text-yellow-600'}`}>
              {report.metrics.sharpeRatio}
            </p>
            <p className="text-xs text-gray-500 mt-2">
              Max DD: {report.metrics.maxDrawdown}%
            </p>
          </div>
        </div>

        {/* Equity Curve */}
        <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow mb-8">
          <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">Equity Curve</h2>
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

        {/* Best and Worst Trades */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4 text-green-600">Best Trades</h2>
            <div className="space-y-3">
              {(report.bestTrades && report.bestTrades.length > 0) ? (
                report.bestTrades.map((trade, index) => (
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
              {(report.worstTrades && report.worstTrades.length > 0) ? (
                report.worstTrades.map((trade, index) => (
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
      </div>
    </div>
  );
}
