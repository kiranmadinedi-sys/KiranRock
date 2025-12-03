
'use client';
import { API_BASE_URL } from '../config/apiConfig';

import { useState, useEffect } from 'react';
import StockSearch from '../components/StockSearch';

interface ScalpingOpportunity {
  symbol: string;
  option: {
    contractSymbol: string;
    strike: number;
    expirationDate: string;
    optionType: string;
    bid: number;
    ask: number;
    volume: number;
    openInterest: number;
    impliedVolatility: number;
  };
  greeks: {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
  };
  stockPrice: number;
  daysToExpiration: number;
  analysis: {
    entryPrice: number;
    targetPrice: number;
    stopLoss: number;
    profitTarget: number;
    stopLossPercent: number;
    bidAskSpread: number;
    bidAskSpreadPercent: number;
    isLiquid: boolean;
    hasGoodSpread: boolean;
    isGoodScalp: boolean;
  };
  scalpScore: number;
  timeframeRecommendation: string;
}

export default function ScalpingPage() {
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [opportunities, setOpportunities] = useState<ScalpingOpportunity[]>([]);
  const [watchlist, setWatchlist] = useState<string[]>([]);
  const [selectedSymbol, setSelectedSymbol] = useState('');
  const [customSymbols, setCustomSymbols] = useState('');
  const [scanLimit, setScanLimit] = useState(10);

  useEffect(() => {
    loadWatchlist();
  }, []);

  const loadWatchlist = async () => {
    try {
      const token = localStorage.getItem('token');
  const response = await fetch(`${API_BASE_URL}/api/scalping/watchlist/recommended`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      setWatchlist(data.symbols || []);
      if (data.symbols?.length > 0) {
        setSelectedSymbol(data.symbols[0]);
      }
    } catch (error) {
      console.error('Failed to load watchlist:', error);
    }
  };

  // Advanced signals state
  const [scanSignals, setScanSignals] = useState<any>(null);
  const scanSingleSymbol = async () => {
    if (!selectedSymbol) return;
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE_URL}/api/scalping/${selectedSymbol}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      setOpportunities(data.opportunities || []);
      setScanSignals(data);
    } catch (error) {
      console.error('Scan failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const scanMultipleSymbols = async () => {
    const symbols = customSymbols 
      ? customSymbols.split(',').map(s => s.trim().toUpperCase())
      : watchlist.slice(0, 5); // Default to top 5 from watchlist
    
    setScanning(true);
    try {
      const token = localStorage.getItem('token');
  const response = await fetch(`${API_BASE_URL}/api/scalping/scan`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ symbols, limit: scanLimit })
      });
      const data = await response.json();
      setOpportunities(data.opportunities || []);
    } catch (error) {
      console.error('Market scan failed:', error);
    } finally {
      setScanning(false);
    }
  };

  // Scalping criteria state
  const [criteria, setCriteria] = useState<any>(null);
  const [criteriaLoading, setCriteriaLoading] = useState(false);
  const [criteriaError, setCriteriaError] = useState<string | null>(null);
  const [criteriaEdit, setCriteriaEdit] = useState<any>({});

  useEffect(() => {
    fetchCriteria();
  }, []);

  const fetchCriteria = async () => {
    setCriteriaLoading(true);
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${API_BASE_URL}/api/scalping/criteria/settings`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await response.json();
      setCriteria(data);
      setCriteriaEdit(data);
    } catch (error) {
      setCriteriaError('Failed to load criteria');
    } finally {
      setCriteriaLoading(false);
    }
  };

  // UI for editing criteria (future: PATCH endpoint)
  const handleCriteriaChange = (key: string, value: any) => {
    setCriteriaEdit((prev: any) => ({ ...prev, [key]: value }));
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-0">
      {/* Menu Bar */}
      <nav className="bg-white dark:bg-gray-800 shadow flex items-center justify-between px-6 py-3 mb-8">
        <div className="flex items-center gap-6">
          <span className="font-bold text-xl text-blue-700 dark:text-blue-300">TradeAI</span>
          <a href="/dashboard" className="text-gray-700 dark:text-gray-200 hover:text-blue-600 font-medium">Dashboard</a>
          <a href="/ai-trading" className="text-gray-700 dark:text-gray-200 hover:text-blue-600 font-medium">AI Trading</a>
          <a href="/swing-trading" className="text-gray-700 dark:text-gray-200 hover:text-blue-600 font-medium">Swing Trading</a>
          <a href="/scalping" className="text-blue-600 dark:text-blue-400 font-semibold underline">Scalping</a>
          <a href="/backtest" className="text-gray-700 dark:text-gray-200 hover:text-blue-600 font-medium">Backtest</a>
          <a href="/alerts" className="text-gray-700 dark:text-gray-200 hover:text-blue-600 font-medium">Alerts</a>
          <a href="/profile" className="text-gray-700 dark:text-gray-200 hover:text-blue-600 font-medium">Profile</a>
        </div>
      </nav>
      <div className="max-w-7xl mx-auto px-6">
        {/* Scalping Criteria Section */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 mb-6">
          <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">Scalping Criteria</h2>
          {criteriaLoading && <div className="text-gray-600">Loading criteria...</div>}
          {criteriaError && <div className="text-red-600">{criteriaError}</div>}
          {criteria && (
            <form className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {Object.entries(criteriaEdit).map(([key, value]) => (
                typeof value === 'number' ? (
                  <div key={key} className="flex flex-col">
                    <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{key}</label>
                    <input
                      type="number"
                      value={value}
                      onChange={e => handleCriteriaChange(key, parseFloat(e.target.value))}
                      className="p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                    />
                  </div>
                ) : null
              ))}
            </form>
          )}
          {/* Future: PATCH criteria button */}
        </div>
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            Options Scalping Strategy
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Ultra-short-term trading opportunities with high gamma and tight spreads
          </p>
        </div>

        {/* Controls */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 mb-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Single Symbol Scan */}
            <div>
              <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">
                Single Symbol Scan
              </h3>
              <div className="flex gap-3">
                <div className="flex-1">
                  <StockSearch onSelectStock={setSelectedSymbol} />
                  {selectedSymbol && (
                    <div className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                      Selected: <span className="font-semibold text-blue-600">{selectedSymbol}</span>
                    </div>
                  )}
                </div>
                <button
                  onClick={scanSingleSymbol}
                  disabled={loading || !selectedSymbol}
                  className="px-6 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? 'Scanning...' : 'Scan'}
                </button>
              </div>
            </div>

            {/* Multi-Symbol Scan */}
            <div>
              <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white">
                Market Scan
              </h3>
              <div className="space-y-3">
                <input
                  type="text"
                  placeholder="Enter symbols (comma-separated, leave empty for watchlist)"
                  value={customSymbols}
                  onChange={(e) => setCustomSymbols(e.target.value)}
                  className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
                <div className="flex gap-3">
                  <input
                    type="number"
                    value={scanLimit}
                    onChange={(e) => setScanLimit(parseInt(e.target.value) || 10)}
                    min="1"
                    max="50"
                    className="w-24 p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  />
                  <button
                    onClick={scanMultipleSymbols}
                    disabled={scanning}
                    className="flex-1 px-6 py-2 bg-green-600 text-white rounded hover:bg-green-700 disabled:opacity-50"
                  >
                    {scanning ? 'Scanning Market...' : 'Scan Market'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Advanced Scalping Signals & Strategy Summary */}
        {scanSignals && (
          (scanSignals.preMarketHigh || scanSignals.vwap || scanSignals.ema9 || scanSignals.volumeSpikes) ? (
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg shadow-lg p-6 mb-6">
              <h2 className="text-xl font-bold mb-2 text-blue-900 dark:text-blue-200">Scalping Signals & Strategy</h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                <div>
                  <div className="text-xs text-gray-600">Pre-market High</div>
                  <div className="font-bold text-blue-700">{scanSignals.preMarketHigh !== undefined ? scanSignals.preMarketHigh.toFixed(2) : '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600">Pre-market Low</div>
                  <div className="font-bold text-blue-700">{scanSignals.preMarketLow !== undefined ? scanSignals.preMarketLow.toFixed(2) : '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600">Session High</div>
                  <div className="font-bold text-blue-700">{scanSignals.sessionHigh !== undefined ? scanSignals.sessionHigh.toFixed(2) : '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600">Session Low</div>
                  <div className="font-bold text-blue-700">{scanSignals.sessionLow !== undefined ? scanSignals.sessionLow.toFixed(2) : '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600">VWAP</div>
                  <div className="font-bold text-purple-700">{scanSignals.vwap !== undefined ? scanSignals.vwap.toFixed(2) : '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600">EMA(9)</div>
                  <div className="font-bold text-green-700">{scanSignals.ema9 !== undefined ? scanSignals.ema9.toFixed(2) : '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600">EMA(21)</div>
                  <div className="font-bold text-green-700">{scanSignals.ema21 !== undefined ? scanSignals.ema21.toFixed(2) : '-'}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-600">Volume Spikes</div>
                  <div className="font-bold text-red-700">{scanSignals.volumeSpikes ? scanSignals.volumeSpikes.length : 0}</div>
                </div>
              </div>
              <div className="mt-2 text-sm text-gray-700 dark:text-gray-200">
                <b>Strategy:</b> Trade 1-min/5-min breakouts above resistance or breakdowns below support, confirmed by volume spikes and tight spread (&lt;$0.10 for TSLA). Use VWAP and EMA(9/21) for confirmation. Take quick profits ($1.5–$3/share), set tight stop-loss (0.3–0.5%).
              </div>
              <div className="mt-2 text-xs text-gray-500">Example: Enter long at resistance breakout with volume, exit at next $1.5–$3 move, stop-loss just below entry.</div>
            </div>
          ) : (
            <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg shadow-lg p-6 mb-6 text-center text-blue-900 dark:text-blue-200">
              <h2 className="text-xl font-bold mb-2">No advanced scalping signals available for this symbol.</h2>
              <div className="text-sm">Try scanning TSLA or another high-liquidity stock during market hours.</div>
            </div>
          )
        )}
        {/* Results */}
        {opportunities.length > 0 && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6">
            <h2 className="text-2xl font-bold mb-4 text-gray-900 dark:text-white">
              Top Scalping Opportunities ({opportunities.length})
            </h2>
            <div className="space-y-4">
              {opportunities.map((opp, index) => (
                <div
                  key={index}
                  className={`border rounded-lg p-4 ${
                    opp.analysis.isGoodScalp
                      ? 'border-green-500 bg-green-50 dark:bg-green-900/20'
                      : 'border-gray-300 dark:border-gray-600'
                  }`}
                >
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                        {opp.symbol}
                      </h3>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {opp.option.contractSymbol}
                      </p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {opp.option.optionType.toUpperCase()} ${opp.option.strike} exp {opp.option.expirationDate}
                      </p>
                    </div>
                    <div className="text-right">
                      <div className={`text-2xl font-bold ${
                        opp.scalpScore >= 80 ? 'text-green-600' :
                        opp.scalpScore >= 60 ? 'text-yellow-600' : 'text-gray-600'
                      }`}>
                        {opp.scalpScore.toFixed(0)}
                      </div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Scalp Score</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
                    <div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Entry (Ask)</div>
                      <div className="font-semibold text-gray-900 dark:text-white">
                        ${opp.analysis.entryPrice.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Target (+20%)</div>
                      <div className="font-semibold text-green-600">
                        ${opp.analysis.targetPrice.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Stop (-10%)</div>
                      <div className="font-semibold text-red-600">
                        ${opp.analysis.stopLoss.toFixed(2)}
                      </div>
                    </div>
                    <div>
                      <div className="text-sm text-gray-600 dark:text-gray-400">Timeframe</div>
                      <div className="font-semibold text-gray-900 dark:text-white">
                        {opp.timeframeRecommendation}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-3 text-sm">
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">Gamma:</span>
                      <span className="ml-2 font-semibold text-gray-900 dark:text-white">
                        {opp.greeks.gamma.toFixed(4)}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">Delta:</span>
                      <span className="ml-2 font-semibold text-gray-900 dark:text-white">
                        {opp.greeks.delta.toFixed(3)}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">Volume:</span>
                      <span className="ml-2 font-semibold text-gray-900 dark:text-white">
                        {opp.option.volume.toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">OI:</span>
                      <span className="ml-2 font-semibold text-gray-900 dark:text-white">
                        {opp.option.openInterest.toLocaleString()}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-600 dark:text-gray-400">Spread:</span>
                      <span className={`ml-2 font-semibold ${
                        opp.analysis.bidAskSpreadPercent <= 10 ? 'text-green-600' :
                        opp.analysis.bidAskSpreadPercent <= 15 ? 'text-yellow-600' : 'text-red-600'
                      }`}>
                        {opp.analysis.bidAskSpreadPercent.toFixed(1)}%
                      </span>
                    </div>
                  </div>

                  <div className="flex gap-2 flex-wrap">
                    {opp.analysis.isLiquid && (
                      <span className="px-2 py-1 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 rounded text-xs">
                        ✓ Liquid
                      </span>
                    )}
                    {opp.analysis.hasGoodSpread && (
                      <span className="px-2 py-1 bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200 rounded text-xs">
                        ✓ Tight Spread
                      </span>
                    )}
                    {opp.greeks.gamma >= 0.05 && (
                      <span className="px-2 py-1 bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200 rounded text-xs">
                        ✓ High Gamma
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {opportunities.length === 0 && !loading && !scanning && (
          <div className="text-center text-gray-600 dark:text-gray-400 py-12">
            Select a symbol or scan the market to find scalping opportunities
          </div>
        )}
      </div>
    </div>
  );
}
