const formatPercentage = (value) => {
  if (typeof value !== 'number') {
    return 'N/A';
  }
  return `${(value * 100).toFixed(2)}%`;
};

module.exports = {
  formatPercentage,
};
