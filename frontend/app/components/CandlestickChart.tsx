'use client';
import React, { useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '../config/apiConfig';
import { createChart, IChartApi, ISeriesApi, UTCTimestamp, CrosshairMode } from 'lightweight-charts';

export interface Marker {
  time: UTCTimestamp;
  position: 'aboveBar' | 'belowBar' | 'inBar';
  color: string;
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  text: string;
}

interface ChartData {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CandlestickChartProps {
  symbol: string;
}

const CandlestickChart: React.FC<CandlestickChartProps> = ({ symbol }) => {
  // Fetch price data and update chart
  const fetchData = async () => {
    try {
      addDebugLog('[CandlestickChart] Fetching price data for', symbol);
      // Use 1-minute candles for live charting
      const priceResponse = await fetch(`${API_BASE_URL}/api/stocks/${symbol}?interval=1m&includePrePost=true`);
      if (!priceResponse.ok) throw new Error('Failed to fetch price data');
      const priceData: ChartData[] = await priceResponse.json();
      addDebugLog('[CandlestickChart] priceData:', priceData);

      if (priceData.length > 0 && candlestickSeriesRef.current && volumeSeriesRef.current) {
        candlestickSeriesRef.current.setData(priceData);

        // Volume bars colored green (up) or red (down) based on candle direction
        const volumeData = priceData.map(d => ({
          time: d.time,
          value: d.volume,
          color: d.close >= d.open ? '#26a69a' : '#ef5350',
        }));
        volumeSeriesRef.current.setData(volumeData);
        chartRef.current?.timeScale().fitContent();

        // --- EMA Series Data ---
        let emaShort, emaLong;
        if (showEma) {
          if (useConservativeEma) {
            emaShort = calculateEMA(priceData, 9);
            emaLong = calculateEMA(priceData, 20);
          } else {
            emaShort = calculateEMA(priceData, 5);
            emaLong = calculateEMA(priceData, 15);
          }
          emaShortRef.current?.setData(emaShort);
          emaLongRef.current?.setData(emaLong);
        } else {
          emaShortRef.current?.setData([]);
          emaLongRef.current?.setData([]);
        }

        // --- Bollinger Bands Series Data ---
        if (showBbands) {
          const bands = calculateBollingerBands(priceData);
          bbUpperRef.current?.setData(bands.map(b => ({ time: b.time, value: b.upper })));
          bbLowerRef.current?.setData(bands.map(b => ({ time: b.time, value: b.lower })));
          bbMiddleRef.current?.setData(bands.map(b => ({ time: b.time, value: b.middle })));
        } else {
          bbUpperRef.current?.setData([]);
          bbLowerRef.current?.setData([]);
          bbMiddleRef.current?.setData([]);
        }
      } else {
        addDebugLog('[CandlestickChart] No price data to render chart');
      }
    } catch (error) {
      addDebugLog('[CandlestickChart] Error fetching chart data:', error && error.message ? error.message : error);
    }
  };
  // Lightweight-charts marker shape values
  const ArrowUp = 1;
  const ArrowDown = 2;
  // EMA and Bollinger Bands series refs
  const emaShortRef = useRef<ISeriesApi<'Line'> | null>(null);
  const emaLongRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbMiddleRef = useRef<ISeriesApi<'Line'> | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candlestickSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const fullscreenContainerRef = useRef<HTMLDivElement>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [showEma, setShowEma] = useState(false);
  const [showBbands, setShowBbands] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [forceFullscreen, setForceFullscreen] = useState(false);
  const [useConservativeEma, setUseConservativeEma] = useState(false);
  const [timeframe, setTimeframe] = useState<'1d' | '1wk' | '1mo' | 'all'>('1d');

  const addDebugLog = (msg: string, ...args: any[]) => {
    const logMsg = `${msg} ${args.map(a => JSON.stringify(a)).join(' ')}`;
    setDebugLogs(logs => [...logs, logMsg].slice(-20));
    console.log(msg, ...args);
  };

  function calculateEMA(data: ChartData[], period: number) {
    let ema: number[] = [];
    let k = 2 / (period + 1);
    let prev = data[0]?.close || 0;
    for (let i = 0; i < data.length; i++) {
      let close = data[i].close;
      let value = i === 0 ? close : close * k + prev * (1 - k);
      ema.push(value);
      prev = value;
    }
    return data.map((d, i) => ({ time: d.time, value: parseFloat(ema[i].toFixed(2)) }));
  }

  function calculateBollingerBands(data: ChartData[], period: number = 20, mult: number = 2) {
    let bands = [];
    for (let i = 0; i < data.length; i++) {
      let slice = data.slice(Math.max(0, i - period + 1), i + 1);
      let closes = slice.map(d => d.close);
      let mean = closes.reduce((a, b) => a + b, 0) / closes.length;
      let std = Math.sqrt(closes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / closes.length);
      bands.push({
        time: data[i].time,
        upper: parseFloat((mean + mult * std).toFixed(2)),
        lower: parseFloat((mean - mult * std).toFixed(2)),
        middle: parseFloat(mean.toFixed(2)),
      });
    }
    return bands;
  }
  useEffect(() => {
    if (!chartContainerRef.current || !symbol) return;

    // Remove previous chart if exists
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const isDark = document.documentElement.classList.contains('dark');
    const bgColor = isDark ? '#0a0b0d' : '#ffffff';
    const textColor = isDark ? '#ffffff' : '#1a1a1a';
    const gridColor = isDark ? '#2c2d30' : '#e6e9ed';

    // Create chart
    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: chartContainerRef.current.clientHeight || 300,
      layout: { background: { color: bgColor }, textColor },
      grid: { vertLines: { color: gridColor }, horzLines: { color: gridColor } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: gridColor, timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;

    // Add candlestick series
    candlestickSeriesRef.current = chart.addCandlestickSeries({
      upColor: '#00c805',
      downColor: '#ff5000',
      borderDownColor: '#ff5000',
      borderUpColor: '#00c805',
      wickDownColor: '#ff5000',
      wickUpColor: '#00c805',
    });

    // Add volume series
    volumeSeriesRef.current = chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });

    // Add EMA and Bollinger Bands series
    emaShortRef.current = chart.addLineSeries({ color: '#1976d2', lineWidth: 2, priceLineVisible: false });
    emaLongRef.current = chart.addLineSeries({ color: '#9c27b0', lineWidth: 2, priceLineVisible: false });
    bbUpperRef.current = chart.addLineSeries({ color: '#ff9800', lineWidth: 1, priceLineVisible: false });
    bbLowerRef.current = chart.addLineSeries({ color: '#ff9800', lineWidth: 1, priceLineVisible: false });
    bbMiddleRef.current = chart.addLineSeries({ color: '#00bcd4', lineWidth: 1, priceLineVisible: false });

    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });


    fetchData();

    // Cleanup chart on unmount is handled in the main chart useEffect above
  }, [symbol, timeframe, showEma, showBbands, useConservativeEma]);

  // Poll for latest price and signals every 2 seconds (must be at top level, not inside another useEffect)
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      fetchData();
      // Fetch real buy/sell markers from backend with auth token
      const token = localStorage.getItem('token');
      fetch(`${API_BASE_URL}/api/signals/historical/${symbol}?shortPeriod=5&longPeriod=15&interval=${timeframe}`,
        token ? { headers: { Authorization: `Bearer ${token}` } } : undefined
      )
        .then(res => res.ok ? res.json() : [])
        .then((markers) => {
          if (candlestickSeriesRef.current) {
            candlestickSeriesRef.current.setMarkers(markers);
          }
        })
        .catch(() => {});
    }, 2000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [symbol, timeframe, showEma, showBbands, useConservativeEma]);
  // ...existing code...

  const toggleFullscreen = () => {
    if (!fullscreenContainerRef.current) return;
    if (!isFullscreen) {
      // Try native fullscreen first
      try {
        if (fullscreenContainerRef.current.requestFullscreen) {
          fullscreenContainerRef.current.requestFullscreen();
          return;
        }
        // Some browsers expose webkitRequestFullscreen
        if ((fullscreenContainerRef.current as any).webkitRequestFullscreen) {
          (fullscreenContainerRef.current as any).webkitRequestFullscreen();
          return;
        }
      } catch (err) {
        // fall through to fallback
      }

      // Fallback for browsers (notably older iOS Safari) where requestFullscreen isn't available
      setForceFullscreen(true);
      setIsFullscreen(true);
      // prevent body scroll in fallback mode
      try { document.body.style.overflow = 'hidden'; } catch (e) {}
    } else {
      // If we used the fallback mode, clear it
      if (forceFullscreen) {
        setForceFullscreen(false);
        setIsFullscreen(false);
        try { document.body.style.overflow = ''; } catch (e) {}
        return;
      }

      // Try to exit native fullscreen
      try {
        if (document.exitFullscreen) {
          document.exitFullscreen();
          return;
        }
        if ((document as any).webkitExitFullscreen) {
          (document as any).webkitExitFullscreen();
          return;
        }
      } catch (err) {
        // fallback: ensure state cleared
        setForceFullscreen(false);
        setIsFullscreen(false);
        try { document.body.style.overflow = ''; } catch (e) {}
      }
    }
  };

  useEffect(() => {
    addDebugLog('[CandlestickChart] symbol:', symbol);
    addDebugLog('[CandlestickChart] window.innerWidth:', window.innerWidth, 'window.innerHeight:', window.innerHeight);
    if (chartContainerRef.current) {
      addDebugLog('[CandlestickChart] chartContainerRef size:', chartContainerRef.current.clientWidth, chartContainerRef.current.clientHeight);
    }
  }, [symbol]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      const fsElement = (document as any).fullscreenElement || (document as any).webkitFullscreenElement;
      setIsFullscreen(!!fsElement);
      // If native fullscreen ended, clear fallback state too
      if (!fsElement && forceFullscreen) {
        setForceFullscreen(false);
        try { document.body.style.overflow = ''; } catch (e) {}
      }
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    // webkit-specific event for Safari/iOS
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange as any);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange as any);
    };
  }, []);

  // Resize chart after entering/exiting fullscreen (native or fallback)
  useEffect(() => {
    const resizeChart = () => {
      if (chartRef.current && chartContainerRef.current) {
        try {
          chartRef.current.resize(chartContainerRef.current.clientWidth, chartContainerRef.current.clientHeight);
        } catch (e) {
          // chart may not expose resize in older versions, fallback to dispatching resize
          window.dispatchEvent(new Event('resize'));
        }
      }
    };
    // Small timeout to allow DOM/CSS to settle
    const t = setTimeout(resizeChart, 120);
    return () => clearTimeout(t);
  }, [isFullscreen, forceFullscreen]);

  // ...chart logic and data fetching would go here...

  return (
  <div ref={fullscreenContainerRef} className={`relative ${isFullscreen ? (forceFullscreen ? 'fixed top-0 left-0 w-screen h-screen z-[9999] bg-white dark:bg-gray-900' : 'bg-white h-screen w-screen') : 'h-[500px] sm:h-[500px] h-[300px] w-full min-h-[300px]'}`}>
      <div ref={chartContainerRef} className="h-full w-full min-h-[300px] bg-gray-100 dark:bg-gray-900" />
      {/* Controls Panel - Left Side, stack vertically on mobile */}
      <div className="absolute top-2 left-2 z-10 bg-white dark:bg-gray-800 p-2 rounded shadow flex flex-col space-y-2 w-40 sm:w-48">
        <label className="flex items-center space-x-2 cursor-pointer text-xs sm:text-sm">
          <input
            type="checkbox"
            checked={showEma}
            onChange={() => setShowEma(!showEma)}
            className="form-checkbox h-4 w-4 sm:h-5 sm:w-5 text-blue-600 rounded"
          />
          <span className="font-medium text-gray-700 dark:text-gray-300">Show EMA</span>
        </label>
        <label className="flex items-center space-x-2 cursor-pointer text-xs sm:text-sm">
          <input
            type="checkbox"
            checked={showBbands}
            onChange={() => setShowBbands(!showBbands)}
            className="form-checkbox h-4 w-4 sm:h-5 sm:w-5 text-green-600 rounded"
          />
          <span className="font-medium text-gray-700 dark:text-gray-300">Show Bollinger Bands</span>
        </label>
        <label className="flex items-center space-x-2 cursor-pointer text-xs sm:text-sm">
          <input
            type="checkbox"
            checked={useConservativeEma}
            onChange={() => setUseConservativeEma(!useConservativeEma)}
            className="form-checkbox h-4 w-4 sm:h-5 sm:w-5 text-purple-600 rounded"
          />
          <span className="font-medium text-gray-700 dark:text-gray-300">
            EMA {useConservativeEma ? '9/20' : '5/15'}
          </span>
        </label>
      </div>
      {/* Timeframe Selector - Bottom Left */}
      <div className="absolute bottom-2 left-2 z-10 bg-white dark:bg-gray-800 p-2 rounded shadow flex flex-wrap gap-1">
        <button
          onClick={() => setTimeframe('1d')}
          className={`px-2 sm:px-3 py-1 rounded text-xs sm:text-sm font-semibold transition-colors ${
            timeframe === '1d'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          Daily
        </button>
        <button
          onClick={() => setTimeframe('1wk')}
          className={`px-2 sm:px-3 py-1 rounded text-xs sm:text-sm font-semibold transition-colors ${
            timeframe === '1wk'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          Weekly
        </button>
        <button
          onClick={() => setTimeframe('1mo')}
          className={`px-2 sm:px-3 py-1 rounded text-xs sm:text-sm font-semibold transition-colors ${
            timeframe === '1mo'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          Monthly
        </button>
        <button
          onClick={() => setTimeframe('all')}
          className={`px-2 sm:px-3 py-1 rounded text-xs sm:text-sm font-semibold transition-colors ${
            timeframe === 'all'
              ? 'bg-blue-600 text-white'
              : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
          }`}
        >
          All
        </button>
      </div>
      {/* Fullscreen Button - Right Side */}
      <button
        onClick={toggleFullscreen}
        className="absolute top-2 right-2 z-10 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg shadow-lg transition-colors flex items-center space-x-2"
        title={isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen'}
      >
        <span className="text-lg">{isFullscreen ? '🗙' : '⛶'}</span>
        <span className="text-sm">{isFullscreen ? 'Exit' : 'Fullscreen'}</span>
      </button>
      {forceFullscreen && (
        <button
          onClick={toggleFullscreen}
          className="fixed bottom-4 right-4 z-[10000] bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-4 rounded-full shadow-lg transition-colors"
          style={{fontSize: '16px'}}
        >
          Exit Fullscreen
        </button>
      )}
    </div>
  );
};

export default CandlestickChart;