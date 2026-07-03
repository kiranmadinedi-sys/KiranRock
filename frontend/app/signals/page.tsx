'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { getAuthToken, handleAuthError } from '../utils/auth';
import { getApiBaseUrl } from '../config';

interface Ticker {
    symbol: string;
    aiScore: number;
    recommendation: 'STRONG BUY' | 'BUY';
    sector: string;
    setupFamily: string;
    passedPrescreen: boolean;
    scanDate: string;
    scoringLog: string[];
    entry: number | null;
    stop: number | null;
    target: number | null;
    riskReward: string | null;
    oracleVerdict: string | null;
    smartMoneyScore: number | null;
    atrPct: number | null;
    daysToEarnings: number | null;
    distFromSma20Pct: number | null;
}

interface CalibrationBucket {
    bucket: string;
    total: number;
    wins: number;
    winRate: number;
    avgReturn: number;
    totalPnl: number;
}

interface SetupWinrateRow {
    setupFamily: string;
    total: number;
    wins: number;
    winRate: number;
    avgReturn: number;
    totalPnl: number;
}

interface RescanAlert {
    symbol:       string;
    rescanAt:     string;
    rescanReason: string;
    prevRec:      string | null;
}

interface Summary {
    total: number;
    strongBuy: number;
    buy: number;
    topScore: number | null;
    avgScore: number | null;
}

interface GlobalMarketBreakdown {
    asia:        number | null;
    europe:      number | null;
    futures:     number | null;
    dollar:      number | null;
    commodities: number | null;
    vix:         number | null;
}

interface GlobalMarketRawData {
    nikkeiPct:  number | null;
    hsiPct:     number | null;
    sensexPct:  number | null;
    daxPct:     number | null;
    ftsePct:    number | null;
    esFutPct:   number | null;
    nqFutPct:   number | null;
    dxyPct:     number | null;
    oilPct:     number | null;
    goldPct:    number | null;
    vixLevel:   number | null;
    vvixLevel:  number | null;
}

interface GlobalMarketData {
    label:     string;
    score:     number;
    breakdown: GlobalMarketBreakdown;
    rawData:   GlobalMarketRawData;
}

interface SignalsData {
    scanDate:     string | null;
    generatedAt:  string | null;
    rescanAlerts: RescanAlert[];
    regime:       string | null;
    globalMarket: GlobalMarketData | null;
    summary:      Summary;
    tickers:      Ticker[];
}

interface DateEntry {
    date: string;
    strongBuy: number;
    buy: number;
}

const SETUP_LABELS: Record<string, { label: string; emoji: string; order: number }> = {
    breakout_leader:     { label: 'Breakout Leaders',     emoji: '🚀', order: 1 },
    quality_continuation:{ label: 'Quality Continuation', emoji: '💎', order: 2 },
    oversold_reversal:   { label: 'Oversold Reversal',    emoji: '🔄', order: 3 },
};

function scoreColor(score: number) {
    if (score >= 90) return 'text-emerald-600 dark:text-emerald-400';
    if (score >= 80) return 'text-green-600 dark:text-green-400';
    if (score >= 70) return 'text-yellow-600 dark:text-yellow-400';
    return 'text-gray-600 dark:text-gray-400';
}

function scoreBg(score: number) {
    if (score >= 90) return 'bg-emerald-100 dark:bg-emerald-900/30 border-emerald-200 dark:border-emerald-700';
    if (score >= 80) return 'bg-green-100 dark:bg-green-900/30 border-green-200 dark:border-green-700';
    if (score >= 70) return 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-700';
    return 'bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700';
}

function heatmapTileColor(score: number): string {
    if (score >= 97) return 'bg-emerald-700 hover:bg-emerald-800';
    if (score >= 93) return 'bg-emerald-600 hover:bg-emerald-700';
    if (score >= 90) return 'bg-emerald-500 hover:bg-emerald-600';
    if (score >= 87) return 'bg-green-500 hover:bg-green-600';
    return 'bg-green-400 hover:bg-green-500';
}

function regimeColor(regime: string | null) {
    if (!regime) return 'text-gray-500';
    if (regime.includes('BULL')) return 'text-green-600';
    if (regime.includes('BEAR')) return 'text-red-600';
    return 'text-yellow-600';
}

function atlasLabelStyle(label: string) {
    if (label === 'STRONG_BULLISH') return { text: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-100 dark:bg-emerald-900/30', bar: 'bg-emerald-500' };
    if (label === 'BULLISH')        return { text: 'text-green-700 dark:text-green-400',   bg: 'bg-green-100 dark:bg-green-900/30',   bar: 'bg-green-500' };
    if (label === 'BEARISH')        return { text: 'text-orange-700 dark:text-orange-400', bg: 'bg-orange-100 dark:bg-orange-900/30', bar: 'bg-orange-500' };
    if (label === 'RISK_OFF')       return { text: 'text-red-700 dark:text-red-400',       bg: 'bg-red-100 dark:bg-red-900/30',       bar: 'bg-red-500' };
    return                                 { text: 'text-gray-600 dark:text-gray-400',     bg: 'bg-gray-100 dark:bg-gray-800',        bar: 'bg-gray-400' };
}

function pctColor(pct: number | null, invert = false) {
    if (pct === null) return 'text-gray-400';
    const positive = invert ? pct < 0 : pct > 0;
    const negative = invert ? pct > 0 : pct < 0;
    if (positive) return 'text-green-600 dark:text-green-400';
    if (negative) return 'text-red-600 dark:text-red-400';
    return 'text-gray-500';
}

function fmtPct(pct: number | null): string {
    if (pct === null) return '—';
    return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
}

/** Mini score bar 0–1 shown as a thin horizontal bar */
function ScoreBar({ value, barClass }: { value: number | null; barClass: string }) {
    const pct = value !== null ? Math.round(value * 100) : 50;
    return (
        <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div className={`h-full rounded-full transition-all ${barClass}`} style={{ width: `${pct}%` }} />
        </div>
    );
}

function GlobalMarketPanel({ gm }: { gm: GlobalMarketData }) {
    const style = atlasLabelStyle(gm.label);
    const r     = gm.rawData;

    const indices = [
        { name: 'Nikkei',  val: r.nikkeiPct,  inv: false },
        { name: 'HSI',     val: r.hsiPct,     inv: false },
        { name: 'DAX',     val: r.daxPct,     inv: false },
        { name: 'FTSE',    val: r.ftsePct,    inv: false },
        { name: 'ES Fut',  val: r.esFutPct,   inv: false },
        { name: 'DXY',     val: r.dxyPct,     inv: true  },  // dollar up = bad for stocks
        { name: 'Oil',     val: r.oilPct,     inv: false },
        { name: 'Gold',    val: r.goldPct,    inv: false },
    ];

    const components: { name: string; key: keyof GlobalMarketBreakdown }[] = [
        { name: 'Asia-Pac', key: 'asia' },
        { name: 'Europe',   key: 'europe' },
        { name: 'Futures',  key: 'futures' },
        { name: 'Dollar',   key: 'dollar' },
        { name: 'Commod',   key: 'commodities' },
        { name: 'VIX',      key: 'vix' },
    ];

    return (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 px-5 py-4">
            {/* Header row */}
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <span className="text-base font-bold text-gray-800 dark:text-gray-200">🌍 Global Market</span>
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${style.bg} ${style.text}`}>
                        {gm.label.replace('_', ' ')}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">ATLAS score</span>
                    <span className={`text-sm font-bold ${style.text}`}>{(gm.score * 100).toFixed(0)}/100</span>
                </div>
            </div>

            {/* Index data grid */}
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-2 mb-3">
                {indices.map(idx => (
                    <div key={idx.name} className="flex flex-col items-center bg-gray-50 dark:bg-gray-800 rounded-lg py-1.5 px-1">
                        <span className="text-[10px] text-gray-500 dark:text-gray-400 font-semibold">{idx.name}</span>
                        <span className={`text-xs font-bold mt-0.5 ${pctColor(idx.val, idx.inv)}`}>
                            {idx.name === 'DXY' && r.vixLevel !== null
                                ? fmtPct(idx.val)  // show % for DXY
                                : fmtPct(idx.val)}
                        </span>
                    </div>
                ))}
            </div>

            {/* VIX + VVIX highlight */}
            <div className="flex items-center gap-4 mb-3">
                {r.vixLevel !== null && (
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-500">VIX</span>
                        <span className={`text-sm font-bold ${r.vixLevel < 15 ? 'text-green-600' : r.vixLevel < 20 ? 'text-yellow-600' : r.vixLevel < 30 ? 'text-orange-600' : 'text-red-600'}`}>
                            {r.vixLevel.toFixed(1)}
                        </span>
                        <span className="text-[10px] text-gray-400">
                            {r.vixLevel < 15 ? '(calm)' : r.vixLevel < 20 ? '(normal)' : r.vixLevel < 30 ? '(elevated)' : '(fear)'}
                        </span>
                    </div>
                )}
                {r.vvixLevel !== null && (
                    <div className="flex items-center gap-1.5">
                        <span className="text-xs text-gray-500">VVIX</span>
                        <span className={`text-sm font-bold ${r.vvixLevel > 100 ? 'text-orange-600' : 'text-gray-600 dark:text-gray-400'}`}>
                            {r.vvixLevel.toFixed(1)}
                        </span>
                    </div>
                )}
            </div>

            {/* Component breakdown bars */}
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                {components.map(c => (
                    <div key={c.key} className="flex flex-col gap-1">
                        <div className="flex items-center justify-between">
                            <span className="text-[10px] text-gray-500">{c.name}</span>
                            <span className="text-[10px] text-gray-400">
                                {gm.breakdown[c.key] !== null ? Math.round((gm.breakdown[c.key] as number) * 100) : '—'}
                            </span>
                        </div>
                        <ScoreBar value={gm.breakdown[c.key]} barClass={style.bar} />
                    </div>
                ))}
            </div>
        </div>
    );
}

function CalibrationPanel({ base, hdrs }: { base: string; hdrs: Record<string, string> }) {
    const [rows, setRows] = useState<CalibrationBucket[]>([]);
    const [open, setOpen] = useState(false);
    const [loaded, setLoaded] = useState(false);

    const load = async () => {
        if (loaded) return;
        try {
            const r = await fetch(`${base}/api/daily-signals/calibration`, { headers: hdrs });
            if (r.ok) { setRows(await r.json()); setLoaded(true); }
        } catch { /* no-op */ }
    };

    const toggle = () => { if (!open) load(); setOpen(o => !o); };

    return (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <button
                onClick={toggle}
                className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Score Bucket Calibration</span>
                    <span className="text-xs text-gray-400">— does 95-100 outperform 85-89?</span>
                </div>
                <span className="text-gray-400 text-xs">{open ? '▲ hide' : '▼ show'}</span>
            </button>
            {open && (
                <div className="px-5 pb-4 overflow-x-auto">
                    {rows.length === 0 ? (
                        <p className="text-sm text-gray-400 py-2">No closed trades with scores yet.</p>
                    ) : (
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-xs text-gray-500 uppercase border-b border-gray-200 dark:border-gray-700">
                                    <th className="text-left pb-2 pr-4">Bucket</th>
                                    <th className="text-right pb-2 pr-4">Trades</th>
                                    <th className="text-right pb-2 pr-4">Win Rate</th>
                                    <th className="text-right pb-2 pr-4">Avg Return</th>
                                    <th className="text-right pb-2">Total P&L</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(r => (
                                    <tr key={r.bucket} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                                        <td className="py-2 pr-4 font-mono font-semibold text-gray-800 dark:text-gray-200">{r.bucket}</td>
                                        <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-400">{r.total}</td>
                                        <td className={`py-2 pr-4 text-right font-semibold ${r.winRate >= 60 ? 'text-emerald-600 dark:text-emerald-400' : r.winRate >= 45 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-500'}`}>
                                            {r.winRate}%
                                        </td>
                                        <td className={`py-2 pr-4 text-right font-semibold ${r.avgReturn >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                            {r.avgReturn >= 0 ? '+' : ''}{r.avgReturn.toFixed(2)}%
                                        </td>
                                        <td className={`py-2 text-right font-semibold ${r.totalPnl >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                            {r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(0)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
}

function SetupWinratePanel({ base, hdrs }: { base: string; hdrs: Record<string, string> }) {
    const [rows, setRows] = useState<SetupWinrateRow[]>([]);
    const [open, setOpen] = useState(false);
    const [loaded, setLoaded] = useState(false);

    const load = async () => {
        if (loaded) return;
        try {
            const r = await fetch(`${base}/api/daily-signals/setup-winrate`, { headers: hdrs });
            if (r.ok) { setRows(await r.json()); setLoaded(true); }
        } catch { /* no-op */ }
    };

    const toggle = () => { if (!open) load(); setOpen(o => !o); };

    const FAMILY_LABEL: Record<string, string> = {
        breakout_leader: 'Breakout Leader',
        momentum_surge:  'Momentum Surge',
        value_recovery:  'Value Recovery',
        trend_rider:     'Trend Rider',
        reversal_play:   'Reversal Play',
        unknown:         'Unknown',
    };

    return (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            <button
                onClick={toggle}
                className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
                <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Setup Family Win Rate</span>
                    <span className="text-xs text-gray-400">— which patterns win most?</span>
                </div>
                <span className="text-gray-400 text-xs">{open ? '▲ hide' : '▼ show'}</span>
            </button>
            {open && (
                <div className="px-5 pb-4 overflow-x-auto">
                    {rows.length === 0 ? (
                        <p className="text-sm text-gray-400 py-2">No closed trades with setup data yet.</p>
                    ) : (
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-xs text-gray-500 uppercase border-b border-gray-200 dark:border-gray-700">
                                    <th className="text-left pb-2 pr-4">Setup Family</th>
                                    <th className="text-right pb-2 pr-4">Trades</th>
                                    <th className="text-right pb-2 pr-4">Win Rate</th>
                                    <th className="text-right pb-2 pr-4">Avg Return</th>
                                    <th className="text-right pb-2">Total P&L</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(r => (
                                    <tr key={r.setupFamily} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                                        <td className="py-2 pr-4 font-semibold text-gray-800 dark:text-gray-200">
                                            {FAMILY_LABEL[r.setupFamily] ?? r.setupFamily}
                                        </td>
                                        <td className="py-2 pr-4 text-right text-gray-600 dark:text-gray-400">{r.total}</td>
                                        <td className={`py-2 pr-4 text-right font-semibold ${r.winRate >= 60 ? 'text-emerald-600 dark:text-emerald-400' : r.winRate >= 45 ? 'text-yellow-600 dark:text-yellow-400' : 'text-red-500'}`}>
                                            {r.winRate}%
                                        </td>
                                        <td className={`py-2 pr-4 text-right font-semibold ${r.avgReturn >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                            {r.avgReturn >= 0 ? '+' : ''}{r.avgReturn.toFixed(2)}%
                                        </td>
                                        <td className={`py-2 text-right font-semibold ${r.totalPnl >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                                            {r.totalPnl >= 0 ? '+' : ''}${r.totalPnl.toFixed(0)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    )}
                </div>
            )}
        </div>
    );
}

function SectorHeatmap({ tickers, expandedSymbol, setExpandedSymbol }: {
    tickers: Ticker[];
    expandedSymbol: string | null;
    setExpandedSymbol: (s: string | null) => void;
}) {
    const heatTickers = tickers.filter(t => t.aiScore >= 85);

    const sectors: Record<string, Ticker[]> = {};
    for (const t of heatTickers) {
        const s = t.sector || 'Other';
        (sectors[s] = sectors[s] || []).push(t);
    }
    const sortedSectors = Object.entries(sectors).sort((a, b) => b[1].length - a[1].length);

    if (heatTickers.length === 0) {
        return <div className="text-center py-12 text-gray-400">No tickers with score ≥ 85 in this scan.</div>;
    }

    return (
        <div className="space-y-5">
            <div className="text-xs text-gray-500 dark:text-gray-400">
                {heatTickers.length} tickers with score ≥ 85 · click any tile to see scoring details
            </div>
            {sortedSectors.map(([sector, sectorTickers]) => (
                <div key={sector}>
                    <div className="flex items-center gap-2 mb-2">
                        <h2 className="text-xs font-bold text-gray-600 dark:text-gray-400 uppercase tracking-widest">{sector}</h2>
                        <span className="text-[10px] bg-gray-200 dark:bg-gray-700 text-gray-500 dark:text-gray-400 rounded-full px-2 py-0.5">{sectorTickers.length}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        {[...sectorTickers].sort((a, b) => b.aiScore - a.aiScore).map(t => {
                            const isExpanded = expandedSymbol === t.symbol;
                            const hasLog = t.scoringLog && t.scoringLog.length > 0;
                            return (
                                <div key={t.symbol} className="relative">
                                    <button
                                        onClick={() => setExpandedSymbol(isExpanded ? null : t.symbol)}
                                        className={`${heatmapTileColor(t.aiScore)} text-white rounded-lg px-3 py-2 min-w-[68px] text-center transition-colors ${isExpanded ? 'ring-2 ring-white ring-offset-1 ring-offset-transparent' : ''}`}
                                    >
                                        <div className="text-sm font-bold leading-tight">{t.symbol}</div>
                                        <div className="text-xs opacity-90">{t.aiScore.toFixed(0)}</div>
                                        {t.recommendation === 'STRONG BUY' && (
                                            <div className="text-[9px] font-bold opacity-80 mt-0.5">⭐ SB</div>
                                        )}
                                    </button>
                                    {isExpanded && (
                                        <>
                                            {/* Mobile backdrop — tap anywhere outside to close */}
                                            <div
                                                className="fixed inset-0 z-10 sm:hidden"
                                                onClick={() => setExpandedSymbol(null)}
                                            />
                                            {/* Popup: fixed bottom-sheet on mobile, absolute tooltip on sm+ */}
                                            <div className="fixed inset-x-3 bottom-4 z-20 sm:absolute sm:inset-x-auto sm:bottom-auto sm:left-0 sm:top-full sm:mt-1.5 sm:w-72 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-xl shadow-2xl p-4">
                                                <div className="flex items-center justify-between mb-1">
                                                    <span className="font-bold text-gray-900 dark:text-white text-sm">{t.symbol}</span>
                                                    <div className="flex items-center gap-2">
                                                        <span className={`text-sm font-bold ${scoreColor(t.aiScore)}`}>{t.aiScore.toFixed(0)}</span>
                                                        <button onClick={() => setExpandedSymbol(null)} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-sm px-1">✕</button>
                                                    </div>
                                                </div>
                                                <div className="text-[10px] text-gray-500 dark:text-gray-400 mb-2">{t.sector}</div>
                                                {t.entry != null && (
                                                    <div className="flex gap-3 text-[11px] text-gray-500 mb-2 flex-wrap">
                                                        <span>Entry <span className="font-semibold text-gray-700 dark:text-gray-300">${t.entry.toFixed(2)}</span></span>
                                                        {t.stop != null && <span>Stop <span className="font-semibold text-red-500">${t.stop.toFixed(2)}</span></span>}
                                                        {t.target != null && <span>Tgt <span className="font-semibold text-green-600">${t.target.toFixed(2)}</span></span>}
                                                        {t.riskReward && <span>R/R <span className="font-semibold text-indigo-600 dark:text-indigo-400">{t.riskReward}</span></span>}
                                                    </div>
                                                )}
                                                {hasLog ? (
                                                    <ul className="space-y-1 max-h-52 overflow-y-auto">
                                                        {t.scoringLog.map((line, i) => (
                                                            <li key={i} className="text-[11px] text-gray-600 dark:text-gray-400 leading-snug">{line}</li>
                                                        ))}
                                                    </ul>
                                                ) : (
                                                    <p className="text-[11px] text-gray-400">No scoring details available.</p>
                                                )}
                                                {t.oracleVerdict && (
                                                    <div className="mt-2 text-[11px] font-semibold text-indigo-700 dark:text-indigo-300 italic">{t.oracleVerdict}</div>
                                                )}
                                            </div>
                                        </>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}

function formatDate(dateStr: string | null) {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/** "Generated 3 hours ago" / "Generated just now" / "Generated 2 days ago" */
function freshnessLabel(generatedAt: string | null): string {
    if (!generatedAt) return '';
    const diffMs  = Date.now() - new Date(generatedAt).getTime();
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 2)   return 'Generated just now';
    if (diffMin < 60)  return `Generated ${diffMin} min ago`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24)  return `Generated ${diffHrs} hr${diffHrs > 1 ? 's' : ''} ago`;
    const diffDay = Math.floor(diffHrs / 24);
    return `Generated ${diffDay} day${diffDay > 1 ? 's' : ''} ago`;
}

/** True when it's a weekday between 9:30 AM and 4:00 PM ET (browser-side approximation) */
function isMarketHours(): boolean {
    const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const day  = et.getDay();
    const mins = et.getHours() * 60 + et.getMinutes();
    return day >= 1 && day <= 5 && mins >= 9 * 60 + 30 && mins < 16 * 60;
}

export default function SignalsPage() {
    const router = useRouter();
    const [data, setData]               = useState<SignalsData | null>(null);
    const [dates, setDates]             = useState<DateEntry[]>([]);
    const [selectedDate, setSelectedDate] = useState<string>('');
    const [filter, setFilter]           = useState<'ALL' | 'STRONG BUY' | 'BUY'>('ALL');
    const [loading, setLoading]         = useState(true);
    const [copied, setCopied]           = useState(false);
    const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null);
    const [viewMode, setViewMode] = useState<'cards' | 'heatmap'>('cards');
    const refreshTimerRef               = useRef<ReturnType<typeof setInterval> | null>(null);

    // Monday Filter state
    const [timingOpen, setTimingOpen]       = useState(false);
    const [timingActive, setTimingActive]   = useState(false);
    const [maxAtrPct, setMaxAtrPct]         = useState(5.0);
    const [minEarningsDays, setMinEarningsDays] = useState(7);
    const [maxExtension, setMaxExtension]   = useState(15.0);
    const [showTop10, setShowTop10]         = useState(false);

    const token = typeof window !== 'undefined' ? getAuthToken() : null;
    const base  = getApiBaseUrl();
    const hdrs  = { Authorization: `Bearer ${token}` };

    // Load available dates
    useEffect(() => {
        if (!token) { router.push('/login'); return; }
        fetch(`${base}/api/daily-signals/dates`, { headers: hdrs })
            .then(r => { if (r.status === 401) { handleAuthError(401); } return r.ok ? r.json() : []; })
            .then(setDates)
            .catch(() => {});
    }, [token]);

    // Load signals for selected date (or latest)
    const load = useCallback(async (date?: string) => {
        if (!token) return;
        setLoading(true);
        try {
            const url = date
                ? `${base}/api/daily-signals?date=${date}`
                : `${base}/api/daily-signals`;
            const r = await fetch(url, { headers: hdrs });
            if (r.status === 401) { handleAuthError(401); return; }
            if (r.ok) { setData(await r.json()); }
        } catch { /* no-op */ } finally {
            setLoading(false);
        }
    }, [token]);

    useEffect(() => { load(selectedDate || undefined); }, [load, selectedDate]);

    // Auto-refresh every 5 minutes during market hours (adaptive cruise control)
    useEffect(() => {
        if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = setInterval(() => {
            if (isMarketHours() && !selectedDate) {
                load(undefined);
            }
        }, 5 * 60 * 1000);
        return () => { if (refreshTimerRef.current) clearInterval(refreshTimerRef.current); };
    }, [load, selectedDate]);

    // Second-pass timing filter (ATR%, earnings window, breakout extension)
    const applyTimingFilters = (tickers: Ticker[]) => {
        if (!timingActive) return tickers;
        return tickers.filter(t => {
            if (t.atrPct != null && t.atrPct > maxAtrPct) return false;
            if (t.daysToEarnings != null && t.daysToEarnings < minEarningsDays) return false;
            if (t.distFromSma20Pct != null && t.distFromSma20Pct > maxExtension) return false;
            return true;
        });
    };

    // Copy tickers to clipboard
    const copyTickers = () => {
        if (!data) return;
        const visible = applyTimingFilters(filtered(data.tickers));
        const text = visible.map(t => t.symbol).join(', ');
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    const filtered = (tickers: Ticker[]) =>
        filter === 'ALL' ? tickers : tickers.filter(t => t.recommendation === filter);

    // Group by setup family
    const grouped = (tickers: Ticker[]) => {
        const groups: Record<string, Ticker[]> = {};
        for (const t of tickers) {
            const key = t.setupFamily || 'other';
            (groups[key] = groups[key] || []).push(t);
        }
        return Object.entries(groups).sort(([a], [b]) => {
            const oa = SETUP_LABELS[a]?.order ?? 99;
            const ob = SETUP_LABELS[b]?.order ?? 99;
            return oa - ob;
        });
    };

    const visibleTickers = data ? applyTimingFilters(filtered(data.tickers)) : [];

    // Build a lookup: symbol → rescan alert
    const rescanMap = new Map<string, RescanAlert>(
        (data?.rescanAlerts ?? []).map(a => [a.symbol, a])
    );

    // Sector concentration: count each sector across visible tickers
    const sectorCounts = visibleTickers.reduce<Record<string, number>>((acc, t) => {
        const s = t.sector || 'Unknown';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
    }, {});
    const topSector = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1])[0];
    const topSectorPct = visibleTickers.length > 0 && topSector ? Math.round((topSector[1] / visibleTickers.length) * 100) : 0;

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
            <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">

                {/* Header */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
                            ⭐ Daily Signals
                        </h1>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                            PANTHEON overnight scan — pre-market stock picks
                        </p>
                    </div>
                    <div className="flex items-center gap-3 flex-wrap">
                        {/* Date picker */}
                        <select
                            value={selectedDate}
                            onChange={e => setSelectedDate(e.target.value)}
                            className="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white dark:bg-gray-800 dark:border-gray-600 dark:text-white"
                        >
                            <option value="">Latest</option>
                            {dates.map(d => (
                                <option key={d.date} value={d.date}>
                                    {new Date(d.date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — {d.strongBuy} strong
                                </option>
                            ))}
                        </select>
                        {/* Copy button */}
                        <button
                            onClick={copyTickers}
                            disabled={!visibleTickers.length}
                            className="text-sm px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 text-white transition-colors"
                        >
                            {copied ? '✓ Copied!' : '📋 Copy Tickers'}
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center h-48">
                        <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
                    </div>
                ) : !data || !data.scanDate ? (
                    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-12 text-center">
                        <div className="text-4xl mb-3">🔭</div>
                        <p className="text-gray-500 dark:text-gray-400">No scan data available yet. The nightly scan runs after market close (~5 PM ET).</p>
                    </div>
                ) : (
                    <>
                        {/* Scan date + regime + freshness */}
                        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                            <div>
                                <div className="text-xs text-gray-500 uppercase tracking-wide font-semibold">Scan Date</div>
                                <div className="text-base font-semibold text-gray-900 dark:text-white mt-0.5">
                                    {formatDate(data.scanDate)}
                                </div>
                                {/* Freshness label */}
                                {data.generatedAt && (
                                    <div className="flex items-center gap-2 mt-1.5">
                                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                                            isMarketHours()
                                                ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                                                : 'bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400'
                                        }`}>
                                            {isMarketHours() ? '⚡ Live' : '🕐'} {freshnessLabel(data.generatedAt)}
                                        </span>
                                        {isMarketHours() && !selectedDate && (
                                            <span className="text-xs text-gray-400 dark:text-gray-500">
                                                · auto-refreshes every 5 min
                                            </span>
                                        )}
                                    </div>
                                )}
                            </div>
                            {data.regime && (
                                <div className="text-right">
                                    <div className="text-xs text-gray-500 uppercase tracking-wide font-semibold">Market Regime</div>
                                    <div className={`text-lg font-bold mt-0.5 ${regimeColor(data.regime)}`}>
                                        {data.regime.replace('_', ' ')}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* ATLAS Global Market Intelligence panel */}
                        {data.globalMarket && (
                            <GlobalMarketPanel gm={data.globalMarket} />
                        )}

                        {/* News rescan alert banner (shown only when rescans happened today) */}
                        {data.rescanAlerts.length > 0 && (
                            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-xl px-5 py-3 flex items-start gap-3">
                                <span className="text-xl mt-0.5">📡</span>
                                <div>
                                    <div className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                                        Adaptive rescan triggered for {data.rescanAlerts.length} stock{data.rescanAlerts.length > 1 ? 's' : ''} — scores updated due to breaking news
                                    </div>
                                    <div className="flex flex-wrap gap-2 mt-1.5">
                                        {data.rescanAlerts.map(a => (
                                            <span key={a.symbol} className="text-xs bg-amber-100 dark:bg-amber-800/40 text-amber-700 dark:text-amber-300 rounded px-2 py-0.5 font-mono font-semibold">
                                                {a.symbol}
                                                {a.prevRec && a.prevRec !== data.tickers.find(t => t.symbol === a.symbol)?.recommendation
                                                    ? ` ${a.prevRec} →`
                                                    : ''}
                                            </span>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Summary cards */}
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                            {[
                                { label: 'STRONG BUY', value: data.summary.strongBuy, color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20' },
                                { label: 'BUY', value: data.summary.buy, color: 'text-green-600 dark:text-green-400', bg: 'bg-green-50 dark:bg-green-900/20' },
                                { label: 'Top Score', value: data.summary.topScore ? data.summary.topScore.toFixed(0) : '—', color: 'text-indigo-600 dark:text-indigo-400', bg: 'bg-indigo-50 dark:bg-indigo-900/20' },
                                { label: 'Avg Score', value: data.summary.avgScore ? data.summary.avgScore.toFixed(1) : '—', color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-900/20' },
                            ].map(c => (
                                <div key={c.label} className={`${c.bg} rounded-xl border border-gray-200 dark:border-gray-700 p-4`}>
                                    <div className="text-xs text-gray-500 uppercase tracking-wide font-semibold">{c.label}</div>
                                    <div className={`text-3xl font-bold mt-1 ${c.color}`}>{c.value}</div>
                                </div>
                            ))}
                        </div>

                        {/* Filter tabs + view toggle */}
                        <div className="flex items-center gap-2 flex-wrap">
                            {(['ALL', 'STRONG BUY', 'BUY'] as const).map(f => (
                                <button
                                    key={f}
                                    onClick={() => setFilter(f)}
                                    className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-colors ${
                                        filter === f
                                            ? 'bg-indigo-600 text-white'
                                            : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700'
                                    }`}
                                >
                                    {f === 'ALL' ? `All (${data.summary.total})` : f === 'STRONG BUY' ? `⭐ Strong Buy (${data.summary.strongBuy})` : `📈 Buy (${data.summary.buy})`}
                                </button>
                            ))}
                            <div className="ml-auto flex items-center gap-3">
                                <div className="flex bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
                                    <button
                                        onClick={() => setViewMode('cards')}
                                        className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${viewMode === 'cards' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}
                                    >
                                        ☰ Cards
                                    </button>
                                    <button
                                        onClick={() => setViewMode('heatmap')}
                                        className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${viewMode === 'heatmap' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'}`}
                                    >
                                        🟩 Heatmap
                                    </button>
                                </div>
                                <span className="text-xs text-gray-400">{viewMode === 'heatmap' ? `${(data?.tickers ?? []).filter(t => t.aiScore >= 85).length} ≥85` : `${visibleTickers.length} showing`}</span>
                            </div>
                        </div>

                        {/* Monday Filter Panel */}
                        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
                            <button
                                onClick={() => setTimingOpen(o => !o)}
                                className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                            >
                                <div className="flex items-center gap-2">
                                    <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Monday Filter</span>
                                    {timingActive && (
                                        <span className="text-[10px] bg-indigo-600 text-white rounded-full px-2 py-0.5 font-bold">Active</span>
                                    )}
                                    <span className="text-xs text-gray-400">— ATR%, earnings window, breakout freshness</span>
                                </div>
                                <span className="text-gray-400 text-xs">{timingOpen ? '▲ hide' : '▼ show'}</span>
                            </button>
                            {timingOpen && (
                                <div className="px-5 pb-5 border-t border-gray-100 dark:border-gray-800">
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mt-4">
                                        {/* ATR% */}
                                        <div>
                                            <div className="flex items-center justify-between mb-1">
                                                <label className="text-xs font-semibold text-gray-600 dark:text-gray-400">Max ATR%</label>
                                                <span className="text-xs font-mono text-indigo-600 dark:text-indigo-400">{maxAtrPct.toFixed(1)}%</span>
                                            </div>
                                            <input type="range" min={0.5} max={8} step={0.5} value={maxAtrPct}
                                                onChange={e => setMaxAtrPct(Number(e.target.value))}
                                                className="w-full accent-indigo-600" />
                                            <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                                                <span>0.5% calm</span><span>8% volatile</span>
                                            </div>
                                            <p className="text-[10px] text-gray-400 mt-1.5">Exclude noisy stocks — lower = smoother entries</p>
                                        </div>
                                        {/* Earnings window */}
                                        <div>
                                            <div className="flex items-center justify-between mb-1">
                                                <label className="text-xs font-semibold text-gray-600 dark:text-gray-400">Min Days to Earnings</label>
                                                <span className="text-xs font-mono text-indigo-600 dark:text-indigo-400">{minEarningsDays}d</span>
                                            </div>
                                            <input type="range" min={0} max={21} step={1} value={minEarningsDays}
                                                onChange={e => setMinEarningsDays(Number(e.target.value))}
                                                className="w-full accent-indigo-600" />
                                            <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                                                <span>0d ignore</span><span>21d very safe</span>
                                            </div>
                                            <p className="text-[10px] text-gray-400 mt-1.5">Exclude stocks too close to earnings</p>
                                        </div>
                                        {/* Breakout extension */}
                                        <div>
                                            <div className="flex items-center justify-between mb-1">
                                                <label className="text-xs font-semibold text-gray-600 dark:text-gray-400">Max Extension (SMA20)</label>
                                                <span className="text-xs font-mono text-indigo-600 dark:text-indigo-400">{maxExtension.toFixed(0)}%</span>
                                            </div>
                                            <input type="range" min={0} max={30} step={1} value={maxExtension}
                                                onChange={e => setMaxExtension(Number(e.target.value))}
                                                className="w-full accent-indigo-600" />
                                            <div className="flex justify-between text-[10px] text-gray-400 mt-0.5">
                                                <span>0% tight</span><span>30% extended</span>
                                            </div>
                                            <p className="text-[10px] text-gray-400 mt-1.5">% above 20-day SMA — high means old breakout</p>
                                        </div>
                                    </div>
                                    <div className="mt-4 flex items-center justify-between flex-wrap gap-3">
                                        <label className="flex items-center gap-2 cursor-pointer select-none">
                                            <input type="checkbox" checked={showTop10}
                                                onChange={e => setShowTop10(e.target.checked)}
                                                className="accent-indigo-600 w-4 h-4" />
                                            <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Show Top 10 Shortlist</span>
                                        </label>
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => { setTimingActive(false); setMaxAtrPct(5.0); setMinEarningsDays(7); setMaxExtension(15); setShowTop10(false); }}
                                                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                                            >
                                                Reset
                                            </button>
                                            <button
                                                onClick={() => setTimingActive(true)}
                                                className="text-xs px-4 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold transition-colors"
                                            >
                                                Apply Filter
                                            </button>
                                        </div>
                                    </div>
                                    {timingActive && (
                                        <div className="mt-3 text-xs text-indigo-700 dark:text-indigo-300 bg-indigo-50 dark:bg-indigo-900/20 rounded-lg px-3 py-2 flex items-center justify-between gap-2">
                                            <span>
                                                Filter active: ATR ≤ {maxAtrPct.toFixed(1)}% · Earnings ≥ {minEarningsDays}d · Extension ≤ {maxExtension.toFixed(0)}% from SMA20
                                                {' '}· <span className="font-bold">{visibleTickers.length} stocks pass</span>
                                            </span>
                                            <button onClick={() => setTimingActive(false)} className="underline shrink-0 hover:text-indigo-900 dark:hover:text-indigo-100">Turn off</button>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Sector concentration warning */}
                        {topSectorPct >= 50 && topSector && (
                            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-xl px-5 py-3 flex items-center gap-3">
                                <span className="text-base">⚠️</span>
                                <div className="flex-1">
                                    <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                                        Sector concentration: {topSector[0]} ({topSectorPct}% of list)
                                    </span>
                                    <span className="text-xs text-amber-600 dark:text-amber-400 ml-2">
                                        — consider reducing correlated exposure
                                    </span>
                                    <div className="mt-1.5 w-full h-1.5 bg-amber-200 dark:bg-amber-800 rounded-full overflow-hidden">
                                        <div className="h-full bg-amber-500 rounded-full" style={{ width: `${topSectorPct}%` }} />
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Earnings this week banner */}
                        {(() => {
                            const earningsThisWeek = (data.tickers ?? [])
                                .filter(t => t.daysToEarnings != null && t.daysToEarnings >= 0 && t.daysToEarnings <= 5)
                                .sort((a, b) => (a.daysToEarnings ?? 99) - (b.daysToEarnings ?? 99));
                            if (!earningsThisWeek.length) return null;
                            const tomorrow  = earningsThisWeek.filter(t => t.daysToEarnings === 0 || t.daysToEarnings === 1);
                            const thisWeek  = earningsThisWeek.filter(t => (t.daysToEarnings ?? 99) >= 2);
                            return (
                                <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-xl px-5 py-3">
                                    <div className="flex items-center gap-2 mb-2">
                                        <span className="text-base">📅</span>
                                        <span className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                                            Earnings this week — {earningsThisWeek.length} stock{earningsThisWeek.length > 1 ? 's' : ''} reporting
                                        </span>
                                        <span className="text-xs text-amber-600 dark:text-amber-400">· verify before entering, IV often elevated</span>
                                    </div>
                                    {tomorrow.length > 0 && (
                                        <div className="mb-1.5">
                                            <span className="text-[10px] font-bold text-red-600 dark:text-red-400 uppercase tracking-wide mr-2">Tomorrow / Today</span>
                                            <span className="flex flex-wrap gap-1.5 mt-1">
                                                {tomorrow.map(t => (
                                                    <span key={t.symbol} className="inline-flex items-center gap-1 text-xs font-mono font-bold bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300 rounded px-2 py-0.5">
                                                        {t.symbol}
                                                        <span className="font-normal text-[10px]">{t.daysToEarnings === 0 ? 'today' : '1d'}</span>
                                                    </span>
                                                ))}
                                            </span>
                                        </div>
                                    )}
                                    {thisWeek.length > 0 && (
                                        <div>
                                            <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 uppercase tracking-wide mr-2">This week</span>
                                            <span className="flex flex-wrap gap-1.5 mt-1">
                                                {thisWeek.map(t => (
                                                    <span key={t.symbol} className="inline-flex items-center gap-1 text-xs font-mono font-bold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 rounded px-2 py-0.5">
                                                        {t.symbol}
                                                        <span className="font-normal text-[10px]">{t.daysToEarnings}d</span>
                                                    </span>
                                                ))}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            );
                        })()}

                        {/* Ticker view: sector heatmap or grouped cards */}
                        {viewMode === 'heatmap' ? (
                            <SectorHeatmap
                                tickers={data.tickers}
                                expandedSymbol={expandedSymbol}
                                setExpandedSymbol={setExpandedSymbol}
                            />
                        ) : (
                            <>
                                {/* Top 10 Shortlist */}
                                {showTop10 && visibleTickers.length > 0 && (
                                    <div className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-indigo-900/20 dark:to-purple-900/20 rounded-xl border border-indigo-200 dark:border-indigo-700 p-5">
                                        <div className="flex items-center gap-2 mb-4">
                                            <span className="text-base font-bold text-indigo-900 dark:text-indigo-200">Monday Shortlist</span>
                                            <span className="text-xs bg-indigo-600 text-white rounded-full px-2 py-0.5 font-semibold">
                                                Top {Math.min(10, visibleTickers.length)}
                                            </span>
                                            {timingActive && (
                                                <span className="text-xs text-indigo-500 dark:text-indigo-400">
                                                    — timing-filtered from {data?.tickers.length ?? 0} total
                                                </span>
                                            )}
                                        </div>
                                        <div className="space-y-2">
                                            {visibleTickers.slice(0, 10).map((t, i) => (
                                                <div key={t.symbol} className="flex items-center gap-3 bg-white dark:bg-gray-900 rounded-lg px-4 py-2.5 border border-indigo-100 dark:border-indigo-800">
                                                    <span className="text-xs font-bold text-indigo-300 dark:text-indigo-600 w-5 shrink-0">{i + 1}</span>
                                                    <span className="text-sm font-bold text-gray-900 dark:text-white w-14 shrink-0">{t.symbol}</span>
                                                    <span className={`text-sm font-bold w-8 shrink-0 ${scoreColor(t.aiScore)}`}>{t.aiScore.toFixed(0)}</span>
                                                    <span className="text-xs text-gray-400 truncate flex-1 hidden sm:block">{t.sector}</span>
                                                    {t.atrPct != null && (
                                                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 ${t.atrPct <= 2.5 ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : t.atrPct <= 4 ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400' : 'bg-red-50 dark:bg-red-900/20 text-red-600'}`}>
                                                            ATR {t.atrPct.toFixed(1)}%
                                                        </span>
                                                    )}
                                                    {t.daysToEarnings != null && (
                                                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 ${t.daysToEarnings >= 14 ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : t.daysToEarnings >= 7 ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400' : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'}`}>
                                                            {t.daysToEarnings}d earn
                                                        </span>
                                                    )}
                                                    {t.distFromSma20Pct != null && (
                                                        <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded shrink-0 hidden sm:inline ${t.distFromSma20Pct <= 5 ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400' : t.distFromSma20Pct <= 12 ? 'bg-yellow-50 dark:bg-yellow-900/20 text-yellow-700 dark:text-yellow-400' : 'bg-red-50 dark:bg-red-900/20 text-red-600'}`}>
                                                            +{t.distFromSma20Pct.toFixed(1)}% SMA20
                                                        </span>
                                                    )}
                                                    {t.smartMoneyScore != null && t.smartMoneyScore > 0.65 && (
                                                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">
                                                            Insider Buy
                                                        </span>
                                                    )}
                                                    {t.smartMoneyScore != null && t.smartMoneyScore < 0.35 && (
                                                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">
                                                            Insider Sell
                                                        </span>
                                                    )}
                                                    <span className="text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded capitalize shrink-0 hidden md:inline">
                                                        {(t.setupFamily || 'other').replace(/_/g, ' ')}
                                                    </span>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}

                                {grouped(visibleTickers).map(([setupKey, tickers]) => {
                                    const setup = SETUP_LABELS[setupKey] || { label: setupKey.replace(/_/g, ' '), emoji: '📌', order: 99 };
                                    return (
                                        <div key={setupKey}>
                                            <div className="flex items-center gap-2 mb-3">
                                                <span className="text-xl">{setup.emoji}</span>
                                                <h2 className="text-base font-bold text-gray-800 dark:text-gray-200">{setup.label}</h2>
                                                <span className="text-xs bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400 rounded-full px-2 py-0.5">{tickers.length}</span>
                                            </div>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                                                {tickers.map(t => {
                                                    const rescan = rescanMap.get(t.symbol);
                                                    const isExpanded = expandedSymbol === t.symbol;
                                                    const hasLog = t.scoringLog && t.scoringLog.length > 0;
                                                    return (
                                                        <div
                                                            key={t.symbol}
                                                            className={`rounded-xl border flex flex-col relative ${scoreBg(t.aiScore)} ${rescan ? 'ring-2 ring-amber-400 dark:ring-amber-500' : ''}`}
                                                        >
                                                            {/* Main card body */}
                                                            <div className="p-4 flex flex-col gap-1">
                                                                {/* News rescan badge */}
                                                                {rescan && (
                                                                    <div className="absolute top-2 right-2 bg-amber-400 dark:bg-amber-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded leading-none">
                                                                        📡 LIVE
                                                                    </div>
                                                                )}

                                                                {/* Symbol + rec badge */}
                                                                <div className="flex items-start justify-between gap-1">
                                                                    <span className="text-lg font-bold text-gray-900 dark:text-white tracking-wide">
                                                                        {t.symbol}
                                                                    </span>
                                                                    {t.recommendation === 'STRONG BUY' && !rescan && (
                                                                        <span className="text-[10px] font-bold bg-emerald-500 text-white rounded px-1.5 py-0.5 shrink-0">SB</span>
                                                                    )}
                                                                </div>
                                                                {/* Score */}
                                                                <div className={`text-2xl font-bold ${scoreColor(t.aiScore)}`}>
                                                                    {t.aiScore.toFixed(0)}
                                                                </div>
                                                                {/* Sector */}
                                                                <div className="text-[11px] text-gray-500 dark:text-gray-400 leading-tight truncate" title={t.sector}>
                                                                    {t.sector}
                                                                </div>
                                                                {/* Timing + insider mini badges */}
                                                                {(t.atrPct != null || t.daysToEarnings != null ||
                                                                  (t.smartMoneyScore != null && (t.smartMoneyScore > 0.65 || t.smartMoneyScore < 0.35))) && (
                                                                    <div className="flex items-center gap-1 flex-wrap mt-0.5">
                                                                        {t.atrPct != null && (
                                                                            <span className={`text-[9px] font-mono px-1 py-0.5 rounded leading-none ${t.atrPct <= 2.5 ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' : t.atrPct <= 4 ? 'bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400' : 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400'}`}>
                                                                                {t.atrPct.toFixed(1)}%
                                                                            </span>
                                                                        )}
                                                                        {t.daysToEarnings != null && (
                                                                            <span className={`text-[9px] font-mono px-1 py-0.5 rounded leading-none ${t.daysToEarnings >= 14 ? 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-400' : t.daysToEarnings >= 7 ? 'bg-yellow-50 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400' : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'}`}>
                                                                                {t.daysToEarnings}d
                                                                            </span>
                                                                        )}
                                                                        {t.smartMoneyScore != null && t.smartMoneyScore > 0.65 && (
                                                                            <span className="text-[9px] font-semibold px-1 py-0.5 rounded leading-none bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-400">
                                                                                Insider Buy
                                                                            </span>
                                                                        )}
                                                                        {t.smartMoneyScore != null && t.smartMoneyScore < 0.35 && (
                                                                            <span className="text-[9px] font-semibold px-1 py-0.5 rounded leading-none bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400">
                                                                                Insider Sell
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                )}
                                                                {/* Rescan reason snippet */}
                                                                {rescan && (
                                                                    <div className="text-[10px] text-amber-600 dark:text-amber-400 leading-tight mt-0.5 line-clamp-2">
                                                                        {rescan.rescanReason}
                                                                    </div>
                                                                )}
                                                                {/* Why button */}
                                                                {hasLog && (
                                                                    <button
                                                                        onClick={() => setExpandedSymbol(isExpanded ? null : t.symbol)}
                                                                        className="mt-2 text-[10px] font-semibold text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-200 text-left"
                                                                    >
                                                                        {isExpanded ? '▲ hide' : '? why'}
                                                                    </button>
                                                                )}
                                                            </div>

                                                            {/* Scoring log drawer */}
                                                            {isExpanded && hasLog && (
                                                                <div className="border-t border-gray-200 dark:border-gray-700 px-3 py-2 bg-white/60 dark:bg-gray-900/60 rounded-b-xl">
                                                                    {t.entry != null && (
                                                                        <div className="flex gap-3 text-[10px] text-gray-500 mb-1.5 flex-wrap">
                                                                            <span>Entry <span className="font-semibold text-gray-700 dark:text-gray-300">${t.entry.toFixed(2)}</span></span>
                                                                            {t.stop != null && <span>Stop <span className="font-semibold text-red-500">${t.stop.toFixed(2)}</span></span>}
                                                                            {t.target != null && <span>Tgt <span className="font-semibold text-green-600">${t.target.toFixed(2)}</span></span>}
                                                                            {t.riskReward && <span>R/R <span className="font-semibold text-indigo-600 dark:text-indigo-400">{t.riskReward}</span></span>}
                                                                        </div>
                                                                    )}
                                                                    <ul className="space-y-0.5">
                                                                        {t.scoringLog.map((line, i) => (
                                                                            <li key={i} className="text-[10px] text-gray-600 dark:text-gray-400 leading-snug">
                                                                                {line}
                                                                            </li>
                                                                        ))}
                                                                    </ul>
                                                                    {t.oracleVerdict && (
                                                                        <div className="mt-1.5 text-[10px] font-semibold text-indigo-700 dark:text-indigo-300 italic">
                                                                            {t.oracleVerdict}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })}

                                {visibleTickers.length === 0 && (
                                    <div className="text-center py-12 text-gray-400">No tickers match this filter.</div>
                                )}
                            </>
                        )}

                        {/* Score bucket calibration */}
                        <CalibrationPanel base={base} hdrs={hdrs} />

                        {/* Setup family win rate */}
                        <SetupWinratePanel base={base} hdrs={hdrs} />

                        {/* Share text */}
                        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Share List</span>
                                <button
                                    onClick={copyTickers}
                                    className="text-xs px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg"
                                >
                                    {copied ? '✓ Copied' : 'Copy'}
                                </button>
                            </div>
                            <div className="text-sm text-gray-600 dark:text-gray-400 font-mono bg-gray-50 dark:bg-gray-800 rounded-lg p-3 leading-relaxed break-all">
                                {visibleTickers.length > 0
                                    ? visibleTickers.map(t => t.symbol).join(', ')
                                    : 'No tickers to display'}
                            </div>
                        </div>
                    </>
                )}
            </main>
        </div>
    );
}
