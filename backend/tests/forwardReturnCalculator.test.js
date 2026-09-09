const { computeForwardMetrics, barsAfter, RETURN_CHECKPOINTS, TRACK_TRADING_DAYS } = require('../src/utils/forwardReturnCalculator');

describe('forwardReturnCalculator', () => {
    describe('computeForwardMetrics', () => {
        test('returns null when there are no bars', () => {
            expect(computeForwardMetrics([], 100)).toBeNull();
            expect(computeForwardMetrics(null, 100)).toBeNull();
        });

        test('returns null when entryPrice is missing or non-positive', () => {
            const bars = [{ high: 105, low: 95, close: 100 }];
            expect(computeForwardMetrics(bars, 0)).toBeNull();
            expect(computeForwardMetrics(bars, null)).toBeNull();
            expect(computeForwardMetrics(bars, -10)).toBeNull();
        });

        test('computes MFE/MAE correctly from a simple up-then-down move', () => {
            // entry 100 -> high 110 (MFE +10%) -> low 90 (MAE -10%)
            const bars = [
                { high: 110, low: 100, close: 108 },
                { high: 108, low: 90,  close: 95 },
            ];
            const metrics = computeForwardMetrics(bars, 100);
            expect(metrics.mfePct).toBeCloseTo(10, 5);
            expect(metrics.maePct).toBeCloseTo(-10, 5);
        });

        test('only populates a return checkpoint once enough bars exist', () => {
            const bars = Array.from({ length: 4 }, (_, i) => ({ high: 101, low: 99, close: 100 + i }));
            const metrics = computeForwardMetrics(bars, 100);
            // Only 4 bars available -- 5D/10D/20D checkpoints all unmet
            expect(metrics.return5dPct).toBeNull();
            expect(metrics.return10dPct).toBeNull();
            expect(metrics.return20dPct).toBeNull();
            expect(metrics.tradingDaysTracked).toBe(4);
            expect(metrics.shouldClose).toBe(false);
        });

        test('computes the 5-day return from the 5th bar close, not the last bar', () => {
            const bars = [
                { high: 101, low: 99, close: 101 }, // day 1
                { high: 102, low: 99, close: 102 }, // day 2
                { high: 103, low: 99, close: 103 }, // day 3
                { high: 104, low: 99, close: 104 }, // day 4
                { high: 106, low: 99, close: 106 }, // day 5 -- this is the 5D checkpoint
                { high: 120, low: 99, close: 120 }, // day 6 -- must NOT be used for 5D
            ];
            const metrics = computeForwardMetrics(bars, 100);
            expect(metrics.return5dPct).toBeCloseTo(6, 5); // (106-100)/100
        });

        test('closes tracking once TRACK_TRADING_DAYS bars have accumulated', () => {
            const bars = Array.from({ length: TRACK_TRADING_DAYS }, () => ({ high: 101, low: 99, close: 100 }));
            const metrics = computeForwardMetrics(bars, 100);
            expect(metrics.shouldClose).toBe(true);
            expect(metrics.return20dPct).toBeCloseTo(0, 5);
        });

        test('return checkpoints match the documented 5/10/20 set', () => {
            expect(RETURN_CHECKPOINTS).toEqual([5, 10, 20]);
        });
    });

    describe('barsAfter', () => {
        test('filters out bars at or before the anchor timestamp', () => {
            const anchor = new Date('2026-09-01T00:00:00Z').getTime();
            const bars = [
                { time: '2026-08-30T00:00:00Z', close: 1 },
                { time: '2026-09-01T00:00:00Z', close: 2 }, // exactly at anchor -- excluded
                { time: '2026-09-02T00:00:00Z', close: 3 },
            ];
            const result = barsAfter(bars, anchor);
            expect(result).toHaveLength(1);
            expect(result[0].close).toBe(3);
        });

        test('supports the alternate `date` field some providers use instead of `time`', () => {
            const anchor = new Date('2026-09-01T00:00:00Z').getTime();
            const bars = [{ date: '2026-09-02T00:00:00Z', close: 5 }];
            expect(barsAfter(bars, anchor)).toHaveLength(1);
        });

        test('returns an empty array for a null/undefined bar list', () => {
            expect(barsAfter(null, 0)).toEqual([]);
            expect(barsAfter(undefined, 0)).toEqual([]);
        });
    });
});
