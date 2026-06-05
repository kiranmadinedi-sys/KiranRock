const { formatPercentage } = require('../src/utils/formatters');

describe('formatPercentage', () => {
  test('should format a positive decimal as a percentage', () => {
    expect(formatPercentage(0.12345)).toBe('12.35%');
  });

  test('should format zero correctly', () => {
    expect(formatPercentage(0)).toBe('0.00%');
  });

  test('should format a negative decimal as a percentage', () => {
    expect(formatPercentage(-0.05)).toBe('-5.00%');
  });

  test('should handle whole numbers', () => {
    expect(formatPercentage(1)).toBe('100.00%');
  });

  test('should return "N/A" for non-numeric input', () => {
    expect(formatPercentage('not a number')).toBe('N/A');
    expect(formatPercentage(null)).toBe('N/A');
    expect(formatPercentage(undefined)).toBe('N/A');
  });
});
