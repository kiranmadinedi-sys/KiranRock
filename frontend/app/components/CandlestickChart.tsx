'use client';
import React, { useEffect, useRef, useState } from 'react';
import { getApiBaseUrl } from '../config';
import { createChart, IChartApi, ISeriesApi, UTCTimestamp, CrosshairMode, LineStyle } from 'lightweight-charts';

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

type Timeframe = '1d' | '5d' | '1m' | '6m' | 'ytd' | '1y' | '5y' | 'all';

const TIMEFRAME_LABELS: { key: Timeframe; label: string }[] = [
  { key: '1d',  label: '1D'  },
  { key: '5d',  label: '5D'  },
  { key: '1m',  label: '1M'  },
  { key: '6m',  label: '6M'  },
  { key: 'ytd', label: 'YTD' },
  { key: '1y',  label: '1Y'  },
  { key: '5y',  label: '5Y'  },
  { key: 'all', label: 'All' },
];

function filterByTimeframe(data: ChartData[], tf: Timeframe): ChartData[] {
  const nowSec = Date.now() / 1000;
  const ytdStart = new Date(new Date().getFullYear(), 0, 1).getTime() / 1000;
  const cutoffs: Record<Timeframe, number> = {
    '1d':  nowSec - 86400,
    '5d':  nowSec - 5 * 86400,
    '1m':  nowSec - 30 * 86400,
    '6m':  nowSec - 180 * 86400,
    'ytd': ytdStart,
    '1y':  nowSec - 365 * 86400,
    '5y':  nowSec - 5 * 365 * 86400,
    'all': 0,
  };
  const cutoff = cutoffs[tf] ?? 0;
  return cutoff > 0 ? data.filter(d => (d.time as number) >= cutoff) : data;
}

function intervalsForTimeframe(tf: Timeframe): string[] {
  switch (tf) {
    case '1d':  return ['1m', '5m', '1d'];
    case '5d':  return ['5m', '1d'];
    case '1m':  return ['1d'];
    case '6m':  return ['1d'];
    case 'ytd': return ['1d'];
    case '1y':  return ['1d'];
    case '5y':  return ['1wk', '1d'];
    case 'all': return ['1wk', '1d'];
  }
}

interface HoveredBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const CandlestickChart: React.FC<CandlestickChartProps> = ({ symbol }) => {
  // Fetch price data and update chart
  const fetchData = async () => {
    try {
      setChartStatus('Fetching data...');
      addDebugLog('[CandlestickChart] Fetching price data for', symbol);
      // Choose intervals based on selected timeframe
      const tryIntervals = intervalsForTimeframe(timeframe);
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
            // Reject stale intraday data — if the newest candle is older than 3 days,
            // skip to the next interval so we land on fresh daily candles instead.
            const latestTs = (validData[validData.length - 1]?.time as number) ?? 0;
            const threeDaysAgo = Date.now() / 1000 - 3 * 86400;
            if (latestTs < threeDaysAgo && (interval === '1m' || interval === '5m')) {
              addDebugLog('[CandlestickChart] Stale intraday data (', interval, '), skipping to next interval');
              continue;
            }

            const filteredData = filterByTimeframe(validData, timeframe);
            priceData = filteredData.length >= 5 ? filteredData : validData;
            setActiveInterval(interval);
            addDebugLog('[CandlestickChart] Using interval:', interval, 'bars:', priceData.length);
            break;
          } else {
            addDebugLog('[CandlestickChart] Insufficient data for interval:', interval, validData.length);
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
          
          // Extract latest candle info for header (O/H/L/C/V stay from candle)
          const latest = priceData[priceData.length - 1];
          const previous = priceData[priceData.length - 2];
          const candleChange = latest.close - (previous?.close || latest.open);
          const candleChangePct = ((candleChange / (previous?.close || latest.open)) * 100);
          setStockInfo({
            price: latest.close,
            open: latest.open,
            high: latest.high,
            low: latest.low,
            close: latest.close,
            volume: latest.volume,
            change: candleChange,
            changePercent: candleChangePct
          });

          // Fetch live price to fix stale-cache label (candle close ≠ current price)
          try {
            const liveToken = localStorage.getItem('token');
            const liveRes = await fetch(
              `${getApiBaseUrl()}/api/stocks/price/${symbol}`,
              liveToken ? { headers: { Authorization: `Bearer ${liveToken}` } } : {}
            );
            if (liveRes.ok) {
              const liveData = await liveRes.json();
              const livePrice = liveData?.price ?? liveData?.currentPrice ?? null;
              if (livePrice && livePrice > 0) {
                const liveChange = livePrice - (previous?.close || latest.open);
                const liveChangePct = (liveChange / (previous?.close || latest.open)) * 100;
                setStockInfo(prev => prev ? {
                  ...prev,
                  price: livePrice,
                  change: liveChange,
                  changePercent: liveChangePct
                } : prev);
                // Dashed horizontal line at live price (Google Finance style)
                if (candlestickSeriesRef.current) {
                  candlestickSeriesRef.current.createPriceLine({
                    price: livePrice,
                    color: liveChange >= 0 ? '#16a34a' : '#dc2626',
                    lineWidth: 1,
                    lineStyle: LineStyle.Dashed,
                    axisLabelVisible: true,
                    title: '',
                  });
                }
              }
            }
          } catch {
            // Live price fetch failed — keep candle close price, no UI impact
          }

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
  const [timeframe, setTimeframe] = useState<Timeframe>('1d');
  const [activeInterval, setActiveInterval] = useState<string>('');
  const [hoveredBar, setHoveredBar] = useState<HoveredBar | null>(null);
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

    const bgColor = '#ffffff';
    const textColor = '#374151';
    const gridColor = '#f3f4f6';

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
          color: '#3b82f6',
          width: 1,
          style: 3,
          labelBackgroundColor: '#2563eb',
          labelVisible: true,
        },
        horzLine: {
          color: '#3b82f6',
          width: 1,
          style: 3,
          labelBackgroundColor: '#2563eb',
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
      lastValueVisible: false,
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

    // OHLCV hover tooltip — updates React state on crosshair move
    chart.subscribeCrosshairMove(param => {
      if (!param.time || !param.seriesData || !candlestickSeriesRef.current) {
        setHoveredBar(null);
        return;
      }
      const bar = param.seriesData.get(candlestickSeriesRef.current) as any;
      const volBar = volumeSeriesRef.current ? param.seriesData.get(volumeSeriesRef.current) as any : null;
      if (bar?.open != null) {
        const ts = typeof param.time === 'number' ? param.time * 1000 : Date.now();
        setHoveredBar({
          date: new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          open:   bar.open,
          high:   bar.high,
          low:    bar.low,
          close:  bar.close,
          volume: volBar?.value ?? 0,
        });
      } else {
        setHoveredBar(null);
      }
    });


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
            color: isBuy ? '#00A651' : '#FF1744',  // Dark green for buy (more readable), bright red for sell
            shape: isBuy ? 'arrowUp' : 'arrowDown',  // Use arrows for clear direction
            text: label
          };
        });
        
        console.log('[CandlestickChart] Setting', processedMarkers.length, 'markers on chart');
        console.log('[CandlestickChart] Processed markers:', JSON.stringify(processedMarkers, null, 2));
        addDebugLog('[CandlestickChart] Setting', processedMarkers.length, 'markers:', processedMarkers);
        candlestickSeriesRef.current.setMarkers(processedMarkers as any);
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

  const isUp = (stockInfo?.change ?? 0) >= 0;
  const priceColor = isUp ? 'text-green-600' : 'text-red-600';

  return (
    <div
      ref={fullscreenContainerRef}
      className={`flex flex-col bg-white border border-gray-200 rounded-lg shadow-sm overflow-hidden ${
        isFullscreen
          ? forceFullscreen
            ? 'fixed top-0 left-0 w-screen h-screen z-[9999]'
            : 'h-screen w-screen'
          : 'w-full'
      }`}
    >
      {/* ── Google Finance-style header ─────────────────────── */}
      <div className="px-4 pt-4 pb-2 border-b border-gray-100">
        {stockInfo ? (
          <>
            <div className="flex items-baseline gap-3 flex-wrap">
              <span className="text-3xl font-bold text-gray-900">
                ${stockInfo.price.toFixed(2)}
              </span>
              <span className={`text-base font-semibold ${priceColor}`}>
                {isUp ? '+' : ''}{stockInfo.change.toFixed(2)}&nbsp;
                ({isUp ? '+' : ''}{stockInfo.changePercent.toFixed(2)}%)
              </span>
            </div>
            {/* Static OHLCV row — updates to hovered bar when mouse is on chart */}
            <div className="flex gap-4 mt-1 text-xs text-gray-500">
              {hoveredBar ? (
                <>
                  <span className="text-gray-400">{hoveredBar.date}</span>
                  <span>O <span className="text-gray-700 font-medium">{hoveredBar.open.toFixed(2)}</span></span>
                  <span>H <span className="text-green-600 font-medium">{hoveredBar.high.toFixed(2)}</span></span>
                  <span>L <span className="text-red-600 font-medium">{hoveredBar.low.toFixed(2)}</span></span>
                  <span>C <span className="text-gray-700 font-medium">{hoveredBar.close.toFixed(2)}</span></span>
                  <span className="hidden sm:inline">Vol <span className="text-blue-600 font-medium">
                    {hoveredBar.volume >= 1_000_000
                      ? `${(hoveredBar.volume / 1_000_000).toFixed(2)}M`
                      : `${(hoveredBar.volume / 1_000).toFixed(0)}K`}
                  </span></span>
                </>
              ) : (
                <>
                  <span>O <span className="text-gray-700 font-medium">{stockInfo.open.toFixed(2)}</span></span>
                  <span>H <span className="text-green-600 font-medium">{stockInfo.high.toFixed(2)}</span></span>
                  <span>L <span className="text-red-600 font-medium">{stockInfo.low.toFixed(2)}</span></span>
                  <span>C <span className="text-gray-700 font-medium">{stockInfo.close.toFixed(2)}</span></span>
                  <span className="hidden sm:inline">Vol <span className="text-blue-600 font-medium">
                    {stockInfo.volume >= 1_000_000
                      ? `${(stockInfo.volume / 1_000_000).toFixed(2)}M`
                      : `${(stockInfo.volume / 1_000).toFixed(0)}K`}
                  </span></span>
                </>
              )}
            </div>
          </>
        ) : (
          <div className="h-10 flex items-center text-gray-400 text-sm">Loading {symbol}…</div>
        )}
      </div>

      {/* ── Timeframe tabs ───────────────────────────────────── */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-gray-100 bg-gray-50">
        <div className="flex gap-0.5">
          {TIMEFRAME_LABELS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTimeframe(key)}
              className={`px-2.5 py-1 text-xs font-semibold rounded transition-all ${
                timeframe === key
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Indicator + controls row */}
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input type="checkbox" checked={showEma} onChange={() => setShowEma(!showEma)}
              className="w-3 h-3 rounded text-blue-500" />
            <span>EMA</span>
          </label>
          {showEma && (
            <label className="flex items-center gap-1 cursor-pointer select-none text-gray-400">
              <input type="checkbox" checked={useConservativeEma} onChange={() => setUseConservativeEma(!useConservativeEma)}
                className="w-3 h-3 rounded text-blue-400" />
              <span>{useConservativeEma ? '9/20' : '5/15'}</span>
            </label>
          )}
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input type="checkbox" checked={showBbands} onChange={() => setShowBbands(!showBbands)}
              className="w-3 h-3 rounded text-purple-500" />
            <span>BB</span>
          </label>
          <label className="flex items-center gap-1 cursor-pointer select-none">
            <input type="checkbox" checked={useEnhancedSignals} onChange={() => setUseEnhancedSignals(!useEnhancedSignals)}
              className="w-3 h-3 rounded text-indigo-500" />
            <span>Signals</span>
          </label>
          <button
            onClick={() => { fetchData(); fetchMarkers(); }}
            className="ml-1 px-2 py-0.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded border border-gray-300 transition-all"
            title="Refresh"
          >↺ Refresh</button>
          <button
            onClick={toggleFullscreen}
            className="px-2 py-0.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded border border-gray-300 transition-all"
            title="Fullscreen"
          >⛶</button>
        </div>
      </div>

      {/* ── Chart area ───────────────────────────────────────── */}
      <div className="relative flex-1 min-h-[400px] sm:min-h-[500px]">
        <div ref={chartContainerRef} className="absolute inset-0" />

        {/* Loading overlay */}
        {chartStatus && chartStatus !== 'Ready' && chartStatus !== '' && (
          <div className="absolute inset-0 flex items-center justify-center z-20 bg-white/70">
            <div className="flex items-center gap-2 bg-white border border-gray-200 rounded-lg px-4 py-3 shadow text-sm text-gray-600 font-medium">
              <span className="animate-spin text-blue-500">⟳</span>
              {chartStatus}
            </div>
          </div>
        )}
      </div>

      {/* Fullscreen exit */}
      {forceFullscreen && (
        <button
          onClick={toggleFullscreen}
          className="fixed bottom-4 right-4 z-[10000] bg-blue-600 hover:bg-blue-700 text-white font-bold py-2.5 px-5 rounded-full shadow-lg transition-colors min-h-[44px] text-sm"
        >
          Exit Fullscreen
        </button>
      )}
    </div>
  );
};

export default CandlestickChart;