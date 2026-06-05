const { Parser } = require('json2csv');

function mapPredictionForExport(prediction, index) {
    return {
        rank: index + 1,
        symbol: prediction.symbol || '',
        signal: prediction.prediction?.signal || '',
        confidence: prediction.prediction?.confidence ?? '',
        totalScore: prediction.totalScore ?? '',
        tier: prediction.tier || '',
        currentPrice: prediction.currentPrice ?? '',
        targetPrice: prediction.prediction?.targetPrice ?? '',
        expectedMovePct: prediction.prediction?.expectedMove ?? '',
        riskScore: prediction.riskAnalysis?.riskScore ?? '',
        riskLevel: prediction.riskAnalysis?.riskLevel || '',
        sector: prediction.sector || '',
        volatility: prediction.volatility ?? '',
        tradeType: prediction.tradeType || '',
        rewardRiskRatio: prediction.rewardRiskRatio ?? '',
        rationale: prediction.rationale || '',
        lastUpdated: prediction.lastUpdated || ''
    };
}

function buildWeeklyPredictionsCsv(predictions = []) {
    const fields = [
        'rank',
        'symbol',
        'signal',
        'confidence',
        'totalScore',
        'tier',
        'currentPrice',
        'targetPrice',
        'expectedMovePct',
        'riskScore',
        'riskLevel',
        'sector',
        'volatility',
        'tradeType',
        'rewardRiskRatio',
        'rationale',
        'lastUpdated'
    ];

    const parser = new Parser({ fields });
    return parser.parse(predictions.map(mapPredictionForExport));
}

module.exports = {
    mapPredictionForExport,
    buildWeeklyPredictionsCsv
};