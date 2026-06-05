const { expect } = require('chai');
const tradesDb = require('../src/services/tradesDatabaseService');

describe('tradesDatabaseService.getFirstBuyDates', function() {
  it('returns an array of {symbol, first_bought} for a valid user', async function() {
    // Use an existing user id from local dev data (adjust if needed)
    const userId = process.env.TEST_USER_ID || '83f08677-e55a-48d1-bd31-f5b56fa79c23';
    const rows = await tradesDb.getFirstBuyDates(userId);
    expect(rows).to.be.an('array');
    if (rows.length > 0) {
      expect(rows[0]).to.have.property('symbol');
      expect(rows[0]).to.have.property('first_bought');
    }
  });
});
