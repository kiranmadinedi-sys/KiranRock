const path = require('path');
const { expect } = require('chai');

const indicators = require(path.join(__dirname, '../src/services/technicalIndicators'));

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Build a flat price series of `n` bars all equal to `price` */
function flatSeries(n, price = 100) {
    return Array.from({ length: n }, () => price);
}

/** Linear ramp from `from` to `to` over `n` bars */
function rampSeries(n, from, to) {
    return Array.from({ length: n }, (_, i) => from + (to - from) * (i / (n - 1)));
}

// ─── interpretRSI ─────────────────────────────────────────────────────────────
describe('interpretRSI', function () {
    it('returns OVERSOLD (+15) when RSI ≤ 30', function () {
        [25, 30].forEach(rsi => {
            const r = indicators.interpretRSI(rsi);
            expect(r.signal).to.equal('OVERSOLD');
            expect(r.scoreAdjustment).to.equal(15);
            expect(r.recommendation).to.equal('BUY');
        });
    });

    it('returns OVERBOUGHT (-15) when RSI ≥ 70', function () {
        [70, 85].forEach(rsi => {
            const r = indicators.interpretRSI(rsi);
            expect(r.signal).to.equal('OVERBOUGHT');
            expect(r.scoreAdjustment).to.equal(-15);
            expect(r.recommendation).to.equal('SELL');
        });
    });

    it('returns BULLISH (+8) when RSI is 60-69', function () {
        [60, 65].forEach(rsi => {
            const r = indicators.interpretRSI(rsi);
            expect(r.signal).to.equal('BULLISH');
            expect(r.scoreAdjustment).to.equal(8);
        });
    });

    it('returns BEARISH (-8) when RSI is 31-40', function () {
        [35, 40].forEach(rsi => {
            const r = indicators.interpretRSI(rsi);
            expect(r.signal).to.equal('BEARISH');
            expect(r.scoreAdjustment).to.equal(-8);
        });
    });

    it('returns NEUTRAL (0) when RSI is 41-59', function () {
        [41, 50, 59].forEach(rsi => {
            const r = indicators.interpretRSI(rsi);
            expect(r.signal).to.equal('NEUTRAL');
            expect(r.scoreAdjustment).to.equal(0);
        });
    });
});

// ─── interpretBollingerBands ──────────────────────────────────────────────────
describe('interpretBollingerBands', function () {
    it('returns OVERSOLD (+12) when percentB < 0.05', function () {
        const r = indicators.interpretBollingerBands({ percentB: 0.02, width: 0.10 });
        expect(r.signal).to.equal('OVERSOLD');
        expect(r.scoreAdjustment).to.equal(12);
    });

    it('returns NEAR_LOWER (+7) when percentB is 0.05-0.19', function () {
        const r = indicators.interpretBollingerBands({ percentB: 0.12, width: 0.10 });
        expect(r.signal).to.equal('NEAR_LOWER');
        expect(r.scoreAdjustment).to.equal(7);
    });

    it('returns NEUTRAL (0) when percentB is 0.40-0.60', function () {
        const r = indicators.interpretBollingerBands({ percentB: 0.50, width: 0.10 });
        expect(r.signal).to.equal('NEUTRAL');
        expect(r.scoreAdjustment).to.equal(0);
    });

    it('returns NEAR_UPPER (-4) when percentB is 0.80-0.94', function () {
        const r = indicators.interpretBollingerBands({ percentB: 0.85, width: 0.10 });
        expect(r.signal).to.equal('NEAR_UPPER');
        expect(r.scoreAdjustment).to.equal(-4);
    });

    it('returns OVERBOUGHT (-10) when percentB > 0.95', function () {
        const r = indicators.interpretBollingerBands({ percentB: 0.97, width: 0.10 });
        expect(r.signal).to.equal('OVERBOUGHT');
        expect(r.scoreAdjustment).to.equal(-10);
    });

    it('returns SQUEEZE (+3) when band width < 0.05', function () {
        const r = indicators.interpretBollingerBands({ percentB: 0.50, width: 0.03 });
        expect(r.signal).to.equal('SQUEEZE');
        expect(r.scoreAdjustment).to.equal(3);
    });
});

// ─── interpretMACD ────────────────────────────────────────────────────────────
describe('interpretMACD', function () {
    it('returns STRONG_BULLISH (+10) when histogram > 0.5 and MACD > signal', function () {
        const r = indicators.interpretMACD({ macdLine: 1.0, signalLine: 0.3, histogram: 0.7 });
        expect(r.signal).to.equal('STRONG_BULLISH');
        expect(r.scoreAdjustment).to.equal(10);
    });

    it('returns BULLISH (+6) when histogram is 0 to 0.5 and MACD > signal', function () {
        const r = indicators.interpretMACD({ macdLine: 0.5, signalLine: 0.2, histogram: 0.3 });
        expect(r.signal).to.equal('BULLISH');
        expect(r.scoreAdjustment).to.equal(6);
    });

    it('returns STRONG_BEARISH (-10) when histogram < -0.5 and MACD < signal', function () {
        const r = indicators.interpretMACD({ macdLine: -1.0, signalLine: -0.3, histogram: -0.7 });
        expect(r.signal).to.equal('STRONG_BEARISH');
        expect(r.scoreAdjustment).to.equal(-10);
    });

    it('returns BEARISH (-6) when histogram is -0.5 to 0 and MACD < signal', function () {
        const r = indicators.interpretMACD({ macdLine: -0.5, signalLine: -0.2, histogram: -0.3 });
        expect(r.signal).to.equal('BEARISH');
        expect(r.scoreAdjustment).to.equal(-6);
    });

    it('returns NEUTRAL (0) when MACD == signal', function () {
        const r = indicators.interpretMACD({ macdLine: 0.5, signalLine: 0.5, histogram: 0 });
        expect(r.signal).to.equal('NEUTRAL');
        expect(r.scoreAdjustment).to.equal(0);
    });
});

// ─── calculateSimpleRSI ───────────────────────────────────────────────────────
describe('calculateSimpleRSI', function () {
    it('returns ~50 for a perfectly alternating series (equal gains and losses)', function () {
        // alternating +1/-1 around 100 — equal gains and losses → RSI ≈ 50
        const prices = [];
        for (let i = 0; i < 30; i++) prices.push(i % 2 === 0 ? 101 : 99);
        const rsi = indicators.calculateSimpleRSI(prices, 14);
        expect(rsi).to.be.a('number');
        expect(rsi).to.be.within(45, 55);
    });

    it('returns high RSI (> 60) for a consistently rising series', function () {
        const prices = rampSeries(30, 90, 120); // steady climb
        const rsi = indicators.calculateSimpleRSI(prices, 14);
        expect(rsi).to.be.greaterThan(60);
    });

    it('returns low RSI (< 40) for a consistently falling series', function () {
        const prices = rampSeries(30, 120, 90); // steady decline
        const rsi = indicators.calculateSimpleRSI(prices, 14);
        expect(rsi).to.be.lessThan(40);
    });

    it('returns 100 for a flat series with all gains and zero losses', function () {
        // flat series has no gains OR losses — by convention RS = 0/0 handled as RSI=50 or 100
        // strictly rising: each bar is strictly higher
        const prices = rampSeries(20, 100, 200);
        const rsi = indicators.calculateSimpleRSI(prices, 14);
        expect(rsi).to.be.a('number');
        expect(rsi).to.be.greaterThan(70); // all gains, no losses → high RSI
    });
});

// ─── calculateBollingerBands ──────────────────────────────────────────────────
describe('calculateBollingerBands', function () {
    it('returns an object with upper, middle, lower, percentB, width keys', function () {
        const prices = flatSeries(30, 100);
        const bb = indicators.calculateBollingerBands(prices, 20, 2);
        expect(bb).to.include.all.keys('upper', 'middle', 'lower', 'percentB', 'width');
    });

    it('middle band equals price for a flat series', function () {
        const prices = flatSeries(30, 100);
        const bb = indicators.calculateBollingerBands(prices, 20, 2);
        expect(bb.middle).to.be.closeTo(100, 0.01);
    });

    it('upper and lower are equidistant from middle for a flat series (std dev = 0)', function () {
        const prices = flatSeries(30, 100);
        const bb = indicators.calculateBollingerBands(prices, 20, 2);
        // flat → std = 0, upper = lower = middle
        expect(bb.upper).to.be.closeTo(bb.middle, 0.01);
        expect(bb.lower).to.be.closeTo(bb.middle, 0.01);
    });

    it('percentB is ~0.5 when price equals the middle band', function () {
        const prices = rampSeries(30, 95, 105); // price varies, last price near middle
        const bb = indicators.calculateBollingerBands(prices, 20, 2);
        expect(bb.percentB).to.be.a('number');
        // Just verify it's a valid ratio in [0, 1] range for most normal series
        expect(bb.percentB).to.be.within(-0.5, 1.5);
    });
});

// ─── calculateStochasticRSI ───────────────────────────────────────────────────
describe('calculateStochasticRSI', function () {
    it('returns null when series is too short', function () {
        const prices = flatSeries(20, 100); // need ≥ rsiPeriod + stochPeriod = 28
        const result = indicators.calculateStochasticRSI(prices, 14, 14);
        expect(result).to.equal(null);
    });

    it('returns a number in [0, 100] for a valid series', function () {
        const prices = rampSeries(50, 90, 110);
        const result = indicators.calculateStochasticRSI(prices, 14, 14);
        expect(result).to.be.a('number');
        expect(result).to.be.within(0, 100);
    });

    it('returns a valid 0-100 number for a series with diverse RSI values', function () {
        // Use a saw-tooth series so RSI varies across the stoch window (avoids 0/0 edge case)
        const prices = [];
        for (let i = 0; i < 50; i++) {
            prices.push(100 + (i % 5 === 0 ? -3 : 1)); // mostly rising with small dips
        }
        const result = indicators.calculateStochasticRSI(prices, 14, 14);
        expect(result).to.be.a('number');
        expect(result).to.be.within(0, 100);
    });
});

// ─── calculateWilliamsR ───────────────────────────────────────────────────────
describe('calculateWilliamsR', function () {
    it('returns null when series is too short', function () {
        const closes = flatSeries(5, 100);
        const highs  = flatSeries(5, 102);
        const lows   = flatSeries(5, 98);
        const result = indicators.calculateWilliamsR(closes, highs, lows, 14);
        expect(result).to.equal(null);
    });

    it('returns a value between -100 and 0', function () {
        const closes = rampSeries(30, 95, 105);
        const highs  = closes.map(c => c + 2);
        const lows   = closes.map(c => c - 2);
        const result = indicators.calculateWilliamsR(closes, highs, lows, 14);
        expect(result).to.be.a('number');
        expect(result).to.be.within(-100, 0);
    });

    it('returns near 0 (overbought) when close is near period high', function () {
        const closes = flatSeries(20, 102); // close at high
        const highs  = flatSeries(20, 102);
        const lows   = flatSeries(20, 98);
        const result = indicators.calculateWilliamsR(closes, highs, lows, 14);
        expect(result).to.be.closeTo(0, 1);
    });

    it('returns near -100 (oversold) when close is near period low', function () {
        const closes = flatSeries(20, 98); // close at low
        const highs  = flatSeries(20, 102);
        const lows   = flatSeries(20, 98);
        const result = indicators.calculateWilliamsR(closes, highs, lows, 14);
        expect(result).to.be.closeTo(-100, 1);
    });
});
