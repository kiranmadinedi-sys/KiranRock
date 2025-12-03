import { API_BASE_URL } from '../config/apiConfig';
import React, { useState, useEffect } from 'react';

const ReportView = ({ symbol, token }) => {
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [transcriptUrl, setTranscriptUrl] = useState('');

    // Reset state when symbol changes
    useEffect(() => {
        setReport(null);
        setError('');
        setTranscriptUrl('');
    }, [symbol]);

    const handleFindTranscript = () => {
        const query = encodeURIComponent(`${symbol} investor relations latest earnings transcript`);
        window.open(`https://www.google.com/search?q=${query}`, '_blank');
    };

    const fetchReport = async () => {
        if (!symbol) return;
        setLoading(true);
        setError('');
        setReport(null);
        try {
            const response = await fetch(`${API_BASE_URL}/api/reports/${symbol}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({ transcriptUrl: transcriptUrl || undefined }),
            });
            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || 'Failed to fetch report');
            }
            const data = await response.json();
            setReport(data);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="bg-[var(--color-card)] border border-[var(--color-border)] text-[var(--color-text-primary)] p-4 sm:p-6 rounded-xl shadow-sm">
            <h2 className="text-xl sm:text-2xl font-bold mb-4 flex items-center">
                <span className="mr-2">📊</span>
                Generate Research Report for {symbol}
            </h2>
            
            <div className="bg-[var(--color-bg-tertiary)] p-3 sm:p-4 rounded-lg mb-6 border border-[var(--color-border)]">
                <div className="flex flex-col space-y-3">
                    <div className="flex-grow">
                        <label htmlFor="transcript-url" className="block text-xs sm:text-sm font-medium mb-2 text-[var(--color-text-primary)]">
                            Earnings Call Transcript URL (Optional)
                        </label>
                        <input
                            type="text"
                            id="transcript-url"
                            value={transcriptUrl}
                            onChange={(e) => setTranscriptUrl(e.target.value)}
                            placeholder="https://example.com/transcript"
                            className="w-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-2 sm:p-2.5 focus:ring-2 focus:ring-[var(--color-accent)] focus:border-[var(--color-accent)] text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-secondary)]"
                        />
                    </div>
                    <div className="flex flex-col sm:flex-row gap-2">
                        <button
                            onClick={handleFindTranscript}
                            className="flex-1 bg-[var(--color-bg-secondary)] hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-primary)] font-semibold py-2 sm:py-2.5 px-4 rounded-lg transition duration-200 text-sm border border-[var(--color-border)]"
                        >
                            🔍 Find Transcript
                        </button>
                        <button
                            onClick={fetchReport}
                            disabled={loading}
                            className="flex-1 bg-[var(--color-accent)] hover:opacity-90 text-white font-bold py-2 sm:py-2.5 px-4 rounded-lg transition duration-200 disabled:opacity-50 disabled:cursor-not-allowed text-sm shadow-sm"
                        >
                            {loading ? '⏳ Generating...' : '✨ Generate Report'}
                        </button>
                    </div>
                </div>
            </div>

            {error && (
                <div className="p-3 sm:p-4 text-center text-red-300 bg-red-900/20 border border-red-700 dark:border-red-800 rounded-lg mb-4 text-sm">
                    ⚠️ Error: {error}
                </div>
            )}
            
            {report && (
                <div className="animate-fade-in space-y-4 sm:space-y-6">
                    <div className="bg-[var(--color-bg-tertiary)] p-3 sm:p-4 rounded-lg border border-[var(--color-border)]">
                        <h3 className="text-lg sm:text-2xl font-bold mb-2">{report.symbol} - Research Report</h3>
                        <p className="text-xs sm:text-sm text-[var(--color-text-secondary)] mb-1">{report.dataSource}</p>
                        <p className="text-xs sm:text-sm text-[var(--color-text-secondary)]">{report.timeframe}</p>
                    </div>

                    <div className="bg-gradient-to-r from-blue-900/30 to-indigo-900/30 p-3 sm:p-4 rounded-lg border border-blue-800">
                        <h4 className="text-base sm:text-xl font-semibold mb-2 flex items-center">
                            <span className="mr-2">📝</span>
                            Summary
                        </h4>
                        <p className="text-sm sm:text-base leading-relaxed">{report.summary}</p>
                    </div>

                    {report.transcriptAnalysis && (
                        <div className="bg-[var(--color-bg-tertiary)] p-3 sm:p-4 rounded-lg border border-[var(--color-border)]">
                            <h4 className="text-base sm:text-xl font-semibold mb-3 flex items-center text-[var(--color-text-primary)]">
                                <span className="mr-2">💼</span>
                                Earnings Call Analysis
                            </h4>
                            {report.transcriptAnalysis.error ? (
                                <p className="text-[var(--color-danger)] text-sm">{report.transcriptAnalysis.error}</p>
                            ) : (
                                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                                    <div className="bg-green-50 dark:bg-green-900/20 p-3 sm:p-4 rounded-lg border border-green-300 dark:border-green-800">
                                        <h5 className="text-sm sm:text-lg font-semibold mb-2 text-green-600 dark:text-green-400 flex items-center">
                                            <span className="mr-2">✅</span>
                                            Positives
                                        </h5>
                                        <ul className="list-disc list-inside space-y-1 text-xs sm:text-sm text-green-800 dark:text-green-200">
                                            {report.transcriptAnalysis.positive.length > 0 ? 
                                                report.transcriptAnalysis.positive.map((item, i) => <li key={i}>{item}</li>) :
                                                <li>No specific positive points identified.</li>
                                            }
                                        </ul>
                                    </div>
                                    <div className="bg-red-50 dark:bg-red-900/20 p-3 sm:p-4 rounded-lg border border-red-300 dark:border-red-800">
                                        <h5 className="text-sm sm:text-lg font-semibold mb-2 text-red-600 dark:text-red-400 flex items-center">
                                            <span className="mr-2">❌</span>
                                            Negatives
                                        </h5>
                                        <ul className="list-disc list-inside space-y-1 text-xs sm:text-sm text-red-800 dark:text-red-200">
                                            {report.transcriptAnalysis.negative.length > 0 ?
                                                report.transcriptAnalysis.negative.map((item, i) => <li key={i}>{item}</li>) :
                                                <li>No specific negative points identified.</li>
                                            }
                                        </ul>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}

                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
                        <div className="bg-purple-50 dark:bg-purple-900/20 p-3 sm:p-4 rounded-lg border border-purple-300 dark:border-purple-800">
                            <h4 className="text-base sm:text-xl font-semibold mb-3 flex items-center text-purple-800 dark:text-purple-200">
                                <span className="mr-2">📈</span>
                                Key Trends
                            </h4>
                            <ul className="space-y-2">
                                {report.trends.map((trend, index) => (
                                    <li key={index} className="bg-[var(--color-bg-tertiary)] p-2 sm:p-3 rounded-lg text-sm border border-[var(--color-border)]">
                                        <span className="font-medium text-[var(--color-text-primary)]">{trend.name}:</span> <span className="text-[var(--color-text-secondary)]">{trend.value}</span>
                                        <span className={`ml-2 text-xs font-semibold ${trend.insight === 'Positive' || trend.insight === 'Increasing' ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
                                            ({trend.insight})
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <div className="bg-orange-50 dark:bg-orange-900/20 p-3 sm:p-4 rounded-lg border border-orange-300 dark:border-orange-800">
                            <h4 className="text-base sm:text-xl font-semibold mb-3 flex items-center text-orange-800 dark:text-orange-200">
                                <span className="mr-2">🎯</span>
                                Support & Resistance
                            </h4>
                            <div className="bg-[var(--color-bg-tertiary)] p-2 sm:p-3 rounded-lg space-y-2 text-sm border border-[var(--color-border)]">
                                <p className="text-[var(--color-text-primary)]"><span className="font-medium">Support:</span> <span className="text-[var(--color-text-secondary)]">{report.supportResistance.support}</span></p>
                                <p className="text-[var(--color-text-primary)]"><span className="font-medium">Resistance:</span> <span className="text-[var(--color-text-secondary)]">{report.supportResistance.resistance}</span></p>
                            </div>
                        </div>
                    </div>

                    <div className="bg-teal-50 dark:bg-teal-900/20 p-3 sm:p-4 rounded-lg border border-teal-300 dark:border-teal-800">
                        <h4 className="text-base sm:text-xl font-semibold mb-3 flex items-center text-teal-800 dark:text-teal-200">
                            <span className="mr-2">⚡</span>
                            Actionable Signals
                        </h4>
                        <div className="overflow-x-auto">
                            <table className="min-w-full bg-[var(--color-bg-tertiary)] rounded-lg text-sm border border-[var(--color-border)]">
                                <thead>
                                    <tr className="border-b border-[var(--color-border)]">
                                        <th className="text-left p-2 sm:p-3 font-semibold text-[var(--color-text-primary)]">Indicator</th>
                                        <th className="text-left p-2 sm:p-3 font-semibold text-[var(--color-text-primary)]">Value</th>
                                        <th className="text-left p-2 sm:p-3 font-semibold text-[var(--color-text-primary)]">Signal</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {report.signals.map((signal, index) => (
                                        <tr key={index} className="border-t border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)]">
                                            <td className="p-2 sm:p-3 text-[var(--color-text-primary)]">{signal.indicator}</td>
                                            <td className="p-2 sm:p-3 text-[var(--color-text-secondary)]">{signal.value}</td>
                                            <td className={`p-2 sm:p-3 font-semibold ${signal.signal.includes('Buy') ? 'text-[var(--color-success)]' : signal.signal.includes('Sell') ? 'text-[var(--color-danger)]' : 'text-[var(--color-text-primary)]'}`}>
                                                {signal.signal}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default ReportView;
