'use client';
import React, { useEffect, useRef, useState } from 'react';
import { getApiBaseUrl } from '../config';
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
  isExtendedHours?: boolean;
}

interface CandlestickChartProps {
  symbol: string;
}

const CandlestickChart: React.FC<CandlestickChartProps> = ({ symbol }) => {
  // Fetch price data and update chart
  const fetchData = async () => {
    try {
      setChartStatus('Fetching data...');
      addDebugLog('[CandlestickChart] Fetching price data for', symbol);
      // Use 1-minute candles for live charting; fallback to 5m or 1d if empty
      const tryIntervals = ['1m', '5m', '1d'];
      let priceData: ChartData[] = [];
      for (const interval of tryIntervals) {
        const url = `${getApiBaseUrl()}/api/stocks/${symbol}?interval=${interval}&includePrePost=true`;
        addDebugLog('[CandlestickChart] Trying interval:', interval, url);
        const res = await fetch(url);
        if (!res.ok) {
          addDebugLog('[CandlestickChart] Interval fetch failed:', interval, res.status);
          continue;
        }
        const data = await res.json();
        if (Array.isArray(data) && data.length > 10) {
          // Validate and clean data
          const validData = data.filter(d => 
            d && 
            typeof d.time === 'number' && 
            typeof d.open === 'number' && 
            typeof d.high === 'number' && 
            typeof d.low === 'number' && 
            typeof d.close === 'number' &&
            !isNaN(d.time) && 
            !isNaN(d.open) && 
            !isNaN(d.high) && 
            !isNaN(d.low) && 
            !isNaN(d.close)
          );
          
          if (validData.length > 10) {
            priceData = validData;
            setActiveInterval(interval);
            setDataPoints(validData.length);
            addDebugLog('[CandlestickChart] Using interval:', interval, 'points:', validData.length, 'filtered from:', data.length);
            break;
          } else {
            addDebugLog('[CandlestickChart] Interval returned invalid data after filtering:', interval, 'valid:', validData.length, 'total:', data.length);
          }
        } else {
          addDebugLog('[CandlestickChart] Interval returned insufficient data:', interval, data.length || 0);
        }
      }
      addDebugLog('[CandlestickChart] priceData length:', priceData.length);
      addDebugLog('[CandlestickChart] candlestickSeriesRef.current exists:', !!candlestickSeriesRef.current);
      addDebugLog('[CandlestickChart] volumeSeriesRef.current exists:', !!volumeSeriesRef.current);

      if (priceData.length > 0 && candlestickSeriesRef.current && volumeSeriesRef.current) {
        try {
          setChartStatus('Rendering chart...');
          candlestickSeriesRef.current.setData(priceData);
          addDebugLog('[CandlestickChart] Candlestick data set successfully');
          
          // Extract latest price info for header
          const latest = priceData[priceData.length - 1];
          const previous = priceData[priceData.length - 2];
          const change = latest.close - (previous?.close || latest.open);
          const changePercent = ((change / (previous?.close || latest.open)) * 100);
          setStockInfo({
            price: latest.close,
            open: latest.open,
            high: latest.high,
            low: latest.low,
            close: latest.close,
            volume: latest.volume,
            change: change,
            changePercent: changePercent
          });

          // Volume bars colored green (up) or red (down) based on candle direction
          const volumeData = priceData.map(d => ({
            time: d.time,
            value: d.volume || 0, // Ensure volume is never undefined
            color: d.close >= d.open ? '#26a69a' : '#ef5350',
          }));
          volumeSeriesRef.current.setData(volumeData);
          addDebugLog('[CandlestickChart] Volume data set successfully');
          
          // Set visible range to show last ~100 bars (optimal for visibility - about 5 seconds of scrolling)
          if (chartRef.current && priceData.length > 0) {
            const barsToShow = Math.min(100, priceData.length);
            const lastIndex = priceData.length - 1;
            const startIndex = Math.max(0, lastIndex - barsToShow + 1);
            chartRef.current.timeScale().setVisibleLogicalRange({
              from: startIndex,
              to: lastIndex
            });
            addDebugLog('[CandlestickChart] Set visible range:', startIndex, 'to', lastIndex, '(', barsToShow, 'bars)');
          }
          setChartStatus('Ready');
          
          // Markers disabled - clutters the chart view
          // setTimeout(() => fetchMarkers(), 200);
        } catch (err) {
          addDebugLog('[CandlestickChart] Error setting chart data:', err);
          setChartStatus(`Error: ${err}`);
        }

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
        setChartStatus('No data available');
      }
    } catch (error) {
      addDebugLog('[CandlestickChart] Error fetching chart data:', error && error.message ? error.message : error);
      setChartStatus(`Fetch error: ${error}`);
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
  const [useEnhancedSignals, setUseEnhancedSignals] = useState(true);
  const [timeframe, setTimeframe] = useState<'1d' | '1wk' | '1mo' | 'all'>('1d');
  const [activeInterval, setActiveInterval] = useState<string>('');
  const [dataPoints, setDataPoints] = useState<number>(0);
  const [chartStatus, setChartStatus] = useState<string>('Initializing...');
  const [stockInfo, setStockInfo] = useState<{
    price: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    change: number;
    changePercent: number;
  } | null>(null);

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
    const bgColor = isDark ? '#0f1419' : '#f8f9fa';
    const textColor = isDark ? '#e0e0e0' : '#1a1a1a';
    const gridColor = isDark ? '#1e2633' : '#d1d5db';

    // Create chart with enhanced visuals
    const containerWidth = chartContainerRef.current.clientWidth || 800;
    const containerHeight = chartContainerRef.current.clientHeight || 500;
    // Responsive settings for mobile - enhanced
    const isMobile = containerWidth < 640;
    const chart = createChart(chartContainerRef.current, {
      width: containerWidth,
      height: containerHeight,
      layout: { 
        background: { color: bgColor }, 
        textColor,
        fontSize: isMobile ? 12 : 13,
        fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      },
      grid: { 
        vertLines: { color: gridColor, style: 1, visible: true }, 
        horzLines: { color: gridColor, style: 1, visible: true } 
      },
      crosshair: { 
        mode: CrosshairMode.Normal,
        vertLine: {
          color: isDark ? '#60a5fa' : '#3b82f6',
          width: isMobile ? 1 : 1,
          style: 3,
          labelBackgroundColor: isDark ? '#1e40af' : '#2563eb',
          labelVisible: true,
        },
        horzLine: {
          color: isDark ? '#60a5fa' : '#3b82f6',
          width: isMobile ? 1 : 1,
          style: 3,
          labelBackgroundColor: isDark ? '#1e40af' : '#2563eb',
          labelVisible: true,
        },
      },
      timeScale: { 
        borderColor: gridColor, 
        timeVisible: true, 
        secondsVisible: !isMobile,
        rightOffset: isMobile ? 10 : 12,
        barSpacing: isMobile ? 8 : 10,
        fixLeftEdge: false,
        fixRightEdge: true,
        minimumHeight: isMobile ? 50 : 40,
        visible: true,
        borderVisible: true,
      },
      rightPriceScale: {
        borderColor: gridColor,
        scaleMargins: {
          top: 0.08,
          bottom: 0.15,
        },
        visible: true,
        borderVisible: true,
        alignLabels: true,
        minimumWidth: isMobile ? 60 : 70,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
        axisDoubleClickReset: true,
      },
    });
    chartRef.current = chart;

    // Add candlestick series with enhanced colors for mobile visibility
    candlestickSeriesRef.current = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderDownColor: '#dc2626',
      borderUpColor: '#16a34a',
      wickDownColor: '#b91c1c',
      wickUpColor: '#15803d',
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
      priceLineVisible: false,
      lastValueVisible: true,
    });

    // Add volume series
    volumeSeriesRef.current = chart.addHistogramSeries({
      color: '#26a69a',
      priceFormat: { type: 'volume' },
      priceScaleId: '',
    });

    // Add EMA series with enhanced 3D-like styling
    emaShortRef.current = chart.addLineSeries({ 
      color: '#3b82f6', 
      lineWidth: 3, 
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'EMA Short',
    });
    emaLongRef.current = chart.addLineSeries({ 
      color: '#a855f7', 
      lineWidth: 3, 
      priceLineVisible: false,
      lastValueVisible: true,
      title: 'EMA Long',
    });
    bbUpperRef.current = chart.addLineSeries({ color: '#ff9800', lineWidth: 1, priceLineVisible: false });
    bbLowerRef.current = chart.addLineSeries({ color: '#ff9800', lineWidth: 1, priceLineVisible: false });
    bbMiddleRef.current = chart.addLineSeries({ color: '#00bcd4', lineWidth: 1, priceLineVisible: false });

    chart.priceScale('').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });


    // Clear any previous data explicitly before fetching
    candlestickSeriesRef.current?.setData([]);
    volumeSeriesRef.current?.setData([]);
    emaShortRef.current?.setData([]);
    emaLongRef.current?.setData([]);
    bbUpperRef.current?.setData([]);
    bbLowerRef.current?.setData([]);
    bbMiddleRef.current?.setData([]);

    // Delay fetch slightly to ensure chart is fully initialized
    setTimeout(() => fetchData(), 100);

    // Cleanup chart on unmount is handled in the main chart useEffect above
  }, [symbol, timeframe, showEma, showBbands, useConservativeEma]);

  // Fetch and set markers
  const fetchMarkers = async () => {
    try {
      // Use the actual interval that's loaded on the chart, not the timeframe selector
      if (!activeInterval) {
        console.warn('[CandlestickChart] No active interval yet, skipping marker fetch');
        return;
      }
      
      const token = localStorage.getItem('token');
      const apiUrl = getApiBaseUrl();
      
      // Choose API endpoint based on signal type
      let url;
      if (useEnhancedSignals) {
        url = `${apiUrl}/api/enhanced-signals/${symbol}?interval=${activeInterval}&minConfluence=3`;
      } else {
        url = `${apiUrl}/api/signals/historical/${symbol}?shortPeriod=5&longPeriod=15&interval=${activeInterval}`;
      }
      
      console.log('[CandlestickChart] Fetching', useEnhancedSignals ? 'ENHANCED' : 'BASIC', 'markers from:', url);
      addDebugLog('[CandlestickChart] Fetching markers from:', url);
      
      const response = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
      
      if (!response.ok) {
        console.error('[CandlestickChart] Markers fetch failed:', response.status);
        addDebugLog('[CandlestickChart] Markers fetch failed:', response.status);
        return;
      }
      
      const data = await response.json();
      console.log('[CandlestickChart] Markers response:', data);
      addDebugLog('[CandlestickChart] Markers response:', data);
      
      // Handle enhanced signals response format
      let markers = [];
      if (useEnhancedSignals && data.signals) {
        // Enhanced signals format
        markers = data.signals;
      } else if (Array.isArray(data)) {
        // Basic signals format
        markers = data;
      } else if (data.value) {
        markers = data.value;
      }
      
      console.log('[CandlestickChart] Parsed markers array:', markers);
      
      if (markers.length > 0 && candlestickSeriesRef.current) {
        // Convert marker shapes and customize text labels with price
        const processedMarkers = markers.map((m: any) => {
          const isBuy = m.type === 'BUY' || m.shape === 'arrowUp' || m.text?.toLowerCase().includes('buy');
          const isSell = m.type === 'SELL' || m.shape === 'arrowDown' || m.text?.toLowerCase().includes('sell');
          
          // Extract confidence and price from the marker data
          const confidence = m.confidence || '';
          const confluenceScore = m.confluenceScore || '';
          const price = m.price || m.close || '';
          
          // Create prominent label with price and confidence
          let label = isBuy ? '🔼 BUY' : '🔽 SELL';
          
          // Add price if available
          if (price) {
            label += ` $${typeof price === 'number' ? price.toFixed(2) : price}`;
          }
          
          // Add confidence percentage
          if (useEnhancedSignals && confluenceScore) {
            label += ` (${confidence}%)`;
          } else if (confidence) {
            label += ` (${confidence}%)`;
          }
          
          console.log('[CandlestickChart] Processing marker:', { original: m, isBuy, isSell, label, price });
          
          return {
            time: m.time,
            position: isBuy ? 'belowBar' : 'aboveBar',  // BUY below, SELL above for clarity
            color: isBuy ? '#00E676' : '#FF1744',  // Bright green for buy, bright red for sell
            shape: isBuy ? 'arrowUp' : 'arrowDown',  // Use arrows for clear direction
            text: label
          };
        });
        
        console.log('[CandlestickChart] Setting', processedMarkers.length, 'markers on chart');
        console.log('[CandlestickChart] Processed markers:', JSON.stringify(processedMarkers, null, 2));
        addDebugLog('[CandlestickChart] Setting', processedMarkers.length, 'markers:', processedMarkers);
        candlestickSeriesRef.current.setMarkers(processedMarkers);
        console.log('[CandlestickChart] Markers set successfully! Total markers on series:', processedMarkers.length);
      } else {
        console.warn('[CandlestickChart] No markers to set. markers.length:', markers.length, 'series ready:', !!candlestickSeriesRef.current);
        addDebugLog('[CandlestickChart] No markers to set or series not ready');
      }
    } catch (error) {
      console.error('[CandlestickChart] Error fetching markers:', error);
      addDebugLog('[CandlestickChart] Error fetching markers:', error);
    }
  };

  // Trading signal markers with price and confidence
  useEffect(() => {
    // Fetch markers with retry logic to ensure chart is ready
    let attempts = 0;
    const maxAttempts = 5;
    
    const tryFetchMarkers = () => {
      attempts++;
      console.log(`[CandlestickChart] Attempt ${attempts} to fetch markers. Series ready:`, !!candlestickSeriesRef.current);
      
      if (candlestickSeriesRef.current) {
        fetchMarkers();
      } else if (attempts < maxAttempts) {
        console.log(`[CandlestickChart] Series not ready, retrying in 500ms...`);
        setTimeout(tryFetchMarkers, 500);
      } else {
        console.error('[CandlestickChart] Failed to fetch markers after', maxAttempts, 'attempts');
      }
    };
    
    const timer = setTimeout(tryFetchMarkers, 1000);
    
    return () => clearTimeout(timer);
  }, [symbol, timeframe, useEnhancedSignals]);
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
    <div ref={fullscreenContainerRef} className={`relative ${isFullscreen ? (forceFullscreen ? 'fixed top-0 left-0 w-screen h-screen z-[9999] bg-gray-900' : 'bg-gray-900 h-screen w-screen') : 'h-[600px] sm:h-[700px] lg:h-[800px] w-full min-h-[500px]'}`}>
      
      {/* Professional Stock Info - TradingView Style */}
      {stockInfo && (
        <div className="absolute top-2 left-2 sm:left-2 z-20 bg-white/95 backdrop-blur-sm rounded-md px-2.5 py-1.5 shadow-md border border-gray-200">
          <div className="flex items-baseline gap-2 text-xs sm:text-sm">
            <span className="font-bold text-gray-900">{symbol}</span>
            <span className="font-bold text-gray-900">${stockInfo.price.toFixed(2)}</span>
            <span className={`font-semibold px-1.5 py-0.5 rounded text-[10px] sm:text-xs ${
              stockInfo.change >= 0 
                ? 'text-green-700 bg-green-100' 
                : 'text-red-700 bg-red-100'
            }`}>
              {stockInfo.change >= 0 ? '▲' : '▼'} {Math.abs(stockInfo.changePercent).toFixed(2)}%
            </span>
          </div>
        </div>
      )}
      
      {/* OHLC Info Bar - Below symbol, TradingView style */}
      {stockInfo && (
        <div className="absolute top-11 sm:top-12 left-2 sm:left-2 z-20 bg-white/90 backdrop-blur-sm rounded-md px-2.5 py-1 shadow-sm border border-gray-200">
          <div className="flex gap-3 text-[10px] sm:text-xs text-gray-700">
            <span>O: <span className="font-semibold text-gray-900">{stockInfo.open.toFixed(2)}</span></span>
            <span>H: <span className="font-semibold text-green-600">{stockInfo.high.toFixed(2)}</span></span>
            <span>L: <span className="font-semibold text-red-600">{stockInfo.low.toFixed(2)}</span></span>
            <span>C: <span className="font-semibold text-gray-900">{stockInfo.close.toFixed(2)}</span></span>
            <span className="hidden sm:inline">V: <span className="font-semibold text-blue-600">{(stockInfo.volume / 1000000).toFixed(2)}M</span></span>
          </div>
        </div>
      )}
      
      {/* Enhanced Chart Container with 3D depth effect */}
      <div className="absolute top-0 left-0 right-0 bottom-0 rounded-lg overflow-hidden shadow-2xl">
        <div ref={chartContainerRef} className="h-full w-full bg-gradient-to-br from-gray-900 to-black" 
             style={{boxShadow: 'inset 0 2px 10px rgba(0,0,0,0.3)'}} />
      </div>
      
      {/* Bottom Control Bar - Ultra-compact mobile style */}
      <div className="absolute bottom-16 sm:bottom-14 left-2 z-10 bg-gray-900/85 backdrop-blur-sm rounded shadow-sm border border-gray-700/30 flex items-center gap-0.5 px-1 py-0.5">
        {/* Refresh Button - Minimal */}
        <button
          onClick={() => { fetchData(); fetchMarkers(); }}
          className="p-1 bg-green-600 hover:bg-green-700 text-white rounded transition-all text-[10px] leading-none"
          title="Refresh"
        >
          🔄
        </button>
        
        <div className="h-3.5 w-px bg-gray-600/50"></div>
        
        {/* Indicator Toggles - Minimal checkboxes */}
        <label className="flex items-center gap-0.5 px-0.5 py-0.5 cursor-pointer hover:bg-gray-800/50 rounded" title="EMA">
          <input type="checkbox" checked={showEma} onChange={() => setShowEma(!showEma)} className="w-2.5 h-2.5 text-blue-500 rounded" />
          <span className="text-[8px] leading-none">📈</span>
        </label>
        
        <label className="flex items-center gap-0.5 px-0.5 py-0.5 cursor-pointer hover:bg-gray-800/50 rounded" title="BB">
          <input type="checkbox" checked={showBbands} onChange={() => setShowBbands(!showBbands)} className="w-2.5 h-2.5 text-green-500 rounded" />
          <span className="text-[8px] leading-none">📊</span>
        </label>
        
        <label className="flex items-center gap-0.5 px-0.5 py-0.5 cursor-pointer hover:bg-gray-800/50 rounded" title={useConservativeEma ? '9/20' : '5/15'}>
          <input type="checkbox" checked={useConservativeEma} onChange={() => setUseConservativeEma(!useConservativeEma)} className="w-2.5 h-2.5 text-purple-500 rounded" />
          <span className="text-[7px] font-bold text-white leading-none">{useConservativeEma ? '9/20' : '5/15'}</span>
        </label>
        
        <label className="flex items-center gap-0.5 px-0.5 py-0.5 cursor-pointer hover:bg-gray-800/50 rounded" title="Signals">
          <input type="checkbox" checked={useEnhancedSignals} onChange={() => setUseEnhancedSignals(!useEnhancedSignals)} className="w-2.5 h-2.5 text-indigo-500 rounded" />
          <span className="text-[8px] leading-none">{useEnhancedSignals ? '🎯' : '📍'}</span>
        </label>
        
        <div className="h-3.5 w-px bg-gray-600/50"></div>
        
        {/* Fullscreen - Minimal */}
        <button
          onClick={toggleFullscreen}
          className="p-1 bg-blue-600 hover:bg-blue-700 text-white rounded transition-all text-[10px] leading-none"
          title="Full"
        >
          ⛶
        </button>
      </div>
      
      {/* Timeframe Selector - Compact mobile style */}
      <div className="absolute top-2 right-2 sm:right-14 z-20 bg-gray-900/90 backdrop-blur-sm rounded shadow-sm border border-gray-700/50 flex">
        <button
          onClick={() => setTimeframe('1d')}
          className={`px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-bold transition-all first:rounded-l ${
            timeframe === '1d'
              ? 'bg-blue-600 text-white'
              : 'bg-transparent text-gray-300 hover:text-white hover:bg-gray-800'
          }`}
        >
          1D
        </button>
        <button
          onClick={() => setTimeframe('1wk')}
          className={`px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-bold transition-all ${
            timeframe === '1wk'
              ? 'bg-blue-600 text-white'
              : 'bg-transparent text-gray-300 hover:text-white hover:bg-gray-800'
          }`}
        >
          1W
        </button>
        <button
          onClick={() => setTimeframe('1mo')}
          className={`px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-bold transition-all ${
            timeframe === '1mo'
              ? 'bg-blue-600 text-white'
              : 'bg-transparent text-gray-300 hover:text-white hover:bg-gray-800'
          }`}
        >
          1M
        </button>
        <button
          onClick={() => setTimeframe('all')}
          className={`px-2 sm:px-3 py-1 text-[10px] sm:text-xs font-bold transition-all last:rounded-r ${
            timeframe === 'all'
              ? 'bg-blue-600 text-white'
              : 'bg-transparent text-gray-300 hover:text-white hover:bg-gray-800'
          }`}
        >
          ALL
        </button>
      </div>
      
      {/* Chart Status Indicator - Mobile-friendly positioning */}
      {chartStatus && chartStatus !== 'Ready' && chartStatus !== '' && (
        <div className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 z-30 bg-gradient-to-r from-yellow-500 to-orange-500 text-white px-5 py-3 sm:px-6 sm:py-3 rounded-xl shadow-2xl text-xs sm:text-sm font-bold flex items-center justify-center space-x-2 animate-pulse"
             style={{boxShadow: '0 6px 20px rgba(245, 158, 11, 0.5)'}}>
          <span className="animate-spin text-lg sm:text-xl">⟳</span>
          <span>{chartStatus}</span>
        </div>
      )}
      
      {/* Fullscreen Exit Button - Mobile-friendly */}
      {forceFullscreen && (
        <button
          onClick={toggleFullscreen}
          className="fixed bottom-4 right-4 z-[10000] bg-red-600 hover:bg-red-700 text-white font-bold py-2.5 px-5 sm:py-3 sm:px-6 rounded-full shadow-lg transition-colors touch-manipulation min-h-[44px]"
          style={{fontSize: '14px'}}
        >
          Exit Fullscreen
        </button>
      )}
    </div>
  );
};

export default CandlestickChart;