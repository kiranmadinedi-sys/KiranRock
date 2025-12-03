const reportService = require('../services/reportService');

const getReport = async (req, res) => {
    try {
        const { symbol } = req.params;
        const { transcriptUrl } = req.body;
        const report = await reportService.generateReport(symbol, transcriptUrl);
        res.json(report);
    } catch (error) {
        console.error(`Error generating report for ${req.params.symbol}:`, error);
        res.status(500).json({ message: error.message || 'Failed to generate report' });
    }
};

module.exports = { getReport };
