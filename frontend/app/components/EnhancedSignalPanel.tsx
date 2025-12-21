'use client';
import React, { useState, useEffect } from 'react';
import { getApiBaseUrl } from '../config';

interface EnhancedSignalPanelProps {
  symbol: string;
  interval: string;
}

const EnhancedSignalPanel: React.FC<EnhancedSignalPanelProps> = ({ symbol, interval }) => {
  const [data, setData] = useState<any>(null);
  const [mtfData, setMtfData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    fetchData();
  }, [symbol, interval]);

  const fetchData = async () => {
    try {
      setLoading(true);
      const apiUrl = getApiBaseUrl();
      
      // Fetch enhanced signals
      const signalsResponse = await fetch(
        `${apiUrl}/api/enhanced-signals/${symbol}?interval=${interval}&minConfluence=3`
      );
      const signalsData = await signalsResponse.json();
      setData(signalsData);

      // Fetch MTF analysis
      const mtfResponse = await fetch(`${getApiBaseUrl()}/api/enhanced-signals/${symbol}/mtf`);
      const mtfData = await mtfResponse.json();
      setMtfData(mtfData);
      
      setLoading(false);
    } catch (error) {
      console.error('[EnhancedSignalPanel] Error fetching data:', error);
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bg-gradient-to-r from-slate-900 to-gray-900 border-b border-r border-gray-700 p-4 shadow-xl">
        <div className="animate-pulse">
          <div className="h-4 bg-gray-700 rounded w-3/4 mb-2"></div>
          <div className="h-4 bg-gray-700 rounded w-1/2"></div>
        </div>
      </div>
    );
  }

  if (!data || !data.signals) {
    return (
      <div className="bg-gradient-to-r from-slate-900 to-gray-900 border-b border-r border-gray-700 p-4 shadow-xl">
        <p className="text-gray-400">No enhanced signal data available</p>
      </div>
    );
  }

  const lastSignal = data.signals.length > 0 ? data.signals[data.signals.length - 1] : null;
  const confidence = lastSignal ? parseFloat(lastSignal.confidence) : 0;
  const isHighConfidence = confidence >= 70;

  const getConfidenceColor = (conf: number) => {
    if (conf >= 80) return 'text-green-400';
    if (conf >= 60) return 'text-yellow-400';
    return 'text-orange-400';
  };

  const getMTFAlignmentColor = (strength: number) => {
    if (strength >= 80) return 'bg-green-500';
    if (strength >= 60) return 'bg-yellow-500';
    return 'bg-gray-500';
  };

  return (
    <div className="bg-gradient-to-r from-slate-900 to-gray-900 border-b border-r border-gray-700 shadow-xl">
      {/* Header */}
      <div className="bg-gradient-to-r from-purple-600 to-indigo-600 px-4 py-2 border-b border-gray-700">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-bold text-sm">🎯 AI Signal Analysis</h3>
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="text-white text-xs hover:text-gray-200 transition-colors"
          >
            {showDetails ? '▼ Hide' : '▶ Details'}
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="p-4 space-y-3">
        {/* Last Signal */}
        {lastSignal && (
          <div className={`p-3 rounded-lg border-2 ${
            lastSignal.type === 'BUY' 
              ? 'bg-green-900/30 border-green-500' 
              : 'bg-red-900/30 border-red-500'
          }`}>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`text-2xl ${lastSignal.type === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                  {lastSignal.type === 'BUY' ? '🔼' : '🔽'}
                </span>
                <div>
                  <div className={`font-bold text-lg ${
                    lastSignal.type === 'BUY' ? 'text-green-400' : 'text-red-400'
                  }`}>
                    {lastSignal.type}
                  </div>
                  <div className="text-gray-400 text-xs">
                    ${lastSignal.price?.toFixed(2)}
                  </div>
                </div>
              </div>
              <div className="text-right">
                <div className={`font-bold text-xl ${getConfidenceColor(confidence)}`}>
                  {lastSignal.confidence}%
                </div>
                <div className="text-gray-400 text-xs">Confidence</div>
              </div>
            </div>
            
            {/* Confluence Score */}
            <div className="mt-2 pt-2 border-t border-gray-700">
              <div className="flex items-center justify-between text-xs">
                <span className="text-gray-400">Confluence Score:</span>
                <span className="text-white font-semibold">
                  {lastSignal.confluenceScore}/{lastSignal.maxScore}
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2 mt-1">
                <div 
                  className={`h-2 rounded-full ${
                    parseFloat(lastSignal.confluenceScore) >= 5 ? 'bg-green-500' :
                    parseFloat(lastSignal.confluenceScore) >= 3 ? 'bg-yellow-500' : 'bg-orange-500'
                  }`}
                  style={{ width: `${(parseFloat(lastSignal.confluenceScore) / lastSignal.maxScore) * 100}%` }}
                ></div>
              </div>
            </div>

            {/* Risk/Reward */}
            {lastSignal.riskReward && (
              <div className="mt-2 pt-2 border-t border-gray-700 grid grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-gray-400">Entry</div>
                  <div className="text-white font-semibold">${lastSignal.riskReward.entry.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-red-400">Stop Loss</div>
                  <div className="text-white font-semibold">${lastSignal.riskReward.stopLoss.toFixed(2)}</div>
                </div>
                <div>
                  <div className="text-green-400">Take Profit</div>
                  <div className="text-white font-semibold">${lastSignal.riskReward.takeProfit.toFixed(2)}</div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Multi-Timeframe Analysis */}
        {mtfData && (
          <div className="bg-gray-800/50 p-3 rounded-lg border border-gray-700">
            <div className="flex items-center justify-between mb-2">
              <div className="text-white font-semibold text-sm">📊 Multi-Timeframe</div>
              <div className={`px-2 py-1 rounded text-xs font-bold ${getMTFAlignmentColor(mtfData.alignmentStrength)} text-white`}>
                {mtfData.alignment}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              {Object.entries(mtfData.timeframes).map(([tf, data]: [string, any]) => (
                <div key={tf} className="bg-gray-900/50 p-2 rounded border border-gray-700">
                  <div className="text-gray-400 mb-1">{tf.toUpperCase()}</div>
                  <div className={`font-bold ${
                    data.signal === 'BUY' ? 'text-green-400' :
                    data.signal === 'SELL' ? 'text-red-400' : 'text-gray-400'
                  }`}>
                    {data.signal}
                  </div>
                  <div className="text-gray-500 text-xs">{data.confidence}%</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Metadata Summary */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-gray-800/50 p-2 rounded border border-gray-700">
            <div className="text-gray-400">Total Signals</div>
            <div className="text-white font-bold text-lg">{data.metadata.totalSignals}</div>
          </div>
          <div className="bg-gray-800/50 p-2 rounded border border-gray-700">
            <div className="text-gray-400">Avg Confidence</div>
            <div className={`font-bold text-lg ${getConfidenceColor(parseFloat(data.metadata.avgConfidence))}`}>
              {data.metadata.avgConfidence}%
            </div>
          </div>
        </div>

        {/* Support & Resistance */}
        {(Array.isArray(data.metadata?.support) && data.metadata.support.length > 0) || 
         (Array.isArray(data.metadata?.resistance) && data.metadata.resistance.length > 0) ? (
          <div className="bg-gray-800/50 p-2 rounded border border-gray-700 text-xs">
            <div className="text-white font-semibold mb-2">📍 Key Levels</div>
            <div className="space-y-1">
              {Array.isArray(data.metadata?.resistance) && data.metadata.resistance.slice(0, 2).map((r: any, i: number) => (
                <div key={`r-${i}`} className="flex justify-between text-red-400">
                  <span>Resistance {i + 1}:</span>
                  <span className="font-bold">${r.price.toFixed(2)}</span>
                </div>
              ))}
              {Array.isArray(data.metadata?.support) && data.metadata.support.slice(0, 2).map((s: any, i: number) => (
                <div key={`s-${i}`} className="flex justify-between text-green-400">
                  <span>Support {i + 1}:</span>
                  <span className="font-bold">${s.price.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Detailed View */}
        {showDetails && lastSignal && (
          <div className="bg-gray-800/50 p-3 rounded border border-gray-700 text-xs space-y-2">
            <div className="text-white font-semibold mb-2">📋 Signal Details</div>
            
            {/* Confluence Reasons */}
            <div>
              <div className="text-gray-400 mb-1">Confluence Factors:</div>
              <ul className="space-y-1">
                {lastSignal.confluenceReasons.map((reason: string, i: number) => (
                  <li key={i} className="text-gray-300 flex items-start gap-1">
                    <span className="text-green-400">✓</span>
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Indicators */}
            {lastSignal.indicators && (
              <div className="pt-2 border-t border-gray-700">
                <div className="text-gray-400 mb-1">Technical Indicators:</div>
                <div className="grid grid-cols-2 gap-2">
                  {lastSignal.indicators.rsi && (
                    <div>
                      <span className="text-gray-400">RSI:</span>
                      <span className="text-white ml-1 font-semibold">{lastSignal.indicators.rsi}</span>
                    </div>
                  )}
                  {lastSignal.indicators.macd && (
                    <div>
                      <span className="text-gray-400">MACD:</span>
                      <span className="text-white ml-1 font-semibold">{lastSignal.indicators.macd}</span>
                    </div>
                  )}
                  {lastSignal.indicators.volumeRatio && (
                    <div>
                      <span className="text-gray-400">Volume:</span>
                      <span className="text-white ml-1 font-semibold">{lastSignal.indicators.volumeRatio}x</span>
                    </div>
                  )}
                  {lastSignal.indicators.vix && (
                    <div>
                      <span className="text-gray-400">VIX:</span>
                      <span className="text-white ml-1 font-semibold">{lastSignal.indicators.vix}</span>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Patterns */}
            {data.patterns && data.patterns.length > 0 && (
              <div className="pt-2 border-t border-gray-700">
                <div className="text-gray-400 mb-1">Detected Patterns:</div>
                {data.patterns.slice(-3).map((pattern: any, i: number) => (
                  <div key={i} className="text-white">
                    • {pattern.pattern} ({pattern.confidence}%)
                  </div>
                ))}
              </div>
            )}

            {/* Divergences */}
            {data.divergences && data.divergences.length > 0 && (
              <div className="pt-2 border-t border-gray-700">
                <div className="text-gray-400 mb-1">RSI Divergences:</div>
                {data.divergences.slice(-2).map((div: any, i: number) => (
                  <div key={i} className={`${
                    div.divergenceType === 'bullish' ? 'text-green-400' : 'text-red-400'
                  }`}>
                    • {div.divergenceType.toUpperCase()} ({div.strength}% strength)
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Refresh Button */}
        <button
          onClick={fetchData}
          className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-semibold py-2 px-4 rounded-lg transition-all text-sm"
        >
          🔄 Refresh Analysis
        </button>
      </div>
    </div>
  );
};

export default EnhancedSignalPanel;
