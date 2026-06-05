const { expect } = require('chai');

const {
  mapPredictionForExport,
  buildWeeklyPredictionsCsv
} = require('../src/services/weeklyReportExportService');

describe('weeklyReportExportService', function() {
  it('maps ranked predictions into stable CSV rows', function() {
    const row = mapPredictionForExport({
      symbol: 'AAPL',
      totalScore: 84,
      tier: 'A',
      currentPrice: '210.55',
      prediction: {
        signal: 'Buy',
        confidence: 89,
        targetPrice: '225.10',
        expectedMove: '6.91'
      },
      riskAnalysis: {
        riskScore: 37,
        riskLevel: 'Low'
      },
      sector: 'Technology',
      volatility: 1.8,
      tradeType: 'Momentum',
      rewardRiskRatio: '2.40',
      rationale: 'Strong technical setup',
      lastUpdated: '2026-05-04T12:00:00.000Z'
    }, 0);

    expect(row).to.deep.equal({
      rank: 1,
      symbol: 'AAPL',
      signal: 'Buy',
      confidence: 89,
      totalScore: 84,
      tier: 'A',
      currentPrice: '210.55',
      targetPrice: '225.10',
      expectedMovePct: '6.91',
      riskScore: 37,
      riskLevel: 'Low',
      sector: 'Technology',
      volatility: 1.8,
      tradeType: 'Momentum',
      rewardRiskRatio: '2.40',
      rationale: 'Strong technical setup',
      lastUpdated: '2026-05-04T12:00:00.000Z'
    });
  });

  it('builds CSV output with headers and ranked rows', function() {
    const csv = buildWeeklyPredictionsCsv([
      {
        symbol: 'AAPL',
        totalScore: 84,
        prediction: { signal: 'Buy', confidence: 89, targetPrice: '225.10', expectedMove: '6.91' },
        riskAnalysis: { riskScore: 37, riskLevel: 'Low' },
        sector: 'Technology'
      },
      {
        symbol: 'MSFT',
        totalScore: 80,
        prediction: { signal: 'Hold', confidence: 70, targetPrice: '430.00', expectedMove: '2.10' },
        riskAnalysis: { riskScore: 44, riskLevel: 'Medium' },
        sector: 'Technology'
      }
    ]);

    expect(csv).to.contain('"rank","symbol","signal","confidence","totalScore"');
    expect(csv).to.contain('1,"AAPL","Buy",89,84');
    expect(csv).to.contain('2,"MSFT","Hold",70,80');
  });
});