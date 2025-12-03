const express = require('express');
const router = express.Router();
const { calculateHistoricalEMA, calculateHistoricalBollingerBands, calculateRSI, calculateMACD } = require('../services/indicatorService');
const { getStockData } = require('../services/stockDataService');

// Middleware to disable caching
const noCache = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};

router.get('/ema/:symbol', noCache, async (req, res) => {
    try {
        const { symbol } = req.params;
        const { period = '20', interval = '1d' } = req.query;
        const periodNum = parseInt(period, 10);

        if (isNaN(periodNum) || periodNum <= 0) {
            return res.status(400).json({ message: 'Invalid period specified.' });
        }

        const historicalData = await getStockData(symbol, interval);
        if (!historicalData || historicalData.length === 0) {
            return res.status(404).json({ message: 'Historical data not found.' });
        }

        const emaData = calculateHistoricalEMA(historicalData, 20); // Using a 20-period EMA
        console.log(`[${symbol}] EMA data points: ${emaData.length} (interval: ${interval})`);
        res.json(emaData);
    } catch (error) {
        console.error('Error fetching historical EMA data:', error);
        res.status(500).json({ message: 'Failed to fetch EMA data' });
    }
});

// Endpoint to get historical Bollinger Bands
router.get('/bbands/:symbol', noCache, async (req, res) => {
    try {
        const symbol = req.params.symbol;
        const { interval = '1d' } = req.query;
        
        const historicalData = await getStockData(symbol, interval);
        if (!historicalData || historicalData.length === 0) {
            return res.status(404).json({ message: 'Historical data not found' });
        }
        const bbandsData = calculateHistoricalBollingerBands(historicalData, 20, 2); // 20-period, 2 std dev
        console.log(`[${symbol}] Bollinger Bands data points: upper=${bbandsData.upper.length}, middle=${bbandsData.middle.length}, lower=${bbandsData.lower.length} (interval: ${interval})`);
        res.json(bbandsData);
    } catch (error) {
        console.error('Error fetching historical Bollinger Bands data:', error);
        res.status(500).json({ message: 'Failed to fetch Bollinger Bands data' });
    }
});

// Endpoint to get RSI (Relative Strength Index)
router.get('/rsi/:symbol', noCache, async (req, res) => {
    try {
        const { symbol } = req.params;
        const { period = '14', interval = '1d' } = req.query;
        const periodNum = parseInt(period, 10);

        if (isNaN(periodNum) || periodNum <= 0) {
            return res.status(400).json({ message: 'Invalid period specified.' });
        }

        const historicalData = await getStockData(symbol, interval);
        if (!historicalData || historicalData.length === 0) {
            return res.status(404).json({ message: 'Historical data not found.' });
        }

        const rsiData = calculateRSI(historicalData, periodNum);
        console.log(`[${symbol}] RSI data points: ${rsiData.length} (interval: ${interval})`);
        res.json(rsiData);
    } catch (error) {
        console.error('Error fetching RSI data:', error);
        res.status(500).json({ message: 'Failed to fetch RSI data' });
    }
});

// Endpoint to get MACD (Moving Average Convergence Divergence)
router.get('/macd/:symbol', noCache, async (req, res) => {
    try {
        const { symbol } = req.params;
        const { fast = '12', slow = '26', signal = '9', interval = '1d' } = req.query;
        const fastPeriod = parseInt(fast, 10);
        const slowPeriod = parseInt(slow, 10);
        const signalPeriod = parseInt(signal, 10);

        if (isNaN(fastPeriod) || isNaN(slowPeriod) || isNaN(signalPeriod)) {
            return res.status(400).json({ message: 'Invalid period specified.' });
        }

        const historicalData = await getStockData(symbol, interval);
        if (!historicalData || historicalData.length === 0) {
            return res.status(404).json({ message: 'Historical data not found.' });
        }

        const macdData = calculateMACD(historicalData, fastPeriod, slowPeriod, signalPeriod);
        console.log(`[${symbol}] MACD data points: ${macdData.macd.length} (interval: ${interval})`);
        res.json(macdData);
    } catch (error) {
        console.error('Error fetching MACD data:', error);
        res.status(500).json({ message: 'Failed to fetch MACD data' });
    }
});

module.exports = router;
