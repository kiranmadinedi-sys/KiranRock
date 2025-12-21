
'use client';
import { getApiBaseUrl } from '../config';

import { useState } from 'react';
import AppHeader from '../components/AppHeader';

interface ScenarioResult {
  scenario: string;
  stockPrice: number;
  optionPrice: number;
  profitLoss: number;
  profitLossPercent: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

interface RiskMetrics {
  maxProfit: number;
  maxLoss: number;
  breakeven: number;
  riskRewardRatio: number;
}

export default function ScenariosPage() {
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'price' | 'theta' | 'matrix'>('matrix');
  
  // Option inputs
  const [symbol, setSymbol] = useState('AAPL');
  const [stockPrice, setStockPrice] = useState('175.00');
  const [strikePrice, setStrikePrice] = useState('175.00');
  const [optionType, setOptionType] = useState<'call' | 'put'>('call');
  const [daysToExp, setDaysToExp] = useState('30');
  const [volatility, setVolatility] = useState('0.30');
  const [riskFreeRate, setRiskFreeRate] = useState('0.045');
  
  // Results
  const [priceResults, setPriceResults] = useState<ScenarioResult[]>([]);
  const [thetaResults, setThetaResults] = useState<ScenarioResult[]>([]);
  const [matrixResults, setMatrixResults] = useState<ScenarioResult[]>([]);
  const [riskMetrics, setRiskMetrics] = useState<RiskMetrics | null>(null);

  const buildOptionObject = () => ({
    symbol,
    stockPrice: parseFloat(stockPrice),
    strikePrice: parseFloat(strikePrice),
    optionType,
    daysToExpiration: parseInt(daysToExp),
    volatility: parseFloat(volatility),
    riskFreeRate: parseFloat(riskFreeRate)
  });

  const runPriceScenario = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const option = buildOptionObject();
      const scenarios = [-10, -5, -2, 0, 2, 5, 10];
      const results: ScenarioResult[] = [];

      for (const priceChange of scenarios) {
  const response = fetch(`${getApiBaseUrl()}/api/scenarios/price-change`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ option, priceChange })
        });
        const data = await response.json();
        results.push({
          scenario: `${priceChange > 0 ? '+' : ''}${priceChange}%`,
          stockPrice: data.newStockPrice,
          optionPrice: data.newOptionPrice,
          profitLoss: data.profitLoss,
          profitLossPercent: data.profitLossPercent,
          delta: data.newDelta,
          gamma: data.newGamma,
          theta: data.newTheta,
          vega: data.newVega
        });
      }

      setPriceResults(results);
    } catch (error) {
      console.error('Price scenario failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const runThetaDecay = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const option = buildOptionObject();
  const response = fetch(`${getApiBaseUrl()}/api/scenarios/theta-decay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ option, days: 30 })
      });
      const data = await response.json();
      
      const results: ScenarioResult[] = data.scenarios.map((s: any) => ({
        scenario: `Day ${s.day}`,
        stockPrice: s.stockPrice,
        optionPrice: s.optionPrice,
        profitLoss: s.profitLoss,
        profitLossPercent: s.profitLossPercent,
        delta: s.delta,
        gamma: s.gamma,
        theta: s.theta,
        vega: s.vega
      }));

      setThetaResults(results);
    } catch (error) {
      console.error('Theta decay failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const runScenarioMatrix = async () => {
    setLoading(true);
    try {
      const token = localStorage.getItem('token');
      const option = buildOptionObject();
  const response = fetch(`${getApiBaseUrl()}/api/scenarios/matrix`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ option })
      });
      const data = await response.json();
      
      const results: ScenarioResult[] = data.matrix.map((s: any) => ({
        scenario: s.scenario,
        stockPrice: s.stockPrice,
        optionPrice: s.optionPrice,
        profitLoss: s.profitLoss,
        profitLossPercent: s.profitLossPercent,
        delta: s.delta,
        gamma: s.gamma,
        theta: s.theta,
        vega: s.vega
      }));

      setMatrixResults(results);
      
      // Calculate risk metrics
  const riskResp = fetch(`${getApiBaseUrl()}/api/scenarios/risk-metrics`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ option })
      });
      const risk = await riskResp.json();
      setRiskMetrics(risk);
    } catch (error) {
      console.error('Scenario matrix failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const runScenario = () => {
    if (activeTab === 'price') runPriceScenario();
    else if (activeTab === 'theta') runThetaDecay();
    else runScenarioMatrix();
  };

  const renderResults = () => {
    const results = activeTab === 'price' ? priceResults :
                   activeTab === 'theta' ? thetaResults : matrixResults;
    
    if (results.length === 0) return null;

    return (
      <div className="mt-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-100 dark:bg-gray-700">
              <tr>
                <th className="p-3 text-left">Scenario</th>
                <th className="p-3 text-right">Stock Price</th>
                <th className="p-3 text-right">Option Price</th>
                <th className="p-3 text-right">P/L</th>
                <th className="p-3 text-right">P/L %</th>
                <th className="p-3 text-right">Delta</th>
                <th className="p-3 text-right">Gamma</th>
                <th className="p-3 text-right">Theta</th>
                <th className="p-3 text-right">Vega</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result, index) => (
                <tr key={index} className="border-b dark:border-gray-700">
                  <td className="p-3 font-semibold">{result.scenario}</td>
                  <td className="p-3 text-right">${result.stockPrice.toFixed(2)}</td>
                  <td className="p-3 text-right">${result.optionPrice.toFixed(2)}</td>
                  <td className={`p-3 text-right font-semibold ${
                    result.profitLoss >= 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                    ${result.profitLoss.toFixed(2)}
                  </td>
                  <td className={`p-3 text-right ${
                    result.profitLossPercent >= 0 ? 'text-green-600' : 'text-red-600'
                  }`}>
                    {result.profitLossPercent.toFixed(1)}%
                  </td>
                  <td className="p-3 text-right">{result.delta.toFixed(3)}</td>
                  <td className="p-3 text-right">{result.gamma.toFixed(4)}</td>
                  <td className="p-3 text-right">{result.theta.toFixed(3)}</td>
                  <td className="p-3 text-right">{result.vega.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {riskMetrics && activeTab === 'matrix' && (
          <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded">
              <div className="text-sm text-gray-600 dark:text-gray-400">Max Profit</div>
              <div className="text-2xl font-bold text-green-600">
                ${riskMetrics.maxProfit.toFixed(2)}
              </div>
            </div>
            <div className="bg-red-50 dark:bg-red-900/20 p-4 rounded">
              <div className="text-sm text-gray-600 dark:text-gray-400">Max Loss</div>
              <div className="text-2xl font-bold text-red-600">
                ${riskMetrics.maxLoss.toFixed(2)}
              </div>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded">
              <div className="text-sm text-gray-600 dark:text-gray-400">Breakeven</div>
              <div className="text-2xl font-bold text-blue-600">
                ${riskMetrics.breakeven.toFixed(2)}
              </div>
            </div>
            <div className="bg-purple-50 dark:bg-purple-900/20 p-4 rounded">
              <div className="text-sm text-gray-600 dark:text-gray-400">Risk/Reward</div>
              <div className="text-2xl font-bold text-purple-600">
                1:{riskMetrics.riskRewardRatio.toFixed(2)}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 via-slate-50 to-gray-100 dark:from-gray-900 dark:via-slate-900 dark:to-gray-900">
      <AppHeader showSearch={false} />
      <div className="max-w-7xl mx-auto p-6">
        <div className="mb-8">
          <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
            Scenario Modeling
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Analyze how option values and Greeks change with price movements and time decay
          </p>
        </div>

        {/* Input Form */}
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 mb-6">
          <h2 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">Option Setup</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
            <div>
              <label className="block text-sm mb-1 text-gray-700 dark:text-gray-300">Symbol</label>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 text-gray-700 dark:text-gray-300">Stock Price</label>
              <input
                type="number"
                step="0.01"
                value={stockPrice}
                onChange={(e) => setStockPrice(e.target.value)}
                className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 text-gray-700 dark:text-gray-300">Strike</label>
              <input
                type="number"
                step="0.01"
                value={strikePrice}
                onChange={(e) => setStrikePrice(e.target.value)}
                className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 text-gray-700 dark:text-gray-300">Type</label>
              <select
                value={optionType}
                onChange={(e) => setOptionType(e.target.value as 'call' | 'put')}
                className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              >
                <option value="call">Call</option>
                <option value="put">Put</option>
              </select>
            </div>
            <div>
              <label className="block text-sm mb-1 text-gray-700 dark:text-gray-300">Days to Exp</label>
              <input
                type="number"
                value={daysToExp}
                onChange={(e) => setDaysToExp(e.target.value)}
                className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 text-gray-700 dark:text-gray-300">IV (Volatility)</label>
              <input
                type="number"
                step="0.01"
                value={volatility}
                onChange={(e) => setVolatility(e.target.value)}
                className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
            <div>
              <label className="block text-sm mb-1 text-gray-700 dark:text-gray-300">Risk-Free Rate</label>
              <input
                type="number"
                step="0.001"
                value={riskFreeRate}
                onChange={(e) => setRiskFreeRate(e.target.value)}
                className="w-full p-2 border rounded dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              />
            </div>
          </div>

          {/* Tabs */}
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => setActiveTab('matrix')}
              className={`px-4 py-2 rounded ${
                activeTab === 'matrix'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Full Matrix
            </button>
            <button
              onClick={() => setActiveTab('price')}
              className={`px-4 py-2 rounded ${
                activeTab === 'price'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Price Changes
            </button>
            <button
              onClick={() => setActiveTab('theta')}
              className={`px-4 py-2 rounded ${
                activeTab === 'theta'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
              }`}
            >
              Time Decay
            </button>
          </div>

          <button
            onClick={runScenario}
            disabled={loading}
            className="w-full py-3 bg-green-600 text-white rounded font-semibold hover:bg-green-700 disabled:opacity-50"
          >
            {loading ? 'Running...' : `Run ${activeTab === 'matrix' ? 'Full Analysis' : activeTab === 'price' ? 'Price Scenarios' : 'Theta Decay'}`}
          </button>
        </div>

        {/* Results */}
        {renderResults()}
      </div>
    </div>
  );
}
