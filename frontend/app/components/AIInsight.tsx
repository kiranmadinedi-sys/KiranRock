import { getApiBaseUrl } from '../config';
'use client';

import React, { useState, useEffect } from 'react';

interface AIInsightProps {
  signal?: string;
  symbol?: string;
}

const AIInsight: React.FC<AIInsightProps> = ({ signal, symbol }) => {
  const [aiPrediction, setAiPrediction] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchAIPrediction = async () => {
      if (!symbol) return;
      
      setLoading(true);
      const token = localStorage.getItem('token');
      try {
  const response = fetch(`${getApiBaseUrl()}/api/ai/prediction/${symbol}`, {
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
  }, [symbol]);

  const getSignalInfo = () => {
    const currentSignal = aiPrediction?.signal || signal || 'Hold';
    
    switch (currentSignal) {
      case 'Buy':
        return {
          text: 'Strong Buy',
          description: aiPrediction?.reasoning || 'The model predicts a strong upward trend based on recent EMA crossover.',
          icon: '📈',
          className: 'bg-green-50 dark:bg-green-900/20 border-green-400 dark:border-green-800',
          badgeClass: 'bg-[var(--color-success)] text-white',
          textClass: 'text-green-800 dark:text-green-200',
        };
      case 'Sell':
        return {
          text: 'Strong Sell',
          description: aiPrediction?.reasoning || 'The model predicts a strong downward trend based on recent EMA crossover.',
          icon: '📉',
          className: 'bg-red-50 dark:bg-red-900/20 border-red-400 dark:border-red-800',
          badgeClass: 'bg-[var(--color-danger)] text-white',
          textClass: 'text-red-800 dark:text-red-200',
        };
      default:
        return {
          text: 'Neutral / Hold',
          description: aiPrediction?.reasoning || 'The model does not detect a strong trading signal at this time.',
          icon: '⏸️',
          className: 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-400 dark:border-yellow-800',
          badgeClass: 'bg-yellow-500 text-white',
          textClass: 'text-yellow-800 dark:text-yellow-200',
        };
    }
  };

  if (loading) {
    return (
      <div className="p-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <div className="text-center text-sm text-[var(--color-text-secondary)]">Loading AI prediction...</div>
      </div>
    );
  }

  const signalInfo = getSignalInfo();

  return (
    <div className={`p-3 rounded-lg border-2 ${signalInfo.className} shadow-sm`}>
      <div className="flex items-center justify-between mb-2">
        <h3 className={`text-sm font-bold ${signalInfo.textClass}`}>AI Signal</h3>
        <span className="text-xl">{signalInfo.icon}</span>
      </div>
      <div className={`inline-block px-3 py-1 rounded-full ${signalInfo.badgeClass} font-bold text-sm mb-2`}>
        {signalInfo.text}
      </div>
      
      {aiPrediction && (
        <div className="mb-2">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-semibold text-[var(--color-text-secondary)]">
              Model: {aiPrediction.model === 'huggingface-finbert' ? '🤖 FinBERT AI' : '📊 Technical Analysis'}
            </span>
            <span className="text-xs px-2 py-0.5 rounded bg-blue-500/20 text-blue-700 dark:text-blue-300 font-medium">
              {aiPrediction.confidence}% confidence
            </span>
          </div>
        </div>
      )}
      
      <p className={`text-xs ${signalInfo.textClass} leading-relaxed mb-2`}>
        {signalInfo.description}
      </p>

      {aiPrediction?.technicalContext && (
        <div className={`mt-2 pt-2 border-t ${signalInfo.textClass} border-opacity-20`}>
          <p className="text-xs font-semibold mb-1">Technical Context:</p>
          <ul className="text-xs space-y-0.5 ml-3">
            {aiPrediction.technicalContext.priceChange && (
              <li>• Price Change: {aiPrediction.technicalContext.priceChange}%</li>
            )}
            {aiPrediction.technicalContext.volumeTrend && (
              <li>• Volume: {aiPrediction.technicalContext.volumeTrend}</li>
            )}
            {aiPrediction.technicalContext.momentum && (
              <li>• Momentum: {aiPrediction.technicalContext.momentum}</li>
            )}
            {aiPrediction.technicalContext.sma5 && (
              <li>• SMA5: ${aiPrediction.technicalContext.sma5?.toFixed(2)}</li>
            )}
            {aiPrediction.technicalContext.sma10 && (
              <li>• SMA10: ${aiPrediction.technicalContext.sma10?.toFixed(2)}</li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
};

export default AIInsight;
