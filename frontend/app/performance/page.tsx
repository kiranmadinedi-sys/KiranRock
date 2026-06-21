'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

import { getAuthToken, handleAuthError } from '../utils/auth';
import { getApiBaseUrl } from '../config';

interface DayRecord {
    date: string;
    pnl: number;
    winRate: number;
    trades: number;
    wins: number;
    losses: number;
    sharpeRatio: number;
    profitFactor: number;
}

// Matches actual /api/performance/scorecard response shape
interface Scorecard {
    today?:     { date: string; pnl: number; trades: number; wins: number; losses: number };
    rolling30d?: { sharpeRatio: number; totalPnl: number; winRateLast20Pct: number | null };
    risk?:       { currentDrawdownPct: number; consecutiveLosses: number; circuitBreakerActive: boolean };
    kelly?:      { winRate: number; avgWin: number; avgLoss: number; totalTrades: number } | null;
    market?:     { regime: string; vix: number; description: string; minBuyScore: number; positionSizeMultiplier: number };
}

interface IntelligenceOverview {
    candidate_count: number;
    executed_count: number;
    closed_count: number;
    closed_win_rate: number | null;
    avg_closed_return: number | null;
    avg_expectancy: number | null;
    avg_score_adjustment: number | null;
    avg_size_multiplier: number | null;
    total_closed_pnl: number | null;
}

interface IntelligenceRow {
    botType?: string;
    strategyFamily?: string;
    setupFamily?: string;
    regime?: string;
    closedCount?: number;
    trades?: number;
    winRate?: number | null;
    avgReturn?: number | null;
    expectancy?: number | null;
    totalPnl?: number | null;
    avgScoreAdjustment?: number | null;
    avgSizeMultiplier?: number | null;
    lastClosedAt?: string | null;
    symbol?: string;
    pnl?: number | null;
    pnlPercent?: number | null;
    score?: number | null;
    scoreAdjustment?: number | null;
    sizeMultiplier?: number | null;
    closedAt?: string | null;
}

interface IntelligenceFilters {
    botType: string;
    regime: string;
    availableBotTypes: string[];
    availableRegimes: string[];
}

interface CurrentEdgeRow {
    botType?: string;
    strategyFamily?: string;
    setupFamily?: string;
    regime?: string;
    recentTrades?: number;
    priorTrades?: number;
    recentWinRate?: number | null;
    priorWinRate?: number | null;
    recentAvgReturn?: number | null;
    priorAvgReturn?: number | null;
    recentTotalPnl?: number | null;
    priorTotalPnl?: number | null;
    returnDelta?: number | null;
    winRateDelta?: number | null;
}

interface DrilldownRequest {
    botType?: string;
    regime?: string;
    strategyFamily?: string;
    setupFamily?: string;
    symbol?: string;
    sector?: string;
    title: string;
}

interface DrilldownPhaseRow {
    phase: string;
    count: number;
    avg_score?: number | null;
    avg_score_adjustment?: number | null;
    avg_size_multiplier?: number | null;
    avg_expectancy?: number | null;
    avg_return?: number | null;
    total_pnl?: number | null;
}

interface DrilldownEntry {
    id: number;
    botType?: string;
    symbol?: string;
    setupFamily?: string;
    strategyFamily?: string;
    regime?: string;
    decisionPhase?: string;
    score?: number | null;
    scoreAdjustment?: number | null;
    sizeMultiplier?: number | null;
    expectancy?: number | null;
    confidence?: number | null;
    entryPrice?: number | null;
    exitPrice?: number | null;
    pnl?: number | null;
    pnlPercent?: number | null;
    tradeRefType?: string | null;
    tradeRefId?: string | null;
    metadata?: unknown;
    openedAt?: string | null;
    closedAt?: string | null;
    createdAt?: string | null;
}

interface DrilldownPayload {
    lookbackDays: number;
    filters: {
        botType: string;
        regime: string;
        strategyFamily: string;
        setupFamily: string;
        symbol: string;
        sector?: string;
        limit: number;
    };
    summary: {
        total_rows: number;
        candidate_count: number;
        executed_count: number;
        closed_count: number;
        closed_win_rate: number | null;
        avg_closed_return: number | null;
        total_closed_pnl: number | null;
        last_seen_at?: string | null;
        last_closed_at?: string | null;
    };
    phaseBreakdown: DrilldownPhaseRow[];
    entries: DrilldownEntry[];
}

interface IntelligencePayload {
    lookbackDays: number;
    comparisonWindowDays: number;
    filters: IntelligenceFilters;
    overview: IntelligenceOverview;
    byBotType: IntelligenceRow[];
    topSetups: IntelligenceRow[];
    strategyPerformance: IntelligenceRow[];
    regimePerformance: IntelligenceRow[];
    recentClosures: IntelligenceRow[];
    currentEdge: CurrentEdgeRow[];
}

interface SectorRow {
    sector: string;
    trades: number;
    wins: number;
    totalPnl: number;
    avgPnl: number;
    winRate: number;
}

interface HeatmapCell {
    sector: string;
    regime: string;
    trades: number;
    winRate: number | null;
    totalPnl: number | null;
}

interface AttributionData {
    days: number;
    bySector: SectorRow[];
    bySectorPrior: SectorRow[];
    heatmap: HeatmapCell[];
}

interface HoldPeriodRow  { bucket: string; total: number; wins: number; winRate: number; avgReturn: number; minReturn: number; maxReturn: number; }
interface ExitReasonRow  { reason: string; total: number; wins: number; winRate: number; avgReturn: number; totalPnl: number; }
interface ScoreBucketRow { bucket: string; total: number; wins: number; winRate: number; avgReturn: number; totalPnl: number; }
interface HypothesisData { days: number; byHoldPeriod: HoldPeriodRow[]; byExitReason: ExitReasonRow[]; byScoreBucket: ScoreBucketRow[]; }

interface WeeklyReportPosition {
    symbol: string; sector: string; qty: number; entryPrice: number; currentPrice: number;
    gainLoss: number; gainLossPct: number; stockReturn: number | null; alpha: number | null; since: string;
}
interface WeeklyReportTrade {
    symbol: string; price: number; quantity: number; pnl: number; pnlPct: number;
    aiScore: number | null; sector: string; date: string; executor?: string;
}
interface WeeklyReportData {
    weekDates: string; weekStart: string; weekEnd: string; generatedAt?: string;
    summary: {
        totalBuys: number; totalSells: number; totalTrades: number;
        realizedPnl: number; unrealizedPnl: number; cashBalance: number;
        openPositions: number; winRate: number; wins: number; losses: number;
        avgWin: number; avgLoss: number; profitFactor: number | null;
        bestTrade: { symbol: string; pnl: number; pct: number } | null;
        worstTrade: { symbol: string; pnl: number; pct: number } | null;
    };
    marketContext: { spy: number | null; qqq: number | null; iwm: number | null };
    alphaCapture: { avgAlpha: number | null; beatingSpyCount: number; totalPositions: number; spyWeeklyReturn: number | null };
    closedTrades: WeeklyReportTrade[];
    newBuys: WeeklyReportTrade[];
    openPositions: WeeklyReportPosition[];
    scoreBuckets: ScoreBucketRow[];
    insights: string[];
}
interface WeeklyReportHistoryEntry {
    id: number; weekStart: string; weekEnd: string; generatedAt: string;
    summary: WeeklyReportData['summary'];
}

// ── Trade Attribution ────────────────────────────────────────────────────────
interface TradeAttributionTrade {
    id: number;
    symbol: string;
    score: number | null;
    confidence: number | null;
    regime: string | null;
    setupFamily: string | null;
    strategyFamily: string | null;
    outcome: string | null;
    entryPrice: number | null;
    exitPrice: number | null;
    pnl: number | null;
    pnlPct: number | null;
    openedAt: string | null;
    closedAt: string | null;
    holdDays: number | null;
    sector: string | null;
    exitReason: string | null;
    winLossReason: string | null;
    atrPct: number | null;
    dteAtEntry: number | null;
    dteAtExit: number | null;
    bullBearRatio: number | null;
    autoTags: string[];
    postExitDrift5d: number | null;
    postExitDrift10d: number | null;
}
interface TradeAttributionAgg {
    bucket: string;
    total: number;
    wins: number;
    winRate: number;
    avgReturn: number;
    totalPnl: number;
    avgWin: number;
    avgLoss: number;
    avgWinPct: number;
    avgLossPct: number;
    expectancyPct: number;
    // only present on byExit rows (Exit Quality Dashboard)
    avgDrift5d?: number | null;
    avgDrift10d?: number | null;
    driftSampleCount?: number;
}
interface TradeAttributionData {
    days: number;
    filters: { symbol: string | null; sector: string | null; outcome: string | null };
    totalClosed: number;
    postExitSummary: { avgDrift5d: number | null; avgDrift10d: number | null; tradesWithDriftData: number };
    trades: TradeAttributionTrade[];
    byScore: TradeAttributionAgg[];
    byConfidence: TradeAttributionAgg[];
    bySector: TradeAttributionAgg[];
    byRegime: TradeAttributionAgg[];
    byExit: TradeAttributionAgg[];
    byHold: TradeAttributionAgg[];
    byOutcome: TradeAttributionAgg[];
}

interface CalibrationBucket {
    bucket: string; floor: number; total: number; wins: number; losses: number;
    profitFactor: number; expectancy: number; avgReturn: number; winRate: number;
    maxDrawdown: number; valid: boolean; profitable: boolean; confidence: string;
}
interface CalibrationExitRow {
    exitType: string; total: number; profitFactor: number; expectancy: number;
    avgReturn: number; winRate: number; maxDrawdown: number; avgHoldDays: number | null; valid: boolean;
}
interface CalibrationConfidenceBucket {
    bucket: string; total: number; wins: number; losses: number;
    winRate: number; avgReturn: number; profitFactor: number; expectancy: number; valid: boolean;
}
interface CalibrationSectorInsight {
    sector: string; total: number; winRate: number; profitFactor: number; suggestedFloor: number | null;
}
interface CalibrationReport {
    generatedAt: string; lookbackDays: number; totalTrades: number;
    hasEnoughData: boolean; suggestedFloor: number | null; reason: string; confidence: string;
    buckets: CalibrationBucket[];
    exitAttribution: CalibrationExitRow[] | null;
    confidenceBuckets: CalibrationConfidenceBucket[] | null;
    sectorInsights: CalibrationSectorInsight[];
    scoreRatioCross: Array<{ scoreBucket: string; ratioBucket: string; total: number; profitFactor: number; avgReturn: number; winRate: number; valid: boolean; }> | null;
}

function fmt(n: number | null | undefined, dec = 2) {
    if (n == null || isNaN(Number(n))) return '—';
    const v = Number(n);
    return (v >= 0 ? '+' : '') + v.toFixed(dec);
}

function fmtUsd(n: number | null | undefined) {
    if (n == null || isNaN(Number(n))) return '$—';
    const v = Number(n);
    return (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pnlColor(v: number | null | undefined) {
    if (v == null) return 'text-gray-500';
    return Number(v) >= 0 ? 'text-green-600' : 'text-red-600';
}

function pct(v: number | null | undefined, dec = 1) {
    if (v == null || Number.isNaN(Number(v))) return '—';
    return `${Number(v).toFixed(dec)}%`;
}

function titleize(value: string | null | undefined) {
    if (!value) return '—';
    return value
        .split('_')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function compactLabel(parts: Array<string | null | undefined>) {
    return parts.filter(Boolean).join(' • ');
}

function escapeCsvValue(value: unknown) {
    if (value == null) return '';
    const normalized = typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (/[",\n]/.test(normalized)) {
        return `"${normalized.replace(/"/g, '""')}"`;
    }
    return normalized;
}

function getDrilldownEntryExportValue(entry: DrilldownEntry, header: string) {
    switch (header) {
        case 'createdAt':
            return entry.createdAt;
        case 'openedAt':
            return entry.openedAt;
        case 'closedAt':
            return entry.closedAt;
        case 'decisionPhase':
            return entry.decisionPhase;
        case 'botType':
            return entry.botType;
        case 'symbol':
            return entry.symbol;
        case 'strategyFamily':
            return entry.strategyFamily;
        case 'setupFamily':
            return entry.setupFamily;
        case 'regime':
            return entry.regime;
        case 'score':
            return entry.score;
        case 'scoreAdjustment':
            return entry.scoreAdjustment;
        case 'sizeMultiplier':
            return entry.sizeMultiplier;
        case 'expectancy':
            return entry.expectancy;
        case 'confidence':
            return entry.confidence;
        case 'entryPrice':
            return entry.entryPrice;
        case 'exitPrice':
            return entry.exitPrice;
        case 'pnl':
            return entry.pnl;
        case 'pnlPercent':
            return entry.pnlPercent;
        case 'tradeRefType':
            return entry.tradeRefType;
        case 'tradeRefId':
            return entry.tradeRefId;
        case 'metadata':
            return entry.metadata;
        default:
            return '';
    }
}

function exportAttributionCsv(attribution: AttributionData) {
    if (typeof window === 'undefined' || attribution.bySector.length === 0) return;
    const priorMap = new Map((attribution.bySectorPrior || []).map(r => [r.sector, r]));
    const headers = ['Sector', 'Trades', 'Wins', 'WinRate%', 'TotalPnL', 'AvgPnL', 'PriorWinRate%', 'PriorTotalPnL'];
    const rows = attribution.bySector.map(r => {
        const p = priorMap.get(r.sector);
        return [
            r.sector,
            r.trades,
            r.wins,
            r.winRate,
            r.totalPnl,
            r.avgPnl,
            p?.winRate ?? '',
            p?.totalPnl ?? ''
        ].map(v => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v ?? ''))).join(',');
    });
    const csv = [headers.join(','), ...rows].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sector-attribution-${attribution.days}d-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// Simple SVG line chart — no external dependency
function MiniLineChart({ data, color = '#2563eb', height = 60 }: { data: number[]; color?: string; height?: number }) {
    if (data.length < 2) return <div className="text-gray-400 text-xs text-center py-4">Not enough data</div>;
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const w = 300;
    const pad = 4;
    const pts = data.map((v, i) => {
        const x = pad + (i / (data.length - 1)) * (w - pad * 2);
        const y = height - pad - ((v - min) / range) * (height - pad * 2);
        return `${x},${y}`;
    }).join(' ');
    return (
        <svg viewBox={`0 0 ${w} ${height}`} className="w-full" preserveAspectRatio="none">
            <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
}

export default function PerformancePage() {
    const router = useRouter();
    const [scorecard, setScorecard] = useState<Scorecard | null>(null);
    const [history, setHistory] = useState<DayRecord[]>([]);
    const [intelligence, setIntelligence] = useState<IntelligencePayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [syncing, setSyncing] = useState(false);
    const [syncMsg, setSyncMsg] = useState('');
    const [days, setDays] = useState(30);
    const [intelligenceDays, setIntelligenceDays] = useState(180);
    const [intelligenceBotType, setIntelligenceBotType] = useState('all');
    const [intelligenceRegime, setIntelligenceRegime] = useState('all');
    const [activeDrilldown, setActiveDrilldown] = useState<DrilldownRequest | null>(null);
    const [drilldown, setDrilldown] = useState<DrilldownPayload | null>(null);
    const [drilldownLoading, setDrilldownLoading] = useState(false);
    const [drilldownError, setDrilldownError] = useState('');
    const [attribution, setAttribution] = useState<AttributionData | null>(null);
    const [hypothesis, setHypothesis] = useState<HypothesisData | null>(null);
    const [showCalibrationModal, setShowCalibrationModal] = useState(false);
    const [calibrationData, setCalibrationData] = useState<CalibrationReport | null>(null);
    const [calibrationLoading, setCalibrationLoading] = useState(false);
    const [calibrationApplying, setCalibrationApplying] = useState(false);
    const [calibrationApplied, setCalibrationApplied] = useState(false);
    const [calibrationError, setCalibrationError] = useState<string | null>(null);
    const [currentMinBuyScore, setCurrentMinBuyScore] = useState<number | null>(null);
    const [weeklyReport, setWeeklyReport] = useState<WeeklyReportData | null>(null);
    const [weeklyReportHistory, setWeeklyReportHistory] = useState<WeeklyReportHistoryEntry[]>([]);
    const [weeklyReportLoading, setWeeklyReportLoading] = useState(false);
    const [weeklyReportGenerating, setWeeklyReportGenerating] = useState(false);
    const [selectedReportId, setSelectedReportId] = useState<number | null>(null);
    const [tradeAttribution, setTradeAttribution] = useState<TradeAttributionData | null>(null);
    const [tradeAttributionLoading, setTradeAttributionLoading] = useState(false);
    const [tradeAttributionDays, setTradeAttributionDays] = useState(180);
    const [tradeAttributionOutcome, setTradeAttributionOutcome] = useState('');
    const [tradeAttributionTab, setTradeAttributionTab] = useState<'trades' | 'byScore' | 'byConfidence' | 'bySector' | 'byRegime' | 'byExit' | 'byHold'>('byScore');

    const token = typeof window !== 'undefined' ? getAuthToken() : null;

    const load = useCallback(async () => {
        if (!token) { router.push('/login'); return; }
        setLoading(true);
        try {
            const base = getApiBaseUrl();
            const hdrs = { Authorization: `Bearer ${token}` };
            const intelligenceParams = new URLSearchParams({
                days: String(intelligenceDays)
            });
            if (intelligenceBotType !== 'all') intelligenceParams.set('botType', intelligenceBotType);
            if (intelligenceRegime !== 'all') intelligenceParams.set('regime', intelligenceRegime);
            const [sRes, hRes, iRes, aRes, hyRes, wrRes, wrhRes] = await Promise.all([
                fetch(`${base}/api/performance/scorecard`, { headers: hdrs }),
                fetch(`${base}/api/performance/history?days=${days}`, { headers: hdrs }),
                fetch(`${base}/api/performance/intelligence?${intelligenceParams.toString()}`, { headers: hdrs }),
                fetch(`${base}/api/performance/attribution?days=${intelligenceDays}`, { headers: hdrs }),
                fetch(`${base}/api/performance/hypothesis?days=${intelligenceDays}`, { headers: hdrs }),
                fetch(`${base}/api/performance/trading-report`, { headers: hdrs }),
                fetch(`${base}/api/performance/trading-report/history?limit=12`, { headers: hdrs }),
            ]);
            if ([sRes, hRes, iRes, aRes, hyRes].some(r => r.status === 401)) { handleAuthError(401); return; }
            if (sRes.ok) setScorecard(await sRes.json());
            if (hRes.ok) setHistory(await hRes.json());
            if (iRes.ok) setIntelligence(await iRes.json());
            if (aRes.ok) setAttribution(await aRes.json());
            if (hyRes.ok) setHypothesis(await hyRes.json());
            if (wrRes.ok) setWeeklyReport(await wrRes.json());
            if (wrhRes.ok) setWeeklyReportHistory(await wrhRes.json());
            // Trade attribution — fire separately so it doesn't block the main load
            setTradeAttributionLoading(true);
            fetch(`${base}/api/performance/trade-attribution?days=365`, { headers: hdrs })
                .then(r => r.ok ? r.json() : null)
                .then(d => { if (d) setTradeAttribution(d); })
                .catch(() => {})
                .finally(() => setTradeAttributionLoading(false));
        } catch (e) {
            console.error('Performance load error', e);
        } finally {
            setLoading(false);
        }
    }, [token, days, intelligenceDays, intelligenceBotType, intelligenceRegime, router]);

    useEffect(() => { load(); }, [load]);

    const loadTradeAttribution = useCallback(async (days: number, outcome: string) => {
        if (!token) return;
        setTradeAttributionLoading(true);
        try {
            const base = getApiBaseUrl();
            const params = new URLSearchParams({ days: String(days) });
            if (outcome) params.set('outcome', outcome);
            const r = await fetch(`${base}/api/performance/trade-attribution?${params.toString()}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (r.ok) setTradeAttribution(await r.json());
        } catch (_) {}
        finally { setTradeAttributionLoading(false); }
    }, [token]);

    const openCalibrationModal = useCallback(async () => {
        setShowCalibrationModal(true);
        setCalibrationApplied(false);
        setCalibrationError(null);
        if (calibrationData) return; // already loaded
        setCalibrationLoading(true);
        try {
            const base = getApiBaseUrl();
            const hdrs = { Authorization: `Bearer ${token}` };
            const [calRes, cfgRes] = await Promise.all([
                fetch(`${base}/api/performance/calibration`, { headers: hdrs }),
                fetch(`${base}/api/enhanced-ai-trading/status`, { headers: hdrs }),
            ]);
            if (calRes.ok) setCalibrationData(await calRes.json());
            if (cfgRes.ok) {
                const d = await cfgRes.json();
                setCurrentMinBuyScore(d?.riskConfig?.minBuyScore ?? null);
            }
        } catch {
            setCalibrationError('Failed to load calibration data. Is the backend running?');
        } finally {
            setCalibrationLoading(false);
        }
    }, [token, calibrationData]);

    const applyCalibration = useCallback(async () => {
        if (!token || !calibrationData?.suggestedFloor) return;
        setCalibrationApplying(true);
        setCalibrationError(null);
        try {
            const base = getApiBaseUrl();
            const res = await fetch(`${base}/api/enhanced-ai-trading/config`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ minBuyScore: calibrationData.suggestedFloor }),
            });
            if (res.ok) {
                setCurrentMinBuyScore(calibrationData.suggestedFloor);
                setCalibrationApplied(true);
                // Refresh calibration data so the action section updates
                setCalibrationData(null);
                setTimeout(() => setShowCalibrationModal(false), 2200);
            } else {
                setCalibrationError('Server rejected the change — check bot config endpoint.');
            }
        } catch {
            setCalibrationError('Network error applying change.');
        } finally {
            setCalibrationApplying(false);
        }
    }, [token, calibrationData]);

    const syncBalance = async () => {
        if (!token) return;
        setSyncing(true);
        setSyncMsg('');
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/performance/sync-balance`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` }
            });
            if (res.ok) {
                const d = await res.json();
                setSyncMsg(`Balance recomputed: $${Number(d.recomputedBalance).toFixed(2)}`);
                load();
            } else {
                setSyncMsg('Sync failed');
            }
        } catch {
            setSyncMsg('Sync error');
        } finally {
            setSyncing(false);
        }
    };

    const openDrilldown = useCallback(async (request: DrilldownRequest) => {
        if (!token) return;
        setActiveDrilldown(request);
        setDrilldownLoading(true);
        setDrilldownError('');
        try {
            const params = new URLSearchParams({
                days: String(intelligenceDays),
                limit: '50'
            });
            if (request.botType && request.botType !== 'all') params.set('botType', request.botType);
            if (request.regime && request.regime !== 'all') params.set('regime', request.regime);
            if (request.strategyFamily) params.set('strategyFamily', request.strategyFamily);
            if (request.setupFamily) params.set('setupFamily', request.setupFamily);
            if (request.symbol) params.set('symbol', request.symbol);
            if (request.sector) params.set('sector', request.sector);

            const response = await fetch(`${getApiBaseUrl()}/api/performance/intelligence/drilldown?${params.toString()}`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (response.status === 401) {
                handleAuthError(401);
                return;
            }

            if (!response.ok) {
                throw new Error(`Drilldown request failed with status ${response.status}`);
            }

            setDrilldown(await response.json());
        } catch (error) {
            console.error('Performance drilldown load error', error);
            setDrilldown(null);
            setDrilldownError('Failed to load drill-down details.');
        } finally {
            setDrilldownLoading(false);
        }
    }, [token, intelligenceDays]);

    // Chart data
    const pnlSeries    = history.map(d => Number(d.pnl) || 0);
    const cumulativePnl = pnlSeries.reduce((acc: number[], v, i) => { acc.push((acc[i - 1] || 0) + v); return acc; }, []);
    const winRateSeries = history.map(d => Number(d.winRate) || 0);

    // Summary aggregates over history window
    const totalPnl   = pnlSeries.reduce((a, v) => a + v, 0);
    const totalTrades = history.reduce((a, d) => a + (Number(d.trades) || 0), 0);
    const totalWins   = history.reduce((a, d) => a + (Number(d.wins) || 0), 0);
    const avgWinRate  = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
    const avgSharpe   = history.filter(d => d.sharpeRatio).reduce((s, d, _, a) => s + Number(d.sharpeRatio) / a.length, 0);

    const regime = scorecard?.market?.regime || 'Unknown';
    const regimeColor = regime === 'BULL' ? 'text-green-600' : regime === 'BEAR' ? 'text-red-600' : 'text-yellow-600';
    const intelligenceOverview = intelligence?.overview;
    const currentEdge = intelligence?.currentEdge || [];
    const improvingEdge = currentEdge
        .filter((row) => Number(row.returnDelta || 0) >= 0)
        .slice(0, 5);
    const degradingEdge = [...currentEdge]
        .filter((row) => Number(row.returnDelta || 0) < 0)
        .sort((left, right) => Number(left.returnDelta || 0) - Number(right.returnDelta || 0))
        .slice(0, 5);
    const availableRegimes = intelligence?.filters?.availableRegimes || [];
    const closeDrilldown = () => {
        setActiveDrilldown(null);
        setDrilldown(null);
        setDrilldownError('');
    };
    const exportDrilldown = (format: 'csv' | 'json') => {
        if (!drilldown || drilldown.entries.length === 0 || typeof window === 'undefined') {
            return;
        }

        const timestamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
        const baseName = [
            'trade-intelligence',
            drilldown.filters.botType !== 'all' ? drilldown.filters.botType : null,
            drilldown.filters.strategyFamily !== 'all' ? drilldown.filters.strategyFamily : null,
            drilldown.filters.setupFamily !== 'all' ? drilldown.filters.setupFamily : null,
            timestamp
        ].filter(Boolean).join('_').replace(/\s+/g, '-').toLowerCase();

        let content = '';
        let mimeType = 'application/json';

        if (format === 'csv') {
            const headers = [
                'createdAt',
                'openedAt',
                'closedAt',
                'decisionPhase',
                'botType',
                'symbol',
                'strategyFamily',
                'setupFamily',
                'regime',
                'score',
                'scoreAdjustment',
                'sizeMultiplier',
                'expectancy',
                'confidence',
                'entryPrice',
                'exitPrice',
                'pnl',
                'pnlPercent',
                'tradeRefType',
                'tradeRefId',
                'metadata'
            ];
            const rows = drilldown.entries.map((entry) => headers.map((header) => escapeCsvValue(getDrilldownEntryExportValue(entry, header))).join(','));
            content = [headers.join(','), ...rows].join('\n');
            mimeType = 'text/csv;charset=utf-8;';
        } else {
            content = JSON.stringify(drilldown, null, 2);
        }

        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${baseName}.${format}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-950">


            <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
                {/* Page header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Performance Dashboard</h1>
                        <p className="text-sm text-gray-500 dark:text-gray-400">30-day paper trading analytics</p>
                    </div>
                    <div className="flex items-center gap-3">
                        <select
                            value={days}
                            onChange={e => setDays(Number(e.target.value))}
                            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                        >
                            <option value={7}>7 days</option>
                            <option value={14}>14 days</option>
                            <option value={30}>30 days</option>
                            <option value={60}>60 days</option>
                            <option value={90}>90 days</option>
                        </select>
                        <button
                            onClick={openCalibrationModal}
                            className="text-sm px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors flex items-center gap-1.5"
                            title="Score Calibration — view performance by score bucket and apply threshold suggestions"
                        >
                            🎯 Calibrate
                        </button>
                        <button
                            onClick={load}
                            className="text-sm px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
                        >
                            Refresh
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center h-40">
                        <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
                    </div>
                ) : (
                    <>
                        {/* Market Regime Banner */}
                        {scorecard?.market && (
                            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4 flex items-center justify-between">
                                <div>
                                    <span className="text-xs text-gray-500 uppercase font-semibold tracking-wide">Market Regime</span>
                                    <div className={`text-lg font-bold ${regimeColor}`}>{regime}</div>
                                    <div className="text-sm text-gray-500 dark:text-gray-400">{scorecard.market.description}</div>
                                </div>
                                <div className="text-right">
                                    <span className="text-xs text-gray-500 uppercase font-semibold tracking-wide">VIX</span>
                                    <div className={`text-2xl font-bold ${Number(scorecard.market.vix) > 25 ? 'text-red-600' : 'text-green-600'}`}>
                                        {Number(scorecard.market.vix).toFixed(1)}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* KPI Cards */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                            {[
                                { label: `${days}d P&L`, value: fmtUsd(totalPnl), color: pnlColor(totalPnl), sub: `${totalTrades} trades` },
                                { label: 'Win Rate', value: avgWinRate.toFixed(1) + '%', color: avgWinRate >= 52 ? 'text-green-600' : 'text-red-600', sub: avgWinRate >= 52 ? 'Above target' : 'Below 52% target' },
                                { label: 'Sharpe (30d rolling)', value: (scorecard?.rolling30d?.sharpeRatio ?? avgSharpe).toFixed(2), color: (scorecard?.rolling30d?.sharpeRatio ?? avgSharpe) >= 1 ? 'text-green-600' : (scorecard?.rolling30d?.sharpeRatio ?? avgSharpe) > 0 ? 'text-yellow-600' : 'text-red-600', sub: 'Target: > 1.0' },
                                { label: 'Today P&L', value: fmtUsd(scorecard?.today?.pnl), color: pnlColor(scorecard?.today?.pnl), sub: `${scorecard?.today?.trades || 0} trades today` },
                            ].map(k => (
                                <div key={k.label} className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                                    <div className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-1">{k.label}</div>
                                    <div className={`text-2xl font-bold ${k.color}`}>{k.value}</div>
                                    <div className="text-xs text-gray-400 mt-1">{k.sub}</div>
                                </div>
                            ))}
                        </div>

                        {/* Charts Row */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Cumulative P&L */}
                            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Cumulative P&L ({days}d)</h3>
                                <div className="mb-2">
                                    <span className={`text-xl font-bold ${pnlColor(totalPnl)}`}>{fmtUsd(totalPnl)}</span>
                                </div>
                                <MiniLineChart data={cumulativePnl} color={totalPnl >= 0 ? '#16a34a' : '#dc2626'} />
                                <div className="flex justify-between text-xs text-gray-400 mt-1">
                                    <span>{history[0]?.date?.slice(5) || ''}</span>
                                    <span>{history[history.length - 1]?.date?.slice(5) || ''}</span>
                                </div>
                            </div>

                            {/* Win Rate Trend */}
                            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Daily Win Rate ({days}d)</h3>
                                <div className="mb-2">
                                    <span className={`text-xl font-bold ${avgWinRate >= 52 ? 'text-green-600' : 'text-red-600'}`}>
                                        {avgWinRate.toFixed(1)}% avg
                                    </span>
                                    <span className="text-xs text-gray-400 ml-2">target: 52%</span>
                                </div>
                                <MiniLineChart data={winRateSeries} color="#2563eb" />
                                {/* 52% target line (visual only label) */}
                                <div className="flex items-center gap-1 mt-2 text-xs text-gray-400">
                                    <div className="w-6 border-t border-dashed border-gray-400" />
                                    <span>52% go-live threshold</span>
                                </div>
                            </div>
                        </div>

                        {/* ── Weekly Trading Report ── */}
                        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                                <div>
                                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Weekly Trading Report</h3>
                                    {weeklyReport && (
                                        <p className="text-xs text-gray-400 mt-0.5">
                                            {weeklyReport.weekDates}
                                            {weeklyReport.generatedAt && ` · Generated ${new Date(weeklyReport.generatedAt).toLocaleDateString()}`}
                                        </p>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    {weeklyReportHistory.length > 1 && (
                                        <select
                                            value={selectedReportId ?? ''}
                                            onChange={async (e) => {
                                                const id = Number(e.target.value);
                                                if (!id) { setSelectedReportId(null); return; }
                                                setSelectedReportId(id);
                                                setWeeklyReportLoading(true);
                                                try {
                                                    const base = getApiBaseUrl();
                                                    const r = await fetch(`${base}/api/performance/trading-report/${id}`, { headers: { Authorization: `Bearer ${token}` } });
                                                    if (r.ok) setWeeklyReport(await r.json());
                                                } finally { setWeeklyReportLoading(false); }
                                            }}
                                            className="text-xs border border-gray-300 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                                        >
                                            <option value="">Latest</option>
                                            {weeklyReportHistory.map(h => (
                                                <option key={h.id} value={h.id}>{h.weekStart} — {h.weekEnd}</option>
                                            ))}
                                        </select>
                                    )}
                                    <button
                                        onClick={async () => {
                                            setWeeklyReportGenerating(true);
                                            try {
                                                const base = getApiBaseUrl();
                                                const r = await fetch(`${base}/api/performance/trading-report/generate`, {
                                                    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
                                                });
                                                if (r.ok) { const d = await r.json(); if (d.report) setWeeklyReport(d.report); }
                                            } finally { setWeeklyReportGenerating(false); }
                                        }}
                                        disabled={weeklyReportGenerating}
                                        className="text-xs px-3 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-lg transition-colors"
                                    >
                                        {weeklyReportGenerating ? 'Generating…' : 'Regenerate'}
                                    </button>
                                </div>
                            </div>

                            {weeklyReportLoading ? (
                                <div className="p-8 text-center"><div className="animate-spin w-6 h-6 border-4 border-indigo-600 border-t-transparent rounded-full mx-auto" /></div>
                            ) : !weeklyReport ? (
                                <div className="p-8 text-center text-gray-400 text-sm">No weekly report yet. Reports are auto-generated every Friday at 3:45 PM ET.</div>
                            ) : (
                                <div className="p-4 space-y-4">
                                    {/* Summary row */}
                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                        {[
                                            { label: 'Realized P&L', value: fmtUsd(weeklyReport.summary.realizedPnl), color: pnlColor(weeklyReport.summary.realizedPnl) },
                                            { label: 'Win Rate', value: `${weeklyReport.summary.winRate}%`, color: weeklyReport.summary.winRate >= 50 ? 'text-green-600' : 'text-red-600' },
                                            { label: 'Profit Factor', value: weeklyReport.summary.profitFactor != null ? weeklyReport.summary.profitFactor.toFixed(2) + 'x' : '—', color: (weeklyReport.summary.profitFactor ?? 0) >= 1 ? 'text-green-600' : 'text-red-600' },
                                            { label: 'Open Positions', value: String(weeklyReport.summary.openPositions), color: 'text-gray-900 dark:text-white' },
                                        ].map(k => (
                                            <div key={k.label} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                                                <div className="text-xs text-gray-500 uppercase font-semibold tracking-wide mb-1">{k.label}</div>
                                                <div className={`text-lg font-bold ${k.color}`}>{k.value}</div>
                                            </div>
                                        ))}
                                    </div>

                                    {/* Market context + Alpha */}
                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Market Context (Week)</div>
                                            <div className="flex gap-4 text-sm">
                                                {(['spy', 'qqq', 'iwm'] as const).map(sym => (
                                                    <div key={sym}>
                                                        <span className="text-gray-500 uppercase text-xs">{sym} </span>
                                                        <span className={`font-bold ${pnlColor(weeklyReport.marketContext[sym])}`}>
                                                            {weeklyReport.marketContext[sym] != null ? `${weeklyReport.marketContext[sym]! >= 0 ? '+' : ''}${weeklyReport.marketContext[sym]!.toFixed(2)}%` : '—'}
                                                        </span>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Alpha vs SPY</div>
                                            <div className="text-sm space-y-1">
                                                <div>
                                                    <span className="text-gray-500">Avg alpha: </span>
                                                    <span className={`font-bold ${pnlColor(weeklyReport.alphaCapture.avgAlpha)}`}>
                                                        {weeklyReport.alphaCapture.avgAlpha != null ? `${weeklyReport.alphaCapture.avgAlpha >= 0 ? '+' : ''}${weeklyReport.alphaCapture.avgAlpha.toFixed(2)}%` : '—'}
                                                    </span>
                                                </div>
                                                <div className="text-gray-500">
                                                    {weeklyReport.alphaCapture.beatingSpyCount} of {weeklyReport.alphaCapture.totalPositions} positions beating SPY
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Insights */}
                                    {weeklyReport.insights.length > 0 && (
                                        <div className="bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-700 rounded-lg p-3">
                                            <div className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 uppercase tracking-wide mb-2">Key Insights</div>
                                            <ul className="space-y-1">
                                                {weeklyReport.insights.map((ins, i) => (
                                                    <li key={i} className="text-sm text-indigo-800 dark:text-indigo-200 flex gap-2">
                                                        <span className="shrink-0 text-indigo-400">•</span>{ins}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}

                                    {/* Closed trades + Score buckets in 2 cols */}
                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                        {/* Closed trades */}
                                        {weeklyReport.closedTrades.length > 0 && (
                                            <div>
                                                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Closed Trades ({weeklyReport.closedTrades.length})</div>
                                                <div className="overflow-x-auto">
                                                    <table className="w-full text-xs">
                                                        <thead>
                                                            <tr className="text-gray-400 border-b border-gray-100 dark:border-gray-700">
                                                                <th className="text-left py-1 pr-2">Symbol</th>
                                                                <th className="text-left py-1 pr-2">Sector</th>
                                                                <th className="text-right py-1 pr-2">Price</th>
                                                                <th className="text-right py-1 pr-2">P&L</th>
                                                                <th className="text-right py-1 pr-2">Score</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {weeklyReport.closedTrades.map((t, i) => (
                                                                <tr key={i} className="border-b border-gray-50 dark:border-gray-800">
                                                                    <td className="py-1 pr-2 font-semibold text-gray-900 dark:text-white">{t.symbol}</td>
                                                                    <td className="py-1 pr-2 text-gray-500">{t.sector}</td>
                                                                    <td className="py-1 pr-2 text-right text-gray-600">${t.price.toFixed(2)}</td>
                                                                    <td className={`py-1 pr-2 text-right font-semibold ${pnlColor(t.pnl)}`}>{fmtUsd(t.pnl)} ({t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(1)}%)</td>
                                                                    <td className="py-1 pr-2 text-right text-gray-500">{t.aiScore ?? '—'}</td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>
                                        )}

                                        {/* Score buckets */}
                                        {weeklyReport.scoreBuckets.length > 0 && (
                                            <div>
                                                <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Score Bucket Performance (All-Time)</div>
                                                <div className="space-y-2">
                                                    {weeklyReport.scoreBuckets.map(b => (
                                                        <div key={b.bucket} className="flex items-center gap-2">
                                                            <span className="text-xs font-mono text-gray-600 dark:text-gray-400 w-16 shrink-0">{b.bucket}</span>
                                                            <div className="flex-1 bg-gray-100 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
                                                                <div className="h-2 rounded-full bg-indigo-500" style={{ width: `${b.winRate}%` }} />
                                                            </div>
                                                            <span className={`text-xs font-bold w-10 text-right ${b.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>{b.winRate}%</span>
                                                            <span className="text-xs text-gray-400">n={b.total}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    {/* Open positions with alpha */}
                                    {weeklyReport.openPositions.length > 0 && (
                                        <div>
                                            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Open Positions — Alpha vs SPY</div>
                                            <div className="overflow-x-auto">
                                                <table className="w-full text-xs">
                                                    <thead>
                                                        <tr className="text-gray-400 border-b border-gray-100 dark:border-gray-700">
                                                            <th className="text-left py-1 pr-2">Symbol</th>
                                                            <th className="text-left py-1 pr-2">Sector</th>
                                                            <th className="text-right py-1 pr-2">Entry</th>
                                                            <th className="text-right py-1 pr-2">Current</th>
                                                            <th className="text-right py-1 pr-2">Return</th>
                                                            <th className="text-right py-1 pr-2">Alpha vs SPY</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {weeklyReport.openPositions.map((p, i) => (
                                                            <tr key={i} className="border-b border-gray-50 dark:border-gray-800">
                                                                <td className="py-1 pr-2 font-semibold text-gray-900 dark:text-white">{p.symbol}</td>
                                                                <td className="py-1 pr-2 text-gray-500">{p.sector}</td>
                                                                <td className="py-1 pr-2 text-right text-gray-600">${p.entryPrice.toFixed(2)}</td>
                                                                <td className="py-1 pr-2 text-right text-gray-600">${p.currentPrice.toFixed(2)}</td>
                                                                <td className={`py-1 pr-2 text-right font-semibold ${pnlColor(p.gainLossPct)}`}>
                                                                    {p.gainLossPct >= 0 ? '+' : ''}{p.gainLossPct.toFixed(1)}%
                                                                </td>
                                                                <td className={`py-1 pr-2 text-right font-bold ${p.alpha == null ? 'text-gray-400' : pnlColor(p.alpha)}`}>
                                                                    {p.alpha != null ? `${p.alpha >= 0 ? '+' : ''}${p.alpha.toFixed(2)}%` : '—'}
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* ── Trade Attribution ─────────────────────────────────────────────── */}
                        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
                                <div>
                                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Trade Attribution</h3>
                                    <p className="text-xs text-gray-400 mt-0.5">Why trades won or lost — by score, sector, regime, hold period, exit reason</p>
                                </div>
                                <div className="flex items-center gap-2">
                                    <select
                                        value={tradeAttributionOutcome}
                                        onChange={e => {
                                            setTradeAttributionOutcome(e.target.value);
                                            loadTradeAttribution(tradeAttributionDays, e.target.value);
                                        }}
                                        className="text-xs border border-gray-300 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                                    >
                                        <option value="">All outcomes</option>
                                        <option value="win">Wins only</option>
                                        <option value="loss">Losses only</option>
                                        <option value="breakeven">Breakeven</option>
                                    </select>
                                    <select
                                        value={tradeAttributionDays}
                                        onChange={e => {
                                            const d = Number(e.target.value);
                                            setTradeAttributionDays(d);
                                            loadTradeAttribution(d, tradeAttributionOutcome);
                                        }}
                                        className="text-xs border border-gray-300 rounded-lg px-2 py-1 bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                                    >
                                        <option value={30}>30 days</option>
                                        <option value={90}>90 days</option>
                                        <option value={180}>180 days</option>
                                        <option value={365}>1 year</option>
                                    </select>
                                </div>
                            </div>

                            {tradeAttributionLoading ? (
                                <div className="p-8 text-center"><div className="animate-spin w-6 h-6 border-4 border-indigo-600 border-t-transparent rounded-full mx-auto" /></div>
                            ) : !tradeAttribution || tradeAttribution.totalClosed === 0 ? (
                                <div className="p-8 text-center text-gray-400 text-sm">No closed trades with attribution data yet. Data populates as the bot exits positions.</div>
                            ) : (
                                <div className="p-4 space-y-4">
                                    {/* Post-exit drift summary banner */}
                                    {tradeAttribution.postExitSummary.tradesWithDriftData > 0 && (
                                        <div className="flex flex-wrap gap-4 bg-gray-50 dark:bg-gray-800/50 rounded-lg px-4 py-3 text-xs">
                                            <div>
                                                <span className="text-gray-500">Avg price drift 5d after exit: </span>
                                                <span className={`font-bold ${pnlColor(tradeAttribution.postExitSummary.avgDrift5d)}`}>
                                                    {tradeAttribution.postExitSummary.avgDrift5d != null
                                                        ? `${tradeAttribution.postExitSummary.avgDrift5d >= 0 ? '+' : ''}${tradeAttribution.postExitSummary.avgDrift5d.toFixed(2)}%`
                                                        : '—'}
                                                </span>
                                            </div>
                                            <div>
                                                <span className="text-gray-500">10d after exit: </span>
                                                <span className={`font-bold ${pnlColor(tradeAttribution.postExitSummary.avgDrift10d)}`}>
                                                    {tradeAttribution.postExitSummary.avgDrift10d != null
                                                        ? `${tradeAttribution.postExitSummary.avgDrift10d >= 0 ? '+' : ''}${tradeAttribution.postExitSummary.avgDrift10d.toFixed(2)}%`
                                                        : '—'}
                                                </span>
                                            </div>
                                            <div className="text-gray-400">
                                                {tradeAttribution.postExitSummary.avgDrift5d != null && tradeAttribution.postExitSummary.avgDrift5d > 1
                                                    ? 'Exits may be slightly early — stocks continued higher after close'
                                                    : tradeAttribution.postExitSummary.avgDrift5d != null && tradeAttribution.postExitSummary.avgDrift5d < -1
                                                    ? 'Exit timing looks good — stocks declined after close'
                                                    : 'Exit timing looks neutral'}
                                                {' '}({tradeAttribution.postExitSummary.tradesWithDriftData} trades with data)
                                            </div>
                                        </div>
                                    )}

                                    {/* Tab row */}
                                    <div className="flex gap-1 flex-wrap">
                                        {(['byScore', 'byConfidence', 'bySector', 'byRegime', 'byExit', 'byHold', 'trades'] as const).map(tab => (
                                            <button
                                                key={tab}
                                                onClick={() => setTradeAttributionTab(tab)}
                                                className={`text-xs px-3 py-1 rounded-full border transition-colors ${tradeAttributionTab === tab
                                                    ? 'bg-indigo-600 text-white border-indigo-600'
                                                    : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-indigo-400'}`}
                                            >
                                                {tab === 'byScore' ? 'Score Bucket'
                                                    : tab === 'byConfidence' ? 'Confidence'
                                                    : tab === 'bySector' ? 'Sector'
                                                    : tab === 'byRegime' ? 'Regime'
                                                    : tab === 'byExit' ? 'Exit Reason'
                                                    : tab === 'byHold' ? 'Hold Period'
                                                    : 'Trade List'}
                                            </button>
                                        ))}
                                        <span className="ml-auto text-xs text-gray-400 self-center">{tradeAttribution.totalClosed} closed trades</span>
                                    </div>

                                    {/* Aggregation table — Exit Reason tab shows Exit Quality Dashboard */}
                                    {tradeAttributionTab !== 'trades' && (() => {
                                        const rows: TradeAttributionAgg[] = tradeAttribution[tradeAttributionTab] || [];
                                        const isExitTab = tradeAttributionTab === 'byExit';
                                        if (!rows.length) return <div className="text-xs text-gray-400 text-center py-4">No data</div>;

                                        // Exit Quality interpretation banner
                                        const exitBanner = isExitTab ? (() => {
                                            const stopRow = rows.find(r =>
                                                r.bucket === 'stopped_out' || r.bucket === 'stop' || r.bucket.toLowerCase().includes('stop')
                                            );
                                            const targetRow = rows.find(r =>
                                                r.bucket === 'target_hit' || r.bucket === 'profit_target' || r.bucket.toLowerCase().includes('target')
                                            );
                                            const hasDrift = rows.some(r => r.driftSampleCount && r.driftSampleCount > 0);
                                            if (!hasDrift) return null;

                                            const messages: string[] = [];
                                            if (stopRow?.avgDrift10d != null) {
                                                if (stopRow.avgDrift10d > 2) {
                                                    messages.push(`Stopped-out positions gained +${stopRow.avgDrift10d.toFixed(1)}% on average within 10 days. Trailing stops may be too tight.`);
                                                } else if (stopRow.avgDrift10d < -2) {
                                                    messages.push(`Stopped-out positions fell ${stopRow.avgDrift10d.toFixed(1)}% further within 10 days. Stop timing looks effective.`);
                                                } else {
                                                    messages.push(`Stopped-out positions were flat post-exit (${stopRow.avgDrift10d.toFixed(1)}% drift). Stop timing is neutral.`);
                                                }
                                            }
                                            if (targetRow?.avgDrift10d != null) {
                                                if (targetRow.avgDrift10d < -1) {
                                                    messages.push(`Target exits: stocks fell ${targetRow.avgDrift10d.toFixed(1)}% after exit — targets are capturing near-peak prices.`);
                                                } else if (targetRow.avgDrift10d > 2) {
                                                    messages.push(`Target exits: stocks continued +${targetRow.avgDrift10d.toFixed(1)}% after exit — targets may be set too conservatively.`);
                                                }
                                            }
                                            if (!messages.length) return null;
                                            return (
                                                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg p-3 mb-3">
                                                    <div className="text-xs font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wide mb-1">Exit Quality Verdict</div>
                                                    {messages.map((m, i) => (
                                                        <div key={i} className="text-xs text-amber-800 dark:text-amber-200 flex gap-2 mt-1">
                                                            <span className="shrink-0 text-amber-500">→</span>{m}
                                                        </div>
                                                    ))}
                                                </div>
                                            );
                                        })() : null;

                                        return (
                                            <div>
                                                {exitBanner}
                                                <div className="overflow-x-auto">
                                                    <table className="w-full text-xs">
                                                        <thead>
                                                            <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-800">
                                                                <th className="pb-2 pr-3">Bucket</th>
                                                                <th className="pb-2 pr-3 text-right">Trades</th>
                                                                <th className="pb-2 pr-3 text-right">Win%</th>
                                                                <th className="pb-2 pr-3 text-right">Avg Ret</th>
                                                                <th className="pb-2 pr-3 text-right">Expectancy</th>
                                                                <th className="pb-2 pr-3 text-right">Total P&L</th>
                                                                <th className="pb-2 pr-3 text-right">Avg Win%</th>
                                                                <th className="pb-2 pr-3 text-right">Avg Loss%</th>
                                                                {isExitTab && <th className="pb-2 pr-3 text-right">+5d Drift</th>}
                                                                {isExitTab && <th className="pb-2 text-right">+10d Drift</th>}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {rows.map(r => {
                                                                const barW = Math.round(Math.min(100, r.winRate));
                                                                return (
                                                                    <tr key={r.bucket} className="border-b border-gray-50 dark:border-gray-800">
                                                                        <td className="py-2 pr-3">
                                                                            <div className="font-medium text-gray-800 dark:text-gray-200">{titleize(r.bucket)}</div>
                                                                            <div className="mt-0.5 h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full w-24 overflow-hidden">
                                                                                <div className={`h-full rounded-full ${r.winRate >= 60 ? 'bg-green-500' : r.winRate >= 40 ? 'bg-yellow-500' : 'bg-red-500'}`} style={{ width: `${barW}%` }} />
                                                                            </div>
                                                                        </td>
                                                                        <td className="py-2 pr-3 text-right text-gray-600 dark:text-gray-400">{r.total}</td>
                                                                        <td className={`py-2 pr-3 text-right font-semibold ${r.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>{r.winRate.toFixed(0)}%</td>
                                                                        <td className={`py-2 pr-3 text-right ${pnlColor(r.avgReturn)}`}>{fmt(r.avgReturn)}%</td>
                                                                        <td className={`py-2 pr-3 text-right font-bold ${pnlColor(r.expectancyPct)}`} title="(WinRate × AvgWin%) − (LossRate × |AvgLoss%|)">
                                                                            {fmt(r.expectancyPct)}%
                                                                        </td>
                                                                        <td className={`py-2 pr-3 text-right font-semibold ${pnlColor(r.totalPnl)}`}>{fmtUsd(r.totalPnl)}</td>
                                                                        <td className="py-2 pr-3 text-right text-green-600">{r.avgWinPct !== 0 ? `+${r.avgWinPct.toFixed(1)}%` : '—'}</td>
                                                                        <td className={`py-2 ${isExitTab ? 'pr-3' : ''} text-right text-red-600`}>{r.avgLossPct !== 0 ? `${r.avgLossPct.toFixed(1)}%` : '—'}</td>
                                                                        {isExitTab && (
                                                                            <td className={`py-2 pr-3 text-right font-semibold ${r.avgDrift5d == null ? 'text-gray-300' : pnlColor(r.avgDrift5d != null ? -r.avgDrift5d : null)}`}
                                                                                title="Avg price move 5 days after this exit type — negative = stocks fell (good exit)">
                                                                                {r.avgDrift5d != null ? `${r.avgDrift5d >= 0 ? '+' : ''}${r.avgDrift5d.toFixed(1)}%` : '—'}
                                                                            </td>
                                                                        )}
                                                                        {isExitTab && (
                                                                            <td className={`py-2 text-right font-semibold ${r.avgDrift10d == null ? 'text-gray-300' : pnlColor(r.avgDrift10d != null ? -r.avgDrift10d : null)}`}
                                                                                title="Avg price move 10 days after this exit type">
                                                                                {r.avgDrift10d != null
                                                                                    ? `${r.avgDrift10d >= 0 ? '+' : ''}${r.avgDrift10d.toFixed(1)}%`
                                                                                    : r.driftSampleCount === 0 ? 'no data' : '—'}
                                                                            </td>
                                                                        )}
                                                                    </tr>
                                                                );
                                                            })}
                                                        </tbody>
                                                    </table>
                                                    <div className="text-xs text-gray-400 mt-2 px-1">
                                                        Expectancy = (Win% × Avg Win%) − (Loss% × |Avg Loss%|). Positive = edge in this bucket.
                                                        {isExitTab && ' Drift columns: green = stock fell after exit (good). Red = stock rose further (exited too early).'}
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })()}

                                    {/* Per-trade list with post-exit drift columns */}
                                    {tradeAttributionTab === 'trades' && (
                                        <div className="overflow-x-auto">
                                            <table className="w-full text-xs">
                                                <thead>
                                                    <tr className="text-left text-gray-400 border-b border-gray-100 dark:border-gray-800">
                                                        <th className="pb-2 pr-2">Symbol</th>
                                                        <th className="pb-2 pr-2 text-right">Score</th>
                                                        <th className="pb-2 pr-2">Outcome</th>
                                                        <th className="pb-2 pr-2 text-right">P&L</th>
                                                        <th className="pb-2 pr-2 text-right">Ret%</th>
                                                        <th className="pb-2 pr-2">Exit Reason</th>
                                                        <th className="pb-2 pr-2">Sector</th>
                                                        <th className="pb-2 pr-2 text-right">Hold</th>
                                                        <th className="pb-2 pr-2 text-right">+5d</th>
                                                        <th className="pb-2 pr-2 text-right">+10d</th>
                                                        <th className="pb-2 text-right">ATR%</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {tradeAttribution.trades.map(t => (
                                                        <tr key={t.id} className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                                            <td className="py-1.5 pr-2 font-semibold text-gray-900 dark:text-white">{t.symbol}</td>
                                                            <td className={`py-1.5 pr-2 text-right font-mono ${(t.score ?? 0) >= 90 ? 'text-green-600' : (t.score ?? 0) >= 80 ? 'text-yellow-600' : 'text-gray-500'}`}>
                                                                {t.score != null ? t.score.toFixed(0) : '—'}
                                                            </td>
                                                            <td className="py-1.5 pr-2">
                                                                <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${t.outcome === 'win' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : t.outcome === 'loss' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'}`}>
                                                                    {t.outcome ?? '—'}
                                                                </span>
                                                            </td>
                                                            <td className={`py-1.5 pr-2 text-right font-semibold ${pnlColor(t.pnl)}`}>{t.pnl != null ? fmtUsd(t.pnl) : '—'}</td>
                                                            <td className={`py-1.5 pr-2 text-right ${pnlColor(t.pnlPct)}`}>{t.pnlPct != null ? `${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct.toFixed(1)}%` : '—'}</td>
                                                            <td className="py-1.5 pr-2 text-gray-600 dark:text-gray-400">{t.winLossReason ? titleize(t.winLossReason) : (t.exitReason ? titleize(t.exitReason) : '—')}</td>
                                                            <td className="py-1.5 pr-2 text-gray-500">{t.sector ?? '—'}</td>
                                                            <td className="py-1.5 pr-2 text-right text-gray-500">{t.holdDays != null ? `${t.holdDays}d` : '—'}</td>
                                                            <td className={`py-1.5 pr-2 text-right ${t.postExitDrift5d == null ? 'text-gray-300' : pnlColor(-(t.postExitDrift5d))}`}
                                                                title="Price change 5 days after exit — negative means we exited well">
                                                                {t.postExitDrift5d != null ? `${t.postExitDrift5d >= 0 ? '+' : ''}${t.postExitDrift5d.toFixed(1)}%` : '—'}
                                                            </td>
                                                            <td className={`py-1.5 pr-2 text-right ${t.postExitDrift10d == null ? 'text-gray-300' : pnlColor(-(t.postExitDrift10d))}`}
                                                                title="Price change 10 days after exit">
                                                                {t.postExitDrift10d != null ? `${t.postExitDrift10d >= 0 ? '+' : ''}${t.postExitDrift10d.toFixed(1)}%` : '—'}
                                                            </td>
                                                            <td className="py-1.5 text-right text-gray-500">{t.atrPct != null ? `${t.atrPct.toFixed(1)}%` : '—'}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                            <div className="text-xs text-gray-400 mt-2 px-1">+5d / +10d = price drift after your exit. Green = price fell (good exit). Red = price rose further (left money on table).</div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Daily History Table */}
                        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Daily Breakdown</h3>
                            </div>
                            <div className="overflow-x-auto">
                                <table className="w-full text-sm">
                                    <thead>
                                        <tr className="text-xs text-gray-500 uppercase border-b border-gray-100 dark:border-gray-800">
                                            {['Date', 'Trades', 'W / L', 'Win Rate', 'P&L', 'Sharpe', 'Prof. Factor'].map(h => (
                                                <th key={h} className="text-left px-4 py-2 font-semibold">{h}</th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {history.length === 0 ? (
                                            <tr><td colSpan={7} className="text-center py-8 text-gray-400">No data for this period</td></tr>
                                        ) : (
                                            [...history].reverse().map(d => (
                                                <tr key={d.date} className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50">
                                                    <td className="px-4 py-2 font-medium text-gray-900 dark:text-white">{d.date}</td>
                                                    <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{d.trades || 0}</td>
                                                    <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{d.wins || 0} / {d.losses || 0}</td>
                                                    <td className={`px-4 py-2 font-medium ${Number(d.winRate) >= 52 ? 'text-green-600' : 'text-red-600'}`}>
                                                        {d.winRate ? Number(d.winRate).toFixed(1) + '%' : '—'}
                                                    </td>
                                                    <td className={`px-4 py-2 font-medium ${pnlColor(d.pnl)}`}>{fmtUsd(d.pnl)}</td>
                                                    <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{d.sharpeRatio ? Number(d.sharpeRatio).toFixed(2) : '—'}</td>
                                                    <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{d.profitFactor ? Number(d.profitFactor).toFixed(2) : '—'}</td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        {/* Kelly + Circuit Breakers */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Kelly */}
                            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Kelly Criterion (Position Sizing)</h3>
                                {scorecard?.kelly ? (
                                    <div className="space-y-2 text-sm">
                                        <div className="flex justify-between"><span className="text-gray-500">Win rate (90d)</span><span className="font-medium">{Number(scorecard.kelly.winRate).toFixed(1)}%</span></div>
                                        <div className="flex justify-between"><span className="text-gray-500">Avg win</span><span className="font-medium text-green-600">{fmtUsd(scorecard.kelly.avgWin)}</span></div>
                                        <div className="flex justify-between"><span className="text-gray-500">Avg loss</span><span className="font-medium text-red-600">{fmtUsd(scorecard.kelly.avgLoss)}</span></div>
                                        <div className="flex justify-between border-t pt-2 dark:border-gray-700"><span className="text-gray-500">Trades (90d)</span><span className="font-medium">{scorecard.kelly.totalTrades}</span></div>
                                    </div>
                                ) : (
                                    <p className="text-sm text-gray-400">Need at least 10 closed trades to compute Kelly fraction.</p>
                                )}
                            </div>

                            {/* Circuit Breakers */}
                            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Risk Status</h3>
                                <div className="space-y-2 text-sm">
                                    {[
                                        { label: 'Circuit breaker', active: scorecard?.risk?.circuitBreakerActive },
                                        { label: `Drawdown: ${scorecard?.risk?.currentDrawdownPct?.toFixed(1) ?? '0.0'}%`, active: (scorecard?.risk?.currentDrawdownPct ?? 0) < -10 },
                                        { label: `Consecutive losses: ${scorecard?.risk?.consecutiveLosses ?? 0}`, active: (scorecard?.risk?.consecutiveLosses ?? 0) >= 3 },
                                    ].map(c => (
                                        <div key={c.label} className="flex items-center justify-between">
                                            <span className="text-gray-600 dark:text-gray-400">{c.label}</span>
                                            <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${c.active ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}>
                                                {c.active ? 'CAUTION' : 'OK'}
                                            </span>
                                        </div>
                                    ))}
                                </div>

                                {/* Balance sync */}
                                <div className="mt-4 border-t pt-4 dark:border-gray-700">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs text-gray-500">Balance shows $0?</span>
                                        <button
                                            onClick={syncBalance}
                                            disabled={syncing}
                                            className="text-xs px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg transition-colors disabled:opacity-50"
                                        >
                                            {syncing ? 'Syncing...' : 'Sync Balance'}
                                        </button>
                                    </div>
                                    {syncMsg && <p className="text-xs text-green-600 mt-1">{syncMsg}</p>}
                                </div>
                            </div>
                        </div>

                        {/* AI Learning */}
                        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-4">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">AI Learning Loop</h3>
                                    <p className="text-xs text-gray-500 dark:text-gray-400">
                                        Decision-journal expectancy, regime fit, and recent-vs-prior edge shifts across the last {intelligence?.lookbackDays || intelligenceDays} days
                                    </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <select
                                        value={intelligenceDays}
                                        onChange={(e) => setIntelligenceDays(Number(e.target.value))}
                                        className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                                    >
                                        <option value={30}>30 days</option>
                                        <option value={60}>60 days</option>
                                        <option value={90}>90 days</option>
                                        <option value={180}>180 days</option>
                                        <option value={365}>365 days</option>
                                    </select>
                                    <select
                                        value={intelligenceBotType}
                                        onChange={(e) => {
                                            setIntelligenceBotType(e.target.value);
                                            setIntelligenceRegime('all');
                                        }}
                                        className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                                    >
                                        <option value="all">All bots</option>
                                        <option value="stock">Stock bot</option>
                                        <option value="options">Options bot</option>
                                    </select>
                                    <select
                                        value={intelligenceRegime}
                                        onChange={(e) => setIntelligenceRegime(e.target.value)}
                                        className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                                    >
                                        <option value="all">All regimes</option>
                                        {availableRegimes.map((regimeOption) => (
                                            <option key={regimeOption} value={regimeOption}>{regimeOption}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            {intelligenceOverview ? (
                                <>
                                    <div className="flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                                        <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">
                                            Scope: {titleize(intelligence?.filters?.botType || 'all')}
                                        </span>
                                        <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">
                                            Regime: {intelligence?.filters?.regime === 'all' ? 'All Regimes' : intelligence?.filters?.regime}
                                        </span>
                                        <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">
                                            Edge compare: last {intelligence?.comparisonWindowDays || Math.min(45, Math.max(14, Math.floor(intelligenceDays / 2)))}d vs prior window
                                        </span>
                                    </div>

                                    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                                        {[
                                            { label: 'Candidates', value: intelligenceOverview.candidate_count, tone: 'text-gray-900 dark:text-white' },
                                            { label: 'Executed', value: intelligenceOverview.executed_count, tone: 'text-gray-900 dark:text-white' },
                                            { label: 'Closed', value: intelligenceOverview.closed_count, tone: 'text-gray-900 dark:text-white' },
                                            { label: 'Closed Win Rate', value: pct(intelligenceOverview.closed_win_rate), tone: Number(intelligenceOverview.closed_win_rate || 0) >= 52 ? 'text-green-600' : 'text-red-600' },
                                            { label: 'Closed P&L', value: fmtUsd(intelligenceOverview.total_closed_pnl), tone: pnlColor(intelligenceOverview.total_closed_pnl) },
                                        ].map((item) => (
                                            <div key={item.label} className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-3">
                                                <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{item.label}</div>
                                                <div className={`mt-1 text-lg font-bold ${item.tone}`}>{item.value}</div>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                        <div className="rounded-lg bg-slate-50 dark:bg-gray-800/60 px-3 py-3">
                                            <div className="text-xs text-gray-500 dark:text-gray-400">Avg expectancy</div>
                                            <div className={`mt-1 text-xl font-bold ${pnlColor(intelligenceOverview.avg_expectancy)}`}>{pct(intelligenceOverview.avg_expectancy, 2)}</div>
                                        </div>
                                        <div className="rounded-lg bg-slate-50 dark:bg-gray-800/60 px-3 py-3">
                                            <div className="text-xs text-gray-500 dark:text-gray-400">Avg score adjustment</div>
                                            <div className={`mt-1 text-xl font-bold ${pnlColor(intelligenceOverview.avg_score_adjustment)}`}>{fmt(intelligenceOverview.avg_score_adjustment, 2)}</div>
                                        </div>
                                        <div className="rounded-lg bg-slate-50 dark:bg-gray-800/60 px-3 py-3">
                                            <div className="text-xs text-gray-500 dark:text-gray-400">Avg size multiplier</div>
                                            <div className="mt-1 text-xl font-bold text-gray-900 dark:text-white">{intelligenceOverview.avg_size_multiplier ? Number(intelligenceOverview.avg_size_multiplier).toFixed(3) : '—'}</div>
                                        </div>
                                    </div>

                                    {(intelligence.byBotType || []).length > 0 && intelligence?.filters?.botType === 'all' && (
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                            {intelligence.byBotType.map((row) => (
                                                <div key={row.botType} className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-3">
                                                    <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{titleize(row.botType)}</div>
                                                    <div className="mt-2 flex items-center justify-between text-sm">
                                                        <span className="text-gray-500 dark:text-gray-400">Closed trades</span>
                                                        <span className="font-semibold text-gray-900 dark:text-white">{row.closedCount || 0}</span>
                                                    </div>
                                                    <div className="mt-1 flex items-center justify-between text-sm">
                                                        <span className="text-gray-500 dark:text-gray-400">Win rate</span>
                                                        <span className={`font-semibold ${Number(row.winRate || 0) >= 52 ? 'text-green-600' : 'text-red-600'}`}>{pct(row.winRate)}</span>
                                                    </div>
                                                    <div className="mt-1 flex items-center justify-between text-sm">
                                                        <span className="text-gray-500 dark:text-gray-400">Closed P&L</span>
                                                        <span className={`font-semibold ${pnlColor(row.totalPnl)}`}>{fmtUsd(row.totalPnl)}</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                                        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                                            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Current Edge: Improving</div>
                                            {improvingEdge.length === 0 ? (
                                                <div className="text-sm text-gray-400">No improving setup families for this filter window yet.</div>
                                            ) : (
                                                <div className="space-y-2">
                                                    {improvingEdge.map((row, index) => (
                                                        <div key={`${row.botType}-${row.strategyFamily}-${row.setupFamily}-up-${index}`} className="rounded-lg bg-emerald-50 dark:bg-emerald-900/10 px-3 py-3">
                                                            <div className="flex items-center justify-between gap-3">
                                                                <div>
                                                                    <div className="text-sm font-semibold text-gray-900 dark:text-white">{titleize(row.setupFamily)}</div>
                                                                    <div className="text-xs text-gray-500 dark:text-gray-400">{titleize(row.botType)} • {titleize(row.strategyFamily)} • {row.regime || 'Any regime'}</div>
                                                                </div>
                                                                <div className="text-right">
                                                                    <div className="text-xs text-gray-500 dark:text-gray-400">Return delta</div>
                                                                    <div className="text-lg font-bold text-green-600">{pct(row.returnDelta, 2)}</div>
                                                                    <button
                                                                        onClick={() => openDrilldown({
                                                                            title: compactLabel([titleize(row.setupFamily), titleize(row.strategyFamily), row.regime || 'Any regime']),
                                                                            botType: row.botType,
                                                                            regime: row.regime,
                                                                            strategyFamily: row.strategyFamily,
                                                                            setupFamily: row.setupFamily
                                                                        })}
                                                                        className="mt-2 text-xs font-semibold text-emerald-700 hover:text-emerald-900 dark:text-emerald-300 dark:hover:text-emerald-100"
                                                                    >
                                                                        Inspect journal
                                                                    </button>
                                                                </div>
                                                            </div>
                                                            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                                                                <div className="rounded bg-white/70 dark:bg-gray-800/70 px-2 py-2">
                                                                    <div className="text-gray-500 dark:text-gray-400">Recent</div>
                                                                    <div className="font-semibold text-gray-900 dark:text-white">{pct(row.recentAvgReturn, 2)} • {row.recentTrades || 0} trades</div>
                                                                </div>
                                                                <div className="rounded bg-white/70 dark:bg-gray-800/70 px-2 py-2">
                                                                    <div className="text-gray-500 dark:text-gray-400">Prior</div>
                                                                    <div className="font-semibold text-gray-900 dark:text-white">{pct(row.priorAvgReturn, 2)} • {row.priorTrades || 0} trades</div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>

                                        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                                            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Current Edge: Degrading</div>
                                            {degradingEdge.length === 0 ? (
                                                <div className="text-sm text-gray-400">No degrading setup families for this filter window yet.</div>
                                            ) : (
                                                <div className="space-y-2">
                                                    {degradingEdge.map((row, index) => (
                                                        <div key={`${row.botType}-${row.strategyFamily}-${row.setupFamily}-down-${index}`} className="rounded-lg bg-rose-50 dark:bg-rose-900/10 px-3 py-3">
                                                            <div className="flex items-center justify-between gap-3">
                                                                <div>
                                                                    <div className="text-sm font-semibold text-gray-900 dark:text-white">{titleize(row.setupFamily)}</div>
                                                                    <div className="text-xs text-gray-500 dark:text-gray-400">{titleize(row.botType)} • {titleize(row.strategyFamily)} • {row.regime || 'Any regime'}</div>
                                                                </div>
                                                                <div className="text-right">
                                                                    <div className="text-xs text-gray-500 dark:text-gray-400">Return delta</div>
                                                                    <div className="text-lg font-bold text-red-600">{pct(row.returnDelta, 2)}</div>
                                                                    <button
                                                                        onClick={() => openDrilldown({
                                                                            title: compactLabel([titleize(row.setupFamily), titleize(row.strategyFamily), row.regime || 'Any regime']),
                                                                            botType: row.botType,
                                                                            regime: row.regime,
                                                                            strategyFamily: row.strategyFamily,
                                                                            setupFamily: row.setupFamily
                                                                        })}
                                                                        className="mt-2 text-xs font-semibold text-rose-700 hover:text-rose-900 dark:text-rose-300 dark:hover:text-rose-100"
                                                                    >
                                                                        Inspect journal
                                                                    </button>
                                                                </div>
                                                            </div>
                                                            <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                                                                <div className="rounded bg-white/70 dark:bg-gray-800/70 px-2 py-2">
                                                                    <div className="text-gray-500 dark:text-gray-400">Recent</div>
                                                                    <div className="font-semibold text-gray-900 dark:text-white">{pct(row.recentAvgReturn, 2)} • {row.recentTrades || 0} trades</div>
                                                                </div>
                                                                <div className="rounded bg-white/70 dark:bg-gray-800/70 px-2 py-2">
                                                                    <div className="text-gray-500 dark:text-gray-400">Prior</div>
                                                                    <div className="font-semibold text-gray-900 dark:text-white">{pct(row.priorAvgReturn, 2)} • {row.priorTrades || 0} trades</div>
                                                                </div>
                                                            </div>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                        <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                                            <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-700 dark:text-gray-300">Best Setup Families</div>
                                            <div className="overflow-x-auto">
                                                <table className="w-full text-sm">
                                                    <thead>
                                                        <tr className="text-xs text-gray-500 uppercase">
                                                            {['Setup', 'Strategy', 'Regime', 'Trades', 'Win %', 'Exp', 'P&L'].map((header) => (
                                                                <th key={header} className="text-left px-3 py-2">{header}</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {(intelligence.topSetups || []).length === 0 ? (
                                                            <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-400">No closed setup data yet</td></tr>
                                                        ) : intelligence.topSetups.map((row, index) => (
                                                            <tr
                                                                key={`${row.botType}-${row.strategyFamily}-${row.setupFamily}-${index}`}
                                                                className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer"
                                                                onClick={() => openDrilldown({
                                                                    title: compactLabel([titleize(row.setupFamily), titleize(row.strategyFamily), row.regime || 'Any regime']),
                                                                    botType: row.botType,
                                                                    regime: row.regime,
                                                                    strategyFamily: row.strategyFamily,
                                                                    setupFamily: row.setupFamily
                                                                })}
                                                            >
                                                                <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{titleize(row.setupFamily)}</td>
                                                                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{titleize(row.strategyFamily)}</td>
                                                                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{row.regime || '—'}</td>
                                                                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{row.trades || 0}</td>
                                                                <td className={`px-3 py-2 font-medium ${Number(row.winRate || 0) >= 52 ? 'text-green-600' : 'text-red-600'}`}>{pct(row.winRate)}</td>
                                                                <td className={`px-3 py-2 font-medium ${pnlColor(row.expectancy)}`}>{pct(row.expectancy, 2)}</td>
                                                                <td className={`px-3 py-2 font-medium ${pnlColor(row.totalPnl)}`}>{fmtUsd(row.totalPnl)}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>

                                        <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                                            <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-700 dark:text-gray-300">Strategy Families</div>
                                            <div className="overflow-x-auto">
                                                <table className="w-full text-sm">
                                                    <thead>
                                                        <tr className="text-xs text-gray-500 uppercase">
                                                            {['Bot', 'Strategy', 'Trades', 'Win %', 'Avg Return', 'P&L'].map((header) => (
                                                                <th key={header} className="text-left px-3 py-2">{header}</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {(intelligence.strategyPerformance || []).length === 0 ? (
                                                            <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No strategy data yet</td></tr>
                                                        ) : intelligence.strategyPerformance.map((row, index) => (
                                                            <tr
                                                                key={`${row.botType}-${row.strategyFamily}-${index}`}
                                                                className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer"
                                                                onClick={() => openDrilldown({
                                                                    title: compactLabel([titleize(row.botType), titleize(row.strategyFamily)]),
                                                                    botType: row.botType,
                                                                    strategyFamily: row.strategyFamily
                                                                })}
                                                            >
                                                                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{titleize(row.botType)}</td>
                                                                <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{titleize(row.strategyFamily)}</td>
                                                                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{row.trades || 0}</td>
                                                                <td className={`px-3 py-2 font-medium ${Number(row.winRate || 0) >= 52 ? 'text-green-600' : 'text-red-600'}`}>{pct(row.winRate)}</td>
                                                                <td className={`px-3 py-2 font-medium ${pnlColor(row.avgReturn)}`}>{pct(row.avgReturn, 2)}</td>
                                                                <td className={`px-3 py-2 font-medium ${pnlColor(row.totalPnl)}`}>{fmtUsd(row.totalPnl)}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                                            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Regime Performance</div>
                                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                                {(intelligence.regimePerformance || []).length === 0 ? (
                                                    <div className="text-sm text-gray-400">No regime-tagged exits yet</div>
                                                ) : intelligence.regimePerformance.map((row) => (
                                                    <div key={row.regime} className="rounded-lg bg-slate-50 dark:bg-gray-800/60 px-3 py-3">
                                                        <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">{row.regime || 'Unknown'}</div>
                                                        <div className={`mt-1 text-lg font-bold ${pnlColor(row.avgReturn)}`}>{pct(row.avgReturn, 2)}</div>
                                                        <div className="text-xs text-gray-500 dark:text-gray-400">{row.trades || 0} trades • {pct(row.winRate)}</div>
                                                        <div className={`text-xs font-medium mt-1 ${pnlColor(row.totalPnl)}`}>{fmtUsd(row.totalPnl)}</div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>

                                        <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                                            <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-700 dark:text-gray-300">Recent Learned Outcomes</div>
                                            <div className="overflow-x-auto max-h-80">
                                                <table className="w-full text-sm">
                                                    <thead>
                                                        <tr className="text-xs text-gray-500 uppercase">
                                                            {['Symbol', 'Setup', 'Regime', 'P&L', 'Return', 'Closed'].map((header) => (
                                                                <th key={header} className="text-left px-3 py-2">{header}</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {(intelligence.recentClosures || []).length === 0 ? (
                                                            <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-400">No closed journal entries yet</td></tr>
                                                        ) : intelligence.recentClosures.map((row, index) => (
                                                            <tr
                                                                key={`${row.symbol}-${row.closedAt}-${index}`}
                                                                className="border-t border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer"
                                                                onClick={() => openDrilldown({
                                                                    title: compactLabel([row.symbol || 'Unknown symbol', titleize(row.setupFamily || row.strategyFamily)]),
                                                                    botType: row.botType,
                                                                    regime: row.regime,
                                                                    strategyFamily: row.strategyFamily,
                                                                    setupFamily: row.setupFamily,
                                                                    symbol: row.symbol
                                                                })}
                                                            >
                                                                <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{row.symbol}</td>
                                                                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{titleize(row.setupFamily || row.strategyFamily)}</td>
                                                                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{row.regime || '—'}</td>
                                                                <td className={`px-3 py-2 font-medium ${pnlColor(row.pnl)}`}>{fmtUsd(row.pnl)}</td>
                                                                <td className={`px-3 py-2 font-medium ${pnlColor(row.pnlPercent)}`}>{pct(row.pnlPercent, 2)}</td>
                                                                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{row.closedAt ? new Date(row.closedAt).toLocaleDateString() : '—'}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <p className="text-sm text-gray-400">No intelligence data available yet. The bots need executed and closed trades to build expectancy stats.</p>
                            )}
                        </div>

                        {/* P&L Attribution */}
                        {attribution && attribution.bySector.length > 0 && (
                            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-4">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">P&L Attribution by Sector</h3>
                                        <p className="text-xs text-gray-500 dark:text-gray-400">Closed trade outcomes grouped by sector — last {attribution.days} days. Click a row to inspect trades.</p>
                                    </div>
                                    <button
                                        onClick={() => exportAttributionCsv(attribution)}
                                        className="text-sm px-3 py-1.5 rounded-lg bg-emerald-100 hover:bg-emerald-200 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200 whitespace-nowrap"
                                    >
                                        Export CSV
                                    </button>
                                </div>

                                {/* Sector breakdown table */}
                                <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead>
                                                <tr className="text-xs text-gray-500 uppercase border-b border-gray-100 dark:border-gray-800">
                                                    {['Sector', 'Trades', 'Wins', 'Win Rate', 'vs Prior', 'Total P&L', 'vs Prior', 'Avg P&L'].map(h => (
                                                        <th key={h} className="text-left px-4 py-2 font-semibold">{h}</th>
                                                    ))}
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {(() => {
                                                    const priorMap = new Map((attribution.bySectorPrior || []).map(r => [r.sector, r]));
                                                    return attribution.bySector.map(row => {
                                                        const prior = priorMap.get(row.sector);
                                                        const wrDelta = prior != null ? row.winRate - prior.winRate : null;
                                                        const pnlDelta = prior != null ? row.totalPnl - prior.totalPnl : null;
                                                        const arrowCls = (d: number | null) =>
                                                            d == null ? 'text-gray-400' : d > 0 ? 'text-green-600' : d < 0 ? 'text-red-600' : 'text-gray-400';
                                                        const arrow = (d: number | null) =>
                                                            d == null ? '—' : d > 0 ? '↑' : d < 0 ? '↓' : '→';
                                                        return (
                                                            <tr
                                                                key={row.sector}
                                                                className="border-b border-gray-50 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/50 cursor-pointer"
                                                                onClick={() => openDrilldown({ title: `${row.sector} — Sector Trades`, sector: row.sector })}
                                                            >
                                                                <td className="px-4 py-2 font-medium text-blue-600 dark:text-blue-400 hover:underline">{row.sector}</td>
                                                                <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{row.trades}</td>
                                                                <td className="px-4 py-2 text-gray-600 dark:text-gray-400">{row.wins}</td>
                                                                <td className={`px-4 py-2 font-medium ${row.winRate >= 52 ? 'text-green-600' : 'text-red-600'}`}>{pct(row.winRate)}</td>
                                                                <td className={`px-4 py-2 font-medium ${arrowCls(wrDelta)}`}>
                                                                    {arrow(wrDelta)}{wrDelta != null ? ` ${Math.abs(wrDelta).toFixed(1)}%` : ''}
                                                                </td>
                                                                <td className={`px-4 py-2 font-medium ${pnlColor(row.totalPnl)}`}>{fmtUsd(row.totalPnl)}</td>
                                                                <td className={`px-4 py-2 font-medium ${arrowCls(pnlDelta)}`}>
                                                                    {arrow(pnlDelta)}{pnlDelta != null ? ` ${fmtUsd(Math.abs(pnlDelta))}` : ''}
                                                                </td>
                                                                <td className={`px-4 py-2 font-medium ${pnlColor(row.avgPnl)}`}>{fmtUsd(row.avgPnl)}</td>
                                                            </tr>
                                                        );
                                                    });
                                                })()}
                                            </tbody>
                                        </table>
                                    </div>
                                </div>

                                {/* Sector × Regime heatmap */}
                                {attribution.heatmap.length > 0 && (() => {
                                    const sectors = attribution.bySector.map(r => r.sector);
                                    const regimeOrder = ['BEAR', 'CHOPPY', 'NEUTRAL', 'BULL_MILD', 'BULL_STRONG'];
                                    const presentRegimes = Array.from(new Set(attribution.heatmap.map(r => r.regime)));
                                    const regimes = [
                                        ...regimeOrder.filter(r => presentRegimes.includes(r)),
                                        ...presentRegimes.filter(r => !regimeOrder.includes(r))
                                    ];
                                    const lookup = new Map(attribution.heatmap.map(r => [`${r.sector}|||${r.regime}`, r]));
                                    return (
                                        <div>
                                            <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Sector × Regime Win Rate Heatmap</div>
                                            <div className="overflow-x-auto">
                                                <div className="inline-block min-w-full">
                                                    <div className="flex">
                                                        <div className="w-36 shrink-0" />
                                                        {regimes.map(r => (
                                                            <div key={r} className="w-24 shrink-0 text-center text-xs font-semibold text-gray-500 dark:text-gray-400 py-1 uppercase">{r.replace('_', ' ')}</div>
                                                        ))}
                                                    </div>
                                                    {sectors.map(sector => (
                                                        <div key={sector} className="flex items-center">
                                                            <div className="w-36 shrink-0 text-xs font-medium text-gray-700 dark:text-gray-300 pr-2 py-1 truncate" title={sector}>{sector}</div>
                                                            {regimes.map(regime => {
                                                                const cell = lookup.get(`${sector}|||${regime}`);
                                                                if (!cell) return (
                                                                    <div key={regime} className="w-24 shrink-0 h-12 m-0.5 rounded bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                                                                        <span className="text-xs text-gray-400">—</span>
                                                                    </div>
                                                                );
                                                                const wr = cell.winRate ?? 0;
                                                                const bgClass = wr >= 60
                                                                    ? 'bg-green-100 dark:bg-green-900/30'
                                                                    : wr >= 40
                                                                        ? 'bg-yellow-100 dark:bg-yellow-900/30'
                                                                        : 'bg-red-100 dark:bg-red-900/30';
                                                                const textClass = wr >= 60
                                                                    ? 'text-green-700 dark:text-green-300'
                                                                    : wr >= 40
                                                                        ? 'text-yellow-700 dark:text-yellow-300'
                                                                        : 'text-red-700 dark:text-red-300';
                                                                return (
                                                                    <div
                                                                        key={regime}
                                                                        className={`w-24 shrink-0 h-12 m-0.5 rounded ${bgClass} flex flex-col items-center justify-center cursor-default`}
                                                                        title={`${sector} / ${regime}: ${cell.trades} trades, ${pct(cell.winRate)} WR, ${fmtUsd(cell.totalPnl)}`}
                                                                    >
                                                                        <span className={`text-xs font-bold ${textClass}`}>{pct(cell.winRate, 0)}</span>
                                                                        <span className="text-[10px] text-gray-500 dark:text-gray-400">{cell.trades}t</span>
                                                                    </div>
                                                                );
                                                            })}
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                            <div className="flex items-center gap-4 mt-2 text-xs text-gray-500 dark:text-gray-400">
                                                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-green-200 dark:bg-green-800 inline-block" /> ≥ 60% WR</span>
                                                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-yellow-200 dark:bg-yellow-800 inline-block" /> 40–60% WR</span>
                                                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-200 dark:bg-red-800 inline-block" /> &lt; 40% WR</span>
                                                <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-gray-200 dark:bg-gray-700 inline-block" /> No trades</span>
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        )}

                        {/* Go-Live Checklist */}
                        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Go-Live Readiness Checklist</h3>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                                {[
                                    { label: 'Win rate ≥ 52%', pass: avgWinRate >= 52, actual: avgWinRate.toFixed(1) + '%' },
                                    { label: 'Sharpe ratio > 1.0', pass: avgSharpe > 1, actual: avgSharpe.toFixed(2) },
                                    { label: 'No circuit breakers active', pass: !scorecard?.risk?.circuitBreakerActive, actual: '' },
                                    { label: 'Positive total P&L', pass: totalPnl > 0, actual: fmtUsd(totalPnl) },
                                    { label: '≥ 30 completed trades', pass: totalTrades >= 30, actual: totalTrades + ' trades' },
                                ].map(item => (
                                    <div key={item.label} className={`flex items-center justify-between px-3 py-2 rounded-lg ${item.pass ? 'bg-green-50 dark:bg-green-900/20' : 'bg-red-50 dark:bg-red-900/20'}`}>
                                        <div className="flex items-center gap-2">
                                            <span>{item.pass ? '✅' : '❌'}</span>
                                            <span className="text-gray-700 dark:text-gray-300">{item.label}</span>
                                        </div>
                                        {item.actual && <span className={`font-semibold ${item.pass ? 'text-green-600' : 'text-red-600'}`}>{item.actual}</span>}
                                    </div>
                                ))}
                            </div>
                        </div>
                    </>
                )}

                {/* ── Hypothesis Lab ── */}
                {hypothesis && (
                    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                        <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
                            <h2 className="text-base font-semibold text-gray-800 dark:text-white">Hypothesis Lab</h2>
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                                Validate assumptions with data — hold time, exit patterns, and score quality.
                            </p>
                        </div>
                        <div className="divide-y divide-gray-100 dark:divide-gray-800">

                            {/* 1. Hold period */}
                            <div className="px-5 py-4">
                                <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                                    Hold Period Win Rate
                                    <span className="ml-2 text-xs font-normal text-gray-400">— how long should you hold?</span>
                                </div>
                                {hypothesis.byHoldPeriod.length === 0 ? (
                                    <p className="text-xs text-gray-400">Need more closed trades.</p>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead><tr className="text-xs text-gray-500 uppercase">
                                                <th className="text-left py-1 pr-6">Period</th>
                                                <th className="text-right py-1 pr-6">Trades</th>
                                                <th className="text-right py-1 pr-6">Win %</th>
                                                <th className="text-right py-1 pr-6">Avg Return</th>
                                                <th className="text-right py-1 pr-4">Best</th>
                                                <th className="text-right py-1">Worst</th>
                                            </tr></thead>
                                            <tbody>
                                                {hypothesis.byHoldPeriod.map(r => (
                                                    <tr key={r.bucket} className="border-t border-gray-50 dark:border-gray-800/60">
                                                        <td className="py-2 pr-6 font-semibold text-gray-800 dark:text-gray-200">{r.bucket}</td>
                                                        <td className="py-2 pr-6 text-right text-gray-500">{r.total}</td>
                                                        <td className={`py-2 pr-6 text-right font-semibold ${r.winRate >= 60 ? 'text-emerald-600' : r.winRate >= 45 ? 'text-yellow-600' : 'text-red-500'}`}>{r.winRate}%</td>
                                                        <td className={`py-2 pr-6 text-right font-semibold ${r.avgReturn >= 0 ? 'text-green-600' : 'text-red-500'}`}>{r.avgReturn >= 0 ? '+' : ''}{r.avgReturn.toFixed(2)}%</td>
                                                        <td className="py-2 pr-4 text-right text-green-600">+{r.maxReturn.toFixed(1)}%</td>
                                                        <td className={`py-2 text-right ${r.minReturn < 0 ? 'text-red-500' : 'text-gray-500'}`}>{r.minReturn.toFixed(1)}%</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>

                            {/* 2. Exit reason */}
                            <div className="px-5 py-4">
                                <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                                    Exit Reason Breakdown
                                    <span className="ml-2 text-xs font-normal text-gray-400">— which exits make money?</span>
                                </div>
                                {hypothesis.byExitReason.length === 0 ? (
                                    <p className="text-xs text-gray-400">Need more closed trades.</p>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead><tr className="text-xs text-gray-500 uppercase">
                                                <th className="text-left py-1 pr-6">Exit Type</th>
                                                <th className="text-right py-1 pr-6">Trades</th>
                                                <th className="text-right py-1 pr-6">Win %</th>
                                                <th className="text-right py-1 pr-6">Avg Return</th>
                                                <th className="text-right py-1">Total P&L</th>
                                            </tr></thead>
                                            <tbody>
                                                {hypothesis.byExitReason.map(r => {
                                                    const label: Record<string, string> = {
                                                        take_profit: 'Take Profit', partial_take_profit: 'Partial Take Profit',
                                                        trailing_stop: 'Trailing Stop', stop_loss: 'Stop Loss',
                                                        break_even: 'Break-Even Guard', pre_earnings_exit: 'Pre-Earnings Exit',
                                                        max_hold_time: 'Max Hold Time', slow_mover: 'Slow Mover',
                                                        untagged: 'Untagged / Manual',
                                                    };
                                                    return (
                                                        <tr key={r.reason} className="border-t border-gray-50 dark:border-gray-800/60">
                                                            <td className="py-2 pr-6 font-semibold text-gray-800 dark:text-gray-200">{label[r.reason] ?? r.reason}</td>
                                                            <td className="py-2 pr-6 text-right text-gray-500">{r.total}</td>
                                                            <td className={`py-2 pr-6 text-right font-semibold ${r.winRate >= 60 ? 'text-emerald-600' : r.winRate >= 45 ? 'text-yellow-600' : 'text-red-500'}`}>{r.winRate}%</td>
                                                            <td className={`py-2 pr-6 text-right font-semibold ${r.avgReturn >= 0 ? 'text-green-600' : 'text-red-500'}`}>{r.avgReturn >= 0 ? '+' : ''}{r.avgReturn.toFixed(2)}%</td>
                                                            <td className={`py-2 text-right font-semibold ${r.totalPnl >= 0 ? 'text-green-600' : 'text-red-500'}`}>{r.totalPnl >= 0 ? '+$' : '-$'}{Math.abs(r.totalPnl).toFixed(0)}</td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>

                            {/* 3. Score bucket */}
                            <div className="px-5 py-4">
                                <div className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                                    Score Bucket Win Rate
                                    <span className="ml-2 text-xs font-normal text-gray-400">— does 95+ actually beat 85-89?</span>
                                </div>
                                {hypothesis.byScoreBucket.length === 0 ? (
                                    <p className="text-xs text-gray-400">Need more closed trades with scores.</p>
                                ) : (
                                    <div className="overflow-x-auto">
                                        <table className="w-full text-sm">
                                            <thead><tr className="text-xs text-gray-500 uppercase">
                                                <th className="text-left py-1 pr-6">Score Tier</th>
                                                <th className="text-right py-1 pr-6">Trades</th>
                                                <th className="text-right py-1 pr-6">Win %</th>
                                                <th className="text-right py-1 pr-6">Avg Return</th>
                                                <th className="text-right py-1">Total P&L</th>
                                            </tr></thead>
                                            <tbody>
                                                {hypothesis.byScoreBucket.map(r => (
                                                    <tr key={r.bucket} className="border-t border-gray-50 dark:border-gray-800/60">
                                                        <td className="py-2 pr-6 font-mono font-semibold text-gray-800 dark:text-gray-200">{r.bucket}</td>
                                                        <td className="py-2 pr-6 text-right text-gray-500">{r.total}</td>
                                                        <td className={`py-2 pr-6 text-right font-semibold ${r.winRate >= 60 ? 'text-emerald-600' : r.winRate >= 45 ? 'text-yellow-600' : 'text-red-500'}`}>{r.winRate}%</td>
                                                        <td className={`py-2 pr-6 text-right font-semibold ${r.avgReturn >= 0 ? 'text-green-600' : 'text-red-500'}`}>{r.avgReturn >= 0 ? '+' : ''}{r.avgReturn.toFixed(2)}%</td>
                                                        <td className={`py-2 text-right font-semibold ${r.totalPnl >= 0 ? 'text-green-600' : 'text-red-500'}`}>{r.totalPnl >= 0 ? '+$' : '-$'}{Math.abs(r.totalPnl).toFixed(0)}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    </div>
                                )}
                            </div>

                        </div>
                    </div>
                )}

            </main>

            {activeDrilldown && (
                <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={closeDrilldown}>
                    <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-2xl w-full max-w-5xl max-h-[90vh] overflow-hidden" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-gray-200 dark:border-gray-700">
                            <div>
                                <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">AI Journal Drill-Down</div>
                                <h2 className="text-xl font-bold text-gray-900 dark:text-white mt-1">{activeDrilldown.title}</h2>
                                <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                                    <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">Lookback: {intelligenceDays}d</span>
                                    {activeDrilldown.botType && <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">{titleize(activeDrilldown.botType)}</span>}
                                    {activeDrilldown.regime && <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">{activeDrilldown.regime}</span>}
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => exportDrilldown('csv')}
                                    disabled={!drilldown || drilldown.entries.length === 0}
                                    className="text-sm px-3 py-1.5 rounded-lg bg-emerald-100 hover:bg-emerald-200 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-emerald-900/30 dark:hover:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200"
                                >
                                    Export CSV
                                </button>
                                <button
                                    onClick={() => exportDrilldown('json')}
                                    disabled={!drilldown || drilldown.entries.length === 0}
                                    className="text-sm px-3 py-1.5 rounded-lg bg-blue-100 hover:bg-blue-200 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-blue-900/30 dark:hover:bg-blue-900/50 text-blue-800 dark:text-blue-200"
                                >
                                    Export JSON
                                </button>
                                <button onClick={closeDrilldown} className="text-sm px-3 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">Close</button>
                            </div>
                        </div>

                        <div className="overflow-y-auto max-h-[calc(90vh-88px)] px-5 py-4 space-y-4">
                            {drilldownLoading ? (
                                <div className="flex items-center justify-center h-40">
                                    <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full" />
                                </div>
                            ) : drilldownError ? (
                                <div className="text-sm text-red-600">{drilldownError}</div>
                            ) : drilldown ? (
                                <>
                                    <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                                        {[
                                            { label: 'Rows', value: drilldown.summary.total_rows, tone: 'text-gray-900 dark:text-white' },
                                            { label: 'Candidates', value: drilldown.summary.candidate_count, tone: 'text-gray-900 dark:text-white' },
                                            { label: 'Executed', value: drilldown.summary.executed_count, tone: 'text-gray-900 dark:text-white' },
                                            { label: 'Closed', value: drilldown.summary.closed_count, tone: 'text-gray-900 dark:text-white' },
                                            { label: 'Closed P&L', value: fmtUsd(drilldown.summary.total_closed_pnl), tone: pnlColor(drilldown.summary.total_closed_pnl) }
                                        ].map((item) => (
                                            <div key={item.label} className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-3">
                                                <div className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">{item.label}</div>
                                                <div className={`mt-1 text-lg font-bold ${item.tone}`}>{item.value}</div>
                                            </div>
                                        ))}
                                    </div>

                                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                        <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                                            <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-700 dark:text-gray-300">Phase Breakdown</div>
                                            <div className="overflow-x-auto">
                                                <table className="w-full text-sm">
                                                    <thead>
                                                        <tr className="text-xs text-gray-500 uppercase">
                                                            {['Phase', 'Count', 'Adj', 'Exp', 'Return', 'P&L'].map((header) => (
                                                                <th key={header} className="text-left px-3 py-2">{header}</th>
                                                            ))}
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {drilldown.phaseBreakdown.map((row) => (
                                                            <tr key={row.phase} className="border-t border-gray-100 dark:border-gray-800">
                                                                <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{titleize(row.phase)}</td>
                                                                <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{row.count}</td>
                                                                <td className={`px-3 py-2 font-medium ${pnlColor(row.avg_score_adjustment)}`}>{fmt(row.avg_score_adjustment, 2)}</td>
                                                                <td className={`px-3 py-2 font-medium ${pnlColor(row.avg_expectancy)}`}>{pct(row.avg_expectancy, 2)}</td>
                                                                <td className={`px-3 py-2 font-medium ${pnlColor(row.avg_return)}`}>{pct(row.avg_return, 2)}</td>
                                                                <td className={`px-3 py-2 font-medium ${pnlColor(row.total_pnl)}`}>{fmtUsd(row.total_pnl)}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>

                                        <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-3">
                                            <div>
                                                <div className="text-sm font-semibold text-gray-700 dark:text-gray-300">Filter Snapshot</div>
                                                <div className="mt-2 flex flex-wrap gap-2 text-xs text-gray-500 dark:text-gray-400">
                                                    <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">Bot: {titleize(drilldown.filters.botType)}</span>
                                                    <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">Regime: {drilldown.filters.regime === 'all' ? 'All Regimes' : drilldown.filters.regime}</span>
                                                    <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">Strategy: {titleize(drilldown.filters.strategyFamily)}</span>
                                                    <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">Setup: {titleize(drilldown.filters.setupFamily)}</span>
                                                    <span className="rounded-full bg-slate-100 dark:bg-gray-800 px-3 py-1">Symbol: {drilldown.filters.symbol === 'all' ? 'All symbols' : drilldown.filters.symbol}</span>
                                                    {drilldown.filters.sector && drilldown.filters.sector !== 'all' && (
                                                        <span className="rounded-full bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 px-3 py-1">Sector: {drilldown.filters.sector}</span>
                                                    )}
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                                                <div className="rounded-lg bg-slate-50 dark:bg-gray-800/60 px-3 py-3">
                                                    <div className="text-xs text-gray-500 dark:text-gray-400">Closed win rate</div>
                                                    <div className={`mt-1 text-xl font-bold ${Number(drilldown.summary.closed_win_rate || 0) >= 52 ? 'text-green-600' : 'text-red-600'}`}>{pct(drilldown.summary.closed_win_rate)}</div>
                                                </div>
                                                <div className="rounded-lg bg-slate-50 dark:bg-gray-800/60 px-3 py-3">
                                                    <div className="text-xs text-gray-500 dark:text-gray-400">Avg closed return</div>
                                                    <div className={`mt-1 text-xl font-bold ${pnlColor(drilldown.summary.avg_closed_return)}`}>{pct(drilldown.summary.avg_closed_return, 2)}</div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
                                        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-sm font-semibold text-gray-700 dark:text-gray-300">Journal Entries</div>
                                        <div className="overflow-auto max-h-[420px]">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="text-xs text-gray-500 uppercase">
                                                        {['Created', 'Phase', 'Symbol', 'Setup', 'Score', 'Adj', 'P&L', 'Return'].map((header) => (
                                                            <th key={header} className="text-left px-3 py-2">{header}</th>
                                                        ))}
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {drilldown.entries.length === 0 ? (
                                                        <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-400">No journal rows matched this filter.</td></tr>
                                                    ) : drilldown.entries.map((entry) => (
                                                        <tr key={entry.id} className="border-t border-gray-100 dark:border-gray-800 align-top">
                                                            <td className="px-3 py-2 text-gray-600 dark:text-gray-400 whitespace-nowrap">{entry.createdAt ? new Date(entry.createdAt).toLocaleString() : '—'}</td>
                                                            <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{titleize(entry.decisionPhase)}</td>
                                                            <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{entry.symbol || '—'}</td>
                                                            <td className="px-3 py-2 text-gray-600 dark:text-gray-400">
                                                                <div>{titleize(entry.setupFamily || entry.strategyFamily)}</div>
                                                                <div className="text-xs text-gray-400">{compactLabel([titleize(entry.botType), entry.regime || undefined]) || '—'}</div>
                                                            </td>
                                                            <td className="px-3 py-2 text-gray-600 dark:text-gray-400">{entry.score != null ? Number(entry.score).toFixed(2) : '—'}</td>
                                                            <td className={`px-3 py-2 font-medium ${pnlColor(entry.scoreAdjustment)}`}>{fmt(entry.scoreAdjustment, 2)}</td>
                                                            <td className={`px-3 py-2 font-medium ${pnlColor(entry.pnl)}`}>{fmtUsd(entry.pnl)}</td>
                                                            <td className={`px-3 py-2 font-medium ${pnlColor(entry.pnlPercent)}`}>{pct(entry.pnlPercent, 2)}</td>
                                                        </tr>
                                                    ))}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <div className="text-sm text-gray-400">No drill-down data loaded.</div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Score Calibration Modal ── */}
            {showCalibrationModal && (
                <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4">
                    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]">

                        {/* Header */}
                        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-[var(--color-border)]">
                            <div>
                                <h3 className="text-xl font-bold text-[var(--color-text-primary)]">🎯 Score Calibration</h3>
                                <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
                                    Performance by score bucket — last 90 days
                                    {currentMinBuyScore !== null && (
                                        <span className="ml-2 px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 font-semibold">
                                            Current minBuyScore: {currentMinBuyScore}
                                        </span>
                                    )}
                                </p>
                            </div>
                            <button
                                onClick={() => setShowCalibrationModal(false)}
                                className="text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] text-2xl leading-none"
                            >×</button>
                        </div>

                        {/* Body */}
                        <div className="overflow-y-auto px-6 py-4 space-y-5 flex-1">
                            {calibrationLoading && (
                                <div className="flex items-center justify-center h-40">
                                    <div className="animate-spin w-8 h-8 border-4 border-purple-600 border-t-transparent rounded-full" />
                                </div>
                            )}

                            {calibrationError && (
                                <div className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg p-3">
                                    {calibrationError}
                                </div>
                            )}

                            {calibrationApplied && (
                                <div className="text-sm text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-lg p-3 font-semibold text-center">
                                    ✅ minBuyScore updated to {calibrationData?.suggestedFloor} — closing…
                                </div>
                            )}

                            {calibrationData && !calibrationLoading && (
                                <>
                                    {/* Score Bucket Table */}
                                    <div>
                                        <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">
                                            Score Bucket Performance
                                            <span className="ml-1 font-normal normal-case">(PF → Expectancy → Avg Return → WR → MaxDD)</span>
                                        </p>
                                        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                                            <table className="w-full text-sm">
                                                <thead>
                                                    <tr className="bg-gray-50 dark:bg-gray-800/60 text-xs text-[var(--color-text-secondary)] uppercase tracking-wide">
                                                        <th className="px-3 py-2 text-left">Bucket</th>
                                                        <th className="px-3 py-2 text-right">n</th>
                                                        <th className="px-3 py-2 text-right">PF</th>
                                                        <th className="px-3 py-2 text-right">E%</th>
                                                        <th className="px-3 py-2 text-right">Avg Ret</th>
                                                        <th className="px-3 py-2 text-right">WR%</th>
                                                        <th className="px-3 py-2 text-right">MaxDD</th>
                                                        <th className="px-3 py-2 text-right">Conf</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {calibrationData.buckets.map(b => {
                                                        const isCurrent = currentMinBuyScore !== null && b.floor === currentMinBuyScore;
                                                        const isSuggested = calibrationData.suggestedFloor !== null && b.floor === calibrationData.suggestedFloor;
                                                        return (
                                                            <tr key={b.bucket}
                                                                className={`border-t border-[var(--color-border)] ${isCurrent ? 'bg-purple-50 dark:bg-purple-900/20' : isSuggested ? 'bg-green-50 dark:bg-green-900/20' : ''}`}>
                                                                <td className="px-3 py-2 font-medium text-[var(--color-text-primary)]">
                                                                    {!b.valid ? '⚪' : b.profitable ? '✅' : '❌'} {b.bucket}
                                                                    {isCurrent && <span className="ml-1 text-xs text-purple-600 dark:text-purple-400">← current</span>}
                                                                    {isSuggested && !isCurrent && <span className="ml-1 text-xs text-green-600 dark:text-green-400">← suggested</span>}
                                                                </td>
                                                                <td className="px-3 py-2 text-right text-[var(--color-text-secondary)]">{b.total}</td>
                                                                <td className={`px-3 py-2 text-right font-semibold ${b.profitFactor >= 1.1 ? 'text-green-600' : 'text-red-500'}`}>
                                                                    {b.total > 0 ? b.profitFactor.toFixed(2) : '—'}
                                                                </td>
                                                                <td className={`px-3 py-2 text-right ${b.expectancy >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                                                                    {b.total > 0 ? `${b.expectancy >= 0 ? '+' : ''}${b.expectancy.toFixed(1)}%` : '—'}
                                                                </td>
                                                                <td className={`px-3 py-2 text-right ${b.avgReturn >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                                                                    {b.total > 0 ? `${b.avgReturn >= 0 ? '+' : ''}${b.avgReturn.toFixed(1)}%` : '—'}
                                                                </td>
                                                                <td className="px-3 py-2 text-right text-[var(--color-text-secondary)]">
                                                                    {b.total > 0 ? `${b.winRate.toFixed(0)}%` : '—'}
                                                                </td>
                                                                <td className="px-3 py-2 text-right text-red-500">
                                                                    {b.maxDrawdown < 0 ? `${b.maxDrawdown.toFixed(1)}%` : '—'}
                                                                </td>
                                                                <td className="px-3 py-2 text-right text-xs text-[var(--color-text-secondary)]">{b.confidence}</td>
                                                            </tr>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </div>

                                    {/* Exit Attribution */}
                                    {calibrationData.exitAttribution && calibrationData.exitAttribution.filter(e => e.valid).length > 0 && (
                                        <div>
                                            <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Exit Type Attribution</p>
                                            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                                                <table className="w-full text-sm">
                                                    <thead>
                                                        <tr className="bg-gray-50 dark:bg-gray-800/60 text-xs text-[var(--color-text-secondary)] uppercase tracking-wide">
                                                            <th className="px-3 py-2 text-left">Exit Type</th>
                                                            <th className="px-3 py-2 text-right">n</th>
                                                            <th className="px-3 py-2 text-right">PF</th>
                                                            <th className="px-3 py-2 text-right">E%</th>
                                                            <th className="px-3 py-2 text-right">WR%</th>
                                                            <th className="px-3 py-2 text-right">Avg Hold</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {calibrationData.exitAttribution.filter(e => e.valid).map(e => (
                                                            <tr key={e.exitType} className="border-t border-[var(--color-border)]">
                                                                <td className="px-3 py-2 font-medium text-[var(--color-text-primary)] capitalize">{e.exitType.replace(/_/g, ' ')}</td>
                                                                <td className="px-3 py-2 text-right text-[var(--color-text-secondary)]">{e.total}</td>
                                                                <td className={`px-3 py-2 text-right font-semibold ${e.profitFactor >= 1.1 ? 'text-green-600' : 'text-red-500'}`}>{e.profitFactor.toFixed(2)}</td>
                                                                <td className={`px-3 py-2 text-right ${e.expectancy >= 0 ? 'text-green-600' : 'text-red-500'}`}>{e.expectancy >= 0 ? '+' : ''}{e.expectancy.toFixed(1)}%</td>
                                                                <td className="px-3 py-2 text-right text-[var(--color-text-secondary)]">{e.winRate.toFixed(0)}%</td>
                                                                <td className="px-3 py-2 text-right text-[var(--color-text-secondary)]">{e.avgHoldDays !== null ? `${e.avgHoldDays}d` : '—'}</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}

                                    {/* Confidence Bucket Calibration */}
                                    {calibrationData.confidenceBuckets && calibrationData.confidenceBuckets.length > 0 && (
                                        <div>
                                            <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">
                                                Confidence Calibration
                                                <span className="ml-1 font-normal normal-case">— does higher predicted confidence → better results?</span>
                                            </p>
                                            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                                                <table className="w-full text-sm">
                                                    <thead>
                                                        <tr className="bg-gray-50 dark:bg-gray-800/60 text-xs text-[var(--color-text-secondary)] uppercase tracking-wide">
                                                            <th className="px-3 py-2 text-left">Confidence</th>
                                                            <th className="px-3 py-2 text-right">n</th>
                                                            <th className="px-3 py-2 text-right">PF</th>
                                                            <th className="px-3 py-2 text-right">E%</th>
                                                            <th className="px-3 py-2 text-right">Avg Ret</th>
                                                            <th className="px-3 py-2 text-right">WR%</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {calibrationData.confidenceBuckets.map(b => (
                                                            <tr key={b.bucket} className="border-t border-[var(--color-border)]">
                                                                <td className="px-3 py-2 font-medium text-[var(--color-text-primary)]">
                                                                    {!b.valid ? '⚪' : b.profitFactor >= 1.1 ? '✅' : '❌'} {b.bucket}
                                                                </td>
                                                                <td className="px-3 py-2 text-right text-[var(--color-text-secondary)]">{b.total}</td>
                                                                <td className={`px-3 py-2 text-right font-semibold ${b.profitFactor >= 1.1 ? 'text-green-600' : 'text-red-500'}`}>
                                                                    {b.profitFactor.toFixed(2)}
                                                                </td>
                                                                <td className={`px-3 py-2 text-right ${b.expectancy >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                                                                    {b.expectancy >= 0 ? '+' : ''}{b.expectancy.toFixed(1)}%
                                                                </td>
                                                                <td className={`px-3 py-2 text-right ${b.avgReturn >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                                                                    {b.avgReturn >= 0 ? '+' : ''}{b.avgReturn.toFixed(1)}%
                                                                </td>
                                                                <td className="px-3 py-2 text-right text-[var(--color-text-secondary)]">{b.winRate.toFixed(0)}%</td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}

                                    {/* Sector Insights */}
                                    {calibrationData.sectorInsights && calibrationData.sectorInsights.length > 0 && (
                                        <div>
                                            <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">
                                                Sector Insights
                                                <span className="ml-1 font-normal normal-case">— suggested floor by sector (≥15 trades)</span>
                                            </p>
                                            <div className="overflow-x-auto rounded-xl border border-[var(--color-border)]">
                                                <table className="w-full text-sm">
                                                    <thead>
                                                        <tr className="bg-gray-50 dark:bg-gray-800/60 text-xs text-[var(--color-text-secondary)] uppercase tracking-wide">
                                                            <th className="px-3 py-2 text-left">Sector</th>
                                                            <th className="px-3 py-2 text-right">n</th>
                                                            <th className="px-3 py-2 text-right">PF</th>
                                                            <th className="px-3 py-2 text-right">WR%</th>
                                                            <th className="px-3 py-2 text-right">Suggested Floor</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody>
                                                        {calibrationData.sectorInsights.map(s => (
                                                            <tr key={s.sector} className="border-t border-[var(--color-border)]">
                                                                <td className="px-3 py-2 font-medium text-[var(--color-text-primary)]">{s.sector}</td>
                                                                <td className="px-3 py-2 text-right text-[var(--color-text-secondary)]">{s.total}</td>
                                                                <td className={`px-3 py-2 text-right font-semibold ${s.profitFactor >= 1.1 ? 'text-green-600' : 'text-red-500'}`}>
                                                                    {s.profitFactor.toFixed(2)}
                                                                </td>
                                                                <td className="px-3 py-2 text-right text-[var(--color-text-secondary)]">{s.winRate.toFixed(0)}%</td>
                                                                <td className="px-3 py-2 text-right">
                                                                    {s.suggestedFloor !== null ? (
                                                                        <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                                                                            s.suggestedFloor > (currentMinBuyScore ?? 85)
                                                                                ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                                                                                : s.suggestedFloor < (currentMinBuyScore ?? 85)
                                                                                    ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                                                                                    : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400'
                                                                        }`}>
                                                                            {s.suggestedFloor}
                                                                        </span>
                                                                    ) : '—'}
                                                                </td>
                                                            </tr>
                                                        ))}
                                                    </tbody>
                                                </table>
                                            </div>
                                        </div>
                                    )}

                                    {/* Action section */}
                                    <div className={`rounded-xl p-4 border ${
                                        !calibrationData.hasEnoughData
                                            ? 'bg-gray-50 dark:bg-gray-800/40 border-gray-200 dark:border-gray-700'
                                            : calibrationData.suggestedFloor === currentMinBuyScore
                                                ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                                                : calibrationData.suggestedFloor !== null
                                                    ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'
                                                    : 'bg-gray-50 dark:bg-gray-800/40 border-gray-200 dark:border-gray-700'
                                    }`}>
                                        {!calibrationData.hasEnoughData ? (
                                            <>
                                                <p className="font-bold text-[var(--color-text-primary)]">⏳ Collecting Data</p>
                                                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                                                    Need ≥25 trades per bucket for a reliable recommendation.
                                                    Current total: <strong>{calibrationData.totalTrades}</strong> closed trades.
                                                </p>
                                            </>
                                        ) : calibrationData.suggestedFloor === currentMinBuyScore ? (
                                            <>
                                                <p className="font-bold text-green-700 dark:text-green-400">✅ No Action Required</p>
                                                <p className="text-sm text-[var(--color-text-secondary)] mt-1">
                                                    Current minBuyScore ({currentMinBuyScore}) is validated by performance data.
                                                </p>
                                            </>
                                        ) : calibrationData.suggestedFloor !== null ? (
                                            <>
                                                <p className="font-bold text-amber-700 dark:text-amber-400">
                                                    {(calibrationData.suggestedFloor ?? 0) > (currentMinBuyScore ?? 0) ? '⚡ Action Recommended' : '📉 Optional Adjustment'}
                                                </p>
                                                <p className="text-sm text-[var(--color-text-secondary)] mt-1">{calibrationData.reason}</p>
                                                <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                                                    Confidence: <strong>{calibrationData.confidence}</strong> ({calibrationData.totalTrades} trades)
                                                </p>
                                            </>
                                        ) : null}
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="px-6 py-4 border-t border-[var(--color-border)] flex items-center justify-between gap-3">
                            <button
                                onClick={() => setShowCalibrationModal(false)}
                                className="px-4 py-2 rounded-xl border border-[var(--color-border)] text-[var(--color-text-primary)] font-semibold hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-sm"
                            >
                                Close
                            </button>

                            {calibrationData && !calibrationLoading && calibrationData.hasEnoughData &&
                             calibrationData.suggestedFloor !== null &&
                             calibrationData.suggestedFloor !== currentMinBuyScore && (
                                <button
                                    onClick={applyCalibration}
                                    disabled={calibrationApplying || calibrationApplied}
                                    className="px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold transition-colors text-sm flex items-center gap-2"
                                >
                                    {calibrationApplying ? (
                                        <><span className="animate-spin w-4 h-4 border-2 border-white border-t-transparent rounded-full inline-block" /> Applying…</>
                                    ) : calibrationApplied ? (
                                        '✅ Applied'
                                    ) : (
                                        `Apply: Set minBuyScore → ${calibrationData.suggestedFloor}`
                                    )}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
