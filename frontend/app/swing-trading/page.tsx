
'use client';
import { getApiBaseUrl } from '../config';

import { useState } from 'react';
import AppHeader from '../components/AppHeader';

interface EMAAnalysis {
  signal: string;
  reason: string;
  currentPrice: number;
  ema9: number;
  distance: string;
}

interface PatternDetails {
  leftRimPrice: number;
  cupBottomPrice: number;
  cupDepth: string;
  rightRimPrice: number;
  rimSymmetry: string;
  handleLow: number;
  handleDepth: string;
  volumeDecrease: string;
  breakoutPrice: number;
  currentPrice: number;
  distanceFromBreakout: string;
  avgCupVolume: number;
  avgHandleVolume: number;
}

interface CupAndHandleAnalysis {
  detected: boolean;
  confidence: number;
  signal: string;
  reason: string;
  patternDetails?: PatternDetails;
}

interface SwingAnalysis {
  symbol: string;
  timestamp: string;
  overallSignal: string;
  reasons: string[];
  emaAnalysis: EMAAnalysis;
  cupAndHandleAnalysis: CupAndHandleAnalysis;
  recommendedHoldingPeriod: string;
  strategy: string;
}

export default function SwingTradingPage() {
  const [symbol, setSymbol] = useState('');
  const [analysis, setAnalysis] = useState<SwingAnalysis | null>(null);
  const [scanInput, setScanInput] = useState('');
  const [scanResults, setScanResults] = useState<SwingAnalysis[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyzeSymbol = async () => {
    if (!symbol.trim()) {
      setError('Please enter a symbol');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      setAnalysis(null); // Clear previous analysis
      const token = localStorage.getItem('token');
      const apiUrl = getApiBaseUrl();
      
      console.log(`Analyzing ${symbol.toUpperCase()}...`);
      
      const response = await fetch(
  `${apiUrl}/api/swing-trading/analysis/${symbol.toUpperCase()}`,
        {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Failed to fetch analysis' }));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      console.log('Analysis result:', data);
      setAnalysis(data);
    } catch (err) {
      console.error('Analysis error:', err);
      setError(err instanceof Error ? err.message : 'Analysis failed');
      setAnalysis(null);
    } finally {
      setLoading(false);
    }
  };

  const scanSymbols = async () => {
    if (!scanInput.trim()) {
      setError('Please enter symbols to scan');
      return;
    }

    try {
      setLoading(true);
      setError(null);
      const symbols = scanInput.split(',').map(s => s.trim().toUpperCase()).filter(s => s);
      const token = localStorage.getItem('token');
      
  const response = fetch(`${getApiBaseUrl()}/api/swing-trading/scan`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ symbols })
      });

      if (!response.ok) {
        throw new Error('Failed to scan symbols');
      }

      const data = await response.json();
      setScanResults(data.opportunities || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setLoading(false);
    }
  };

  const getSignalBadgeColor = (signal: string) => {
    switch (signal) {
      case 'STRONG BUY': return 'bg-green-600 text-white';
      case 'BUY': return 'bg-green-500 text-white';
      case 'WATCH': return 'bg-yellow-500 text-white';
      case 'HOLD': return 'bg-blue-500 text-white';
      case 'SELL': return 'bg-red-500 text-white';
      default: return 'bg-gray-500 text-white';
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900">
      <AppHeader showSearch={false} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-8">
        {error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-6">
            {error}
          </div>
        )}

        {/* Single Symbol Analysis */}
        <div className="bg-white dark:bg-gray-800 p-3 sm:p-4 rounded-lg shadow mb-3 sm:mb-4">
          <h2 className="text-lg sm:text-xl font-semibold mb-3 sm:mb-4 text-gray-900 dark:text-white">
            Analyze Single Symbol
          </h2>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              onKeyPress={(e) => {
                if (e.key === 'Enter') {
                  analyzeSymbol();
                }
              }}
              placeholder="Enter symbol (e.g., AAPL)"
              className="flex-1 px-3 sm:px-4 py-2 text-sm sm:text-base border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
            <button
              onClick={analyzeSymbol}
              disabled={loading}
              className="px-4 sm:px-6 py-2 text-sm sm:text-base bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
            >
              {loading ? 'Analyzing...' : 'Analyze'}
            </button>
          </div>
        </div>

        {/* Analysis Results */}
        {analysis && (
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow mb-8">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white">{analysis.symbol}</h2>
                <p className="text-sm text-gray-500">{new Date(analysis.timestamp).toLocaleString()}</p>
              </div>
              <span className={`px-4 py-2 rounded-lg font-bold ${getSignalBadgeColor(analysis.overallSignal)}`}>
                {analysis.overallSignal}
              </span>
            </div>

            <div className="mb-6">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Reasons:</h3>
              <ul className="list-disc list-inside space-y-1">
                {analysis.reasons.map((reason, index) => (
                  <li key={index} className="text-gray-700 dark:text-gray-300">{reason}</li>
                ))}
              </ul>
            </div>

            {/* EMA Analysis */}
            <div className="mb-6 p-3 sm:p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
              <h3 className="text-sm sm:text-base font-semibold text-gray-900 dark:text-white mb-3">EMA 9-Day Analysis</h3>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-4">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Signal</p>
                  <p className={`font-semibold ${getSignalBadgeColor(analysis.emaAnalysis.signal)} inline-block px-2 py-1 rounded text-sm`}>
                    {analysis.emaAnalysis.signal}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Current Price</p>
                  <p className="font-semibold text-gray-900 dark:text-white">
                    {analysis.emaAnalysis.currentPrice > 0 ? `$${analysis.emaAnalysis.currentPrice.toFixed(2)}` : 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">EMA 9</p>
                  <p className="font-semibold text-gray-900 dark:text-white">
                    {analysis.emaAnalysis.ema9 > 0 ? `$${analysis.emaAnalysis.ema9.toFixed(2)}` : 'N/A'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Distance</p>
                  <p className="font-semibold text-gray-900 dark:text-white">{analysis.emaAnalysis.distance || 'N/A'}</p>
                </div>
              </div>
              <p className="mt-3 text-sm text-gray-700 dark:text-gray-300">{analysis.emaAnalysis.reason}</p>
            </div>

            {/* Cup & Handle Analysis */}
            <div className="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-3">Cup & Handle Pattern</h3>
              
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Detected</p>
                  <p className={`font-semibold ${analysis.cupAndHandleAnalysis.detected ? 'text-green-600' : 'text-gray-500'}`}>
                    {analysis.cupAndHandleAnalysis.detected ? 'YES' : 'NO'}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Confidence</p>
                  <p className="font-semibold text-gray-900 dark:text-white">
                    {analysis.cupAndHandleAnalysis.confidence}%
                  </p>
                </div>
                <div>
                  <p className="text-sm text-gray-600 dark:text-gray-400">Signal</p>
                  <p className={`font-semibold ${getSignalBadgeColor(analysis.cupAndHandleAnalysis.signal)} inline-block px-2 py-1 rounded text-sm`}>
                    {analysis.cupAndHandleAnalysis.signal}
                  </p>
                </div>
              </div>

              <p className="text-sm text-gray-700 dark:text-gray-300 mb-4">{analysis.cupAndHandleAnalysis.reason}</p>

              {analysis.cupAndHandleAnalysis.patternDetails && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                  <div>
                    <p className="text-gray-600 dark:text-gray-400">Cup Depth</p>
                    <p className="font-semibold text-gray-900 dark:text-white">{analysis.cupAndHandleAnalysis.patternDetails.cupDepth}</p>
                  </div>
                  <div>
                    <p className="text-gray-600 dark:text-gray-400">Handle Depth</p>
                    <p className="font-semibold text-gray-900 dark:text-white">{analysis.cupAndHandleAnalysis.patternDetails.handleDepth}</p>
                  </div>
                  <div>
                    <p className="text-gray-600 dark:text-gray-400">Rim Symmetry</p>
                    <p className="font-semibold text-gray-900 dark:text-white">{analysis.cupAndHandleAnalysis.patternDetails.rimSymmetry}</p>
                  </div>
                  <div>
                    <p className="text-gray-600 dark:text-gray-400">Volume Decrease</p>
                    <p className="font-semibold text-gray-900 dark:text-white">{analysis.cupAndHandleAnalysis.patternDetails.volumeDecrease}</p>
                  </div>
                  <div>
                    <p className="text-gray-600 dark:text-gray-400">Breakout Price</p>
                    <p className="font-semibold text-gray-900 dark:text-white">${analysis.cupAndHandleAnalysis.patternDetails.breakoutPrice.toFixed(2)}</p>
                  </div>
                  <div>
                    <p className="text-gray-600 dark:text-gray-400">Distance to Breakout</p>
                    <p className="font-semibold text-gray-900 dark:text-white">{analysis.cupAndHandleAnalysis.patternDetails.distanceFromBreakout}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
              <p className="text-sm text-gray-700 dark:text-gray-300">
                <strong>Strategy:</strong> {analysis.strategy} | <strong>Holding Period:</strong> {analysis.recommendedHoldingPeriod}
              </p>
            </div>
          </div>
        )}

        {/* Multi-Symbol Scanner */}
        <div className="bg-white dark:bg-gray-800 p-3 sm:p-4 rounded-lg shadow mb-3 sm:mb-4">
          <h2 className="text-lg sm:text-xl font-semibold mb-3 sm:mb-4 text-gray-900 dark:text-white">
            Scan Multiple Symbols
          </h2>
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
            <input
              type="text"
              value={scanInput}
              onChange={(e) => setScanInput(e.target.value)}
              placeholder="Enter symbols (e.g., AAPL, MSFT, TSLA)"
              className="flex-1 px-3 sm:px-4 py-2 text-sm sm:text-base border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
            />
            <button
              onClick={scanSymbols}
              disabled={loading}
              className="px-4 sm:px-6 py-2 text-sm sm:text-base bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:opacity-50 whitespace-nowrap"
            >
              {loading ? 'Scanning...' : 'Scan'}
            </button>
          </div>
        </div>

        {/* Scan Results */}
        {scanResults.length > 0 && (
          <div className="bg-white dark:bg-gray-800 p-6 rounded-lg shadow">
            <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">
              Opportunities Found ({scanResults.length})
            </h2>
            <div className="space-y-4">
              {scanResults.map((result, index) => (
                <div key={index} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                  <div className="flex justify-between items-start mb-2">
                    <h3 className="text-lg font-bold text-gray-900 dark:text-white">{result.symbol}</h3>
                    <span className={`px-3 py-1 rounded-lg font-bold text-sm ${getSignalBadgeColor(result.overallSignal)}`}>
                      {result.overallSignal}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                    <div>
                      <p className="text-gray-600 dark:text-gray-400">EMA Signal</p>
                      <p className="font-semibold text-gray-900 dark:text-white">{result.emaAnalysis.signal}</p>
                    </div>
                    <div>
                      <p className="text-gray-600 dark:text-gray-400">C&H Pattern</p>
                      <p className="font-semibold text-gray-900 dark:text-white">
                        {result.cupAndHandleAnalysis.detected ? `${result.cupAndHandleAnalysis.confidence}% Confidence` : 'Not Detected'}
                      </p>
                    </div>
                    <div>
                      <p className="text-gray-600 dark:text-gray-400">Price</p>
                      <p className="font-semibold text-gray-900 dark:text-white">
                        ${result.emaAnalysis.currentPrice?.toFixed(2)}
                      </p>
                    </div>
                  </div>
                  <div className="mt-3">
                    <ul className="list-disc list-inside text-sm text-gray-700 dark:text-gray-300">
                      {result.reasons.map((reason, idx) => (
                        <li key={idx}>{reason}</li>
                      ))}
                    </ul>
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
