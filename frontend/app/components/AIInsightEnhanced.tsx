'use client';

import React, { useState, useEffect } from 'react';
import { API_BASE_URL } from '../config/apiConfig';

interface AIInsightProps {
  signal?: string;
  symbol?: string;
  mode?: 'single' | 'ensemble';
}

interface Prediction {
  signal: string;
  confidence: number;
  reasoning: string;
  model: string;
  modelsUsed?: number;
  individualPredictions?: Array<{
    model: string;
    signal: string;
    confidence: number;
    reasoning: string;
  }>;
  technicalContext?: any;
}

const AIInsightEnhanced: React.FC<AIInsightProps> = ({ signal, symbol, mode = 'ensemble' }) => {
  const [aiPrediction, setAiPrediction] = useState<Prediction | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedMode, setSelectedMode] = useState<'single' | 'ensemble'>(mode);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    const fetchAIPrediction = async () => {
      if (!symbol) return;
      
      setLoading(true);
      const token = localStorage.getItem('token');
      const endpoint = selectedMode === 'ensemble' 
          ? `${API_BASE_URL}/api/ai/ensemble/${symbol}`
          : `${API_BASE_URL}/api/ai/prediction/${symbol}`;
      
      try {
        const response = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (response.ok) {
          const data = await response.json();
          setAiPrediction(data);
        }
      } catch (error) {
        console.error('Error fetching AI prediction:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchAIPrediction();
  }, [symbol, selectedMode]);

  const getSignalInfo = () => {
    const currentSignal = aiPrediction?.signal || signal || 'Hold';
    
    switch (currentSignal) {
      case 'Buy':
        return {
          text: 'Strong Buy',
          description: aiPrediction?.reasoning || 'The model predicts a strong upward trend.',
          icon: '📈',
          className: 'bg-green-50 dark:bg-green-900/20 border-green-400 dark:border-green-800',
          badgeClass: 'bg-[var(--color-success)] text-white',
          textClass: 'text-green-800 dark:text-green-200',
        };
      case 'Sell':
        return {
          text: 'Strong Sell',
          description: aiPrediction?.reasoning || 'The model predicts a strong downward trend.',
          icon: '📉',
          className: 'bg-red-50 dark:bg-red-900/20 border-red-400 dark:border-red-800',
          badgeClass: 'bg-[var(--color-danger)] text-white',
          textClass: 'text-red-800 dark:text-red-200',
        };
      default:
        return {
          text: 'Neutral / Hold',
          description: aiPrediction?.reasoning || 'The model does not detect a strong trading signal.',
          icon: '⏸️',
          className: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-400 dark:border-yellow-800',
          badgeClass: 'bg-yellow-500 text-white',
          textClass: 'text-yellow-800 dark:text-yellow-200',
        };
    }
  };

  const getModelBadge = () => {
    if (!aiPrediction) return null;
    
    if (aiPrediction.model === 'multi-model-ensemble') {
      return `🤖 AI Ensemble (${aiPrediction.modelsUsed} models)`;
    } else if (aiPrediction.model === 'huggingface-finbert') {
      return '🤖 FinBERT AI';
    } else if (aiPrediction.model === 'agentic-fallback') {
      return '🤖 Agentic System';
    } else {
      return '📊 Technical Analysis';
    }
  };

  if (loading) {
    return (
      <div className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <div className="text-center text-sm text-[var(--color-text-secondary)]">
          <div className="animate-pulse">Loading AI prediction...</div>
        </div>
      </div>
    );
  }

  const signalInfo = getSignalInfo();

  return (
    <div className={`p-3 rounded-lg border-2 ${signalInfo.className} shadow-sm`}>
      {/* Mode Toggle */}
      <div className="flex items-center justify-between mb-2">
        <h3 className={`text-sm font-bold ${signalInfo.textClass}`}>AI Signal</h3>
        <div className="flex gap-1">
          <button
            onClick={() => setSelectedMode('single')}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              selectedMode === 'single'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
            }`}
            title="Single AI Model (FinBERT)"
          >
            Single
          </button>
          <button
            onClick={() => setSelectedMode('ensemble')}
            className={`px-2 py-0.5 text-xs rounded transition-colors ${
              selectedMode === 'ensemble'
                ? 'bg-blue-500 text-white'
                : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
            }`}
            title="Multi-Model Ensemble (FinBERT + DistilBERT + Technical + Momentum)"
          >
            Ensemble
          </button>
        </div>
      </div>

      {/* Signal Icon */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-3xl">{signalInfo.icon}</span>
        <div className={`px-3 py-1 rounded-full ${signalInfo.badgeClass} font-bold text-sm`}>
          {signalInfo.text}
        </div>
      </div>
      
      {/* Model Info */}
      {aiPrediction && (
        <div className="mb-2">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
              {getModelBadge()}
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-700 dark:text-blue-300 font-medium">
              {aiPrediction.confidence}% confidence
            </span>
          </div>
        </div>
      )}
      
      {/* Reasoning */}
      <p className={`text-xs ${signalInfo.textClass} leading-relaxed mb-2`}>
        {signalInfo.description}
      </p>

      {/* Individual Model Predictions (Ensemble Mode) */}
      {aiPrediction?.individualPredictions && aiPrediction.individualPredictions.length > 0 && (
        <div className="mt-2 pt-2 border-t border-opacity-20" style={{ borderColor: 'currentColor' }}>
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="text-xs font-semibold mb-1 flex items-center gap-1 hover:opacity-70 transition-opacity"
          >
            <span>{showDetails ? '▼' : '▶'}</span>
            Individual Model Predictions ({aiPrediction.individualPredictions.length})
          </button>
          
          {showDetails && (
            <div className="mt-2 space-y-1.5">
              {aiPrediction.individualPredictions.map((pred, idx) => (
                <div
                  key={idx}
                  className="text-xs p-2 rounded bg-white/50 dark:bg-black/20 border border-current border-opacity-10"
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-semibold">{pred.model}</span>
                    <div className="flex items-center gap-2">
                      <span className={`px-1.5 py-0.5 rounded text-xs font-bold ${
                        pred.signal === 'Buy' ? 'bg-green-500 text-white' :
                        pred.signal === 'Sell' ? 'bg-red-500 text-white' :
                        'bg-yellow-500 text-white'
                      }`}>
                        {pred.signal}
                      </span>
                      <span className="text-xs opacity-75">{pred.confidence}%</span>
                    </div>
                  </div>
                  <p className="text-xs opacity-80">{pred.reasoning}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Technical Context */}
      {aiPrediction?.technicalContext && (
        <div className={`mt-2 pt-2 border-t ${signalInfo.textClass} border-opacity-20`}>
          <p className="text-xs font-semibold mb-1">Technical Context:</p>
          <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-xs">
            {aiPrediction.technicalContext.priceChange && (
              <div>Price: {aiPrediction.technicalContext.priceChange}%</div>
            )}
            {aiPrediction.technicalContext.volumeTrend && (
              <div>Volume: {aiPrediction.technicalContext.volumeTrend.split(' ')[0]}</div>
            )}
            {aiPrediction.technicalContext.momentum && (
              <div>Momentum: {aiPrediction.technicalContext.momentum}</div>
            )}
            {aiPrediction.technicalContext.rsi && (
              <div>RSI: {aiPrediction.technicalContext.rsi.toFixed(1)}</div>
            )}
            {aiPrediction.technicalContext.sma5 && (
              <div>SMA5: ${aiPrediction.technicalContext.sma5.toFixed(2)}</div>
            )}
            {aiPrediction.technicalContext.sma10 && (
              <div>SMA10: ${aiPrediction.technicalContext.sma10.toFixed(2)}</div>
            )}
          </div>
        </div>
      )}

      {/* Mode Info */}
      <div className="mt-2 pt-2 border-t border-opacity-20 text-xs opacity-70" style={{ borderColor: 'currentColor' }}>
        {selectedMode === 'ensemble' ? (
          <span>🤖 Multi-model ensemble combines FinBERT, DistilBERT, Technical, and Momentum agents for robust predictions</span>
        ) : (
          <span>🤖 Single FinBERT model for financial sentiment analysis</span>
        )}
      </div>
    </div>
  );
};

export default AIInsightEnhanced;
