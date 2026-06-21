'use client';

import React, { useState, useEffect, useRef } from 'react';
import { getApiBaseUrl } from '../config';
import { getAuthToken, handleAuthError } from '../utils/auth';

interface Message {
    id: string;
    type: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

interface TickerBrief {
    symbol: string;
    aiScore: number;
    recommendation: string;
    sector: string;
    setupFamily: string;
    entry: number | null;
    stop: number | null;
    target: number | null;
    riskReward: string | null;
}

interface SectorRow {
    sector: string;
    count: number;
    symbols: string[];
    swingPct: number;
    suitability: 'swing' | 'intra' | 'both';
}

interface SectorPerf {
    sector: string;
    total: number;
    winRate: number;
    avgReturn: number;
}

interface Briefing {
    scanDate: string | null;
    regime: string | null;
    atlas: { label: string; score: number; vix: number | null } | null;
    tickers: TickerBrief[];
    sectorBreakdown: SectorRow[];
    sectorPerformance: SectorPerf[];
    summary: { total: number; strongBuy: number; buy: number; topScore: number | null; avgScore: number | null };
}

function regimeColor(r: string | null) {
    if (!r) return 'text-gray-500';
    if (r.includes('BULL')) return 'text-emerald-600 dark:text-emerald-400';
    if (r.includes('BEAR')) return 'text-red-600 dark:text-red-400';
    return 'text-yellow-600 dark:text-yellow-400';
}

function atlasColor(label: string) {
    if (label === 'STRONG_BULLISH') return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300';
    if (label === 'BULLISH')        return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300';
    if (label === 'BEARISH')        return 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300';
    if (label === 'RISK_OFF')       return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300';
    return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400';
}

function scoreBadge(score: number) {
    if (score >= 90) return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300';
    if (score >= 80) return 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300';
    return 'bg-gray-100 dark:bg-gray-800 text-gray-600';
}

function suitabilityBadge(s: string) {
    if (s === 'swing') return 'bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300';
    if (s === 'intra') return 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300';
    return 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400';
}

function InvestmentCalculator({ tickers }: { tickers: TickerBrief[] }) {
    const [amount, setAmount] = useState(500);
    const picks = tickers.filter(t => t.recommendation === 'STRONG BUY' && t.entry != null).slice(0, 5);
    if (picks.length === 0) return null;
    const perStock = amount / picks.length;

    return (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
            <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-bold text-gray-800 dark:text-gray-200">Investment Calculator</span>
                <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">Amount: $</span>
                    <input
                        type="number"
                        value={amount}
                        onChange={e => setAmount(Math.max(100, parseInt(e.target.value) || 500))}
                        className="w-20 text-xs border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
                        step={100}
                        min={100}
                    />
                </div>
            </div>
            <div className="text-xs text-gray-500 mb-2">Equal-weight across top {picks.length} STRONG BUY picks:</div>
            <div className="space-y-2">
                {picks.map(t => {
                    const shares = (perStock / t.entry!).toFixed(2);
                    const upside = t.target ? (((t.target - t.entry!) / t.entry!) * 100).toFixed(1) : null;
                    const gain   = t.target ? (perStock * (t.target - t.entry!) / t.entry!).toFixed(0) : null;
                    return (
                        <div key={t.symbol} className="flex items-center gap-2 bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2">
                            <span className="font-mono font-bold text-gray-900 dark:text-white w-14">{t.symbol}</span>
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${scoreBadge(t.aiScore)}`}>{t.aiScore}</span>
                            <div className="flex-1 text-xs text-gray-600 dark:text-gray-400">
                                {shares} shares @ ${t.entry!.toFixed(2)} = <span className="font-semibold text-gray-800 dark:text-gray-200">${perStock.toFixed(0)}</span>
                                {upside && <span className="ml-2 text-emerald-600 dark:text-emerald-400">→ +${gain} if hits ${t.target!.toFixed(2)} (+{upside}%)</span>}
                                {t.stop && <span className="ml-2 text-red-500 text-[10px]">stop ${t.stop.toFixed(2)}</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="mt-2 text-[10px] text-gray-400">
                Max upside: ${picks.reduce((s, t) => s + (t.target && t.entry ? perStock * (t.target - t.entry) / t.entry : 0), 0).toFixed(0)} | Risk disclaimer: past performance doesn't guarantee future results.
            </div>
        </div>
    );
}

function BriefingPanel({ briefing }: { briefing: Briefing }) {
    const [activeTab, setActiveTab] = useState<'picks' | 'sectors' | 'invest'>('picks');
    const swing = briefing.tickers.filter(t => t.setupFamily === 'breakout_leader' || t.setupFamily === 'quality_continuation');
    const intra = briefing.tickers.filter(t => t.setupFamily === 'oversold_reversal');

    return (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            {/* Header row */}
            <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
                    <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-base font-bold text-gray-900 dark:text-white">Daily Market Briefing</span>
                        {briefing.scanDate && (
                            <span className="text-xs text-gray-400">{new Date(briefing.scanDate).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        {briefing.regime && (
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 ${regimeColor(briefing.regime)}`}>
                                {briefing.regime.replace('_', ' ')}
                            </span>
                        )}
                        {briefing.atlas && (
                            <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${atlasColor(briefing.atlas.label)}`}>
                                ATLAS: {briefing.atlas.label.replace('_', ' ')} {briefing.atlas.vix ? `| VIX ${briefing.atlas.vix.toFixed(1)}` : ''}
                            </span>
                        )}
                        <div className="flex gap-2 text-xs">
                            <span className="bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 rounded-full font-semibold">{briefing.summary.strongBuy} STRONG BUY</span>
                            <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-2 py-0.5 rounded-full font-semibold">{briefing.summary.buy} BUY</span>
                        </div>
                    </div>
                </div>
                {/* Tabs */}
                <div className="flex gap-1 mt-3">
                    {([['picks','Top Picks'],['sectors','Sector Split'],['invest','Calculator']] as const).map(([tab, label]) => (
                        <button key={tab} onClick={() => setActiveTab(tab)}
                            className={`px-3 py-1 rounded-full text-xs font-semibold transition-colors ${activeTab === tab ? 'bg-indigo-600 text-white' : 'bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'}`}>
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Tab content */}
            <div className="p-4">
                {activeTab === 'picks' && (
                    <>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                            {briefing.tickers.slice(0, 10).map(t => (
                                <div key={t.symbol} className={`flex items-center gap-2 rounded-lg px-3 py-2 border ${t.recommendation === 'STRONG BUY' ? 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200 dark:border-emerald-800' : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700'}`}>
                                    <span className="font-mono font-bold text-gray-900 dark:text-white w-14 shrink-0">{t.symbol}</span>
                                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${scoreBadge(t.aiScore)}`}>{t.aiScore}</span>
                                    <div className="flex-1 min-w-0">
                                        <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">{t.sector}</div>
                                        {t.entry && (
                                            <div className="text-[10px] text-gray-600 dark:text-gray-400">
                                                ${t.entry.toFixed(2)}
                                                {t.target && <span className="text-emerald-600 dark:text-emerald-400 ml-1">→ ${t.target.toFixed(2)}</span>}
                                                {t.riskReward && <span className="text-indigo-600 dark:text-indigo-400 ml-1">R:{t.riskReward}</span>}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {activeTab === 'sectors' && (
                    <div className="space-y-3">
                        {/* Swing vs Intra */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-lg p-3 border border-indigo-100 dark:border-indigo-800">
                                <div className="text-xs font-bold text-indigo-700 dark:text-indigo-300 mb-1">Swing Trades (2-10 days)</div>
                                <div className="text-[10px] text-indigo-600 dark:text-indigo-400 mb-2">Breakout leaders, momentum sectors</div>
                                <div className="flex flex-wrap gap-1">
                                    {swing.slice(0, 8).map(t => (
                                        <span key={t.symbol} className="text-[10px] font-mono bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300 px-1.5 py-0.5 rounded">{t.symbol}</span>
                                    ))}
                                    {swing.length === 0 && <span className="text-[10px] text-gray-400">none today</span>}
                                </div>
                            </div>
                            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 border border-purple-100 dark:border-purple-800">
                                <div className="text-xs font-bold text-purple-700 dark:text-purple-300 mb-1">Intra / Scalp (same day)</div>
                                <div className="text-[10px] text-purple-600 dark:text-purple-400 mb-2">Oversold reversals, stable sectors</div>
                                <div className="flex flex-wrap gap-1">
                                    {intra.slice(0, 8).map(t => (
                                        <span key={t.symbol} className="text-[10px] font-mono bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 px-1.5 py-0.5 rounded">{t.symbol}</span>
                                    ))}
                                    {intra.length === 0 && <span className="text-[10px] text-gray-400">none today</span>}
                                </div>
                            </div>
                        </div>

                        {/* Sector table */}
                        <div className="overflow-x-auto">
                            <table className="w-full text-xs">
                                <thead>
                                    <tr className="text-[10px] text-gray-500 uppercase border-b border-gray-200 dark:border-gray-700">
                                        <th className="text-left pb-1.5 pr-3">Sector</th>
                                        <th className="text-center pb-1.5 pr-3">Stocks</th>
                                        <th className="text-left pb-1.5 pr-3">Symbols</th>
                                        <th className="text-center pb-1.5 pr-3">Style</th>
                                        {briefing.sectorPerformance.length > 0 && <th className="text-right pb-1.5">90d Win%</th>}
                                    </tr>
                                </thead>
                                <tbody>
                                    {briefing.sectorBreakdown.map(s => {
                                        const perf = briefing.sectorPerformance.find(p => p.sector === s.sector);
                                        return (
                                            <tr key={s.sector} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                                                <td className="py-1.5 pr-3 font-medium text-gray-700 dark:text-gray-300">{s.sector}</td>
                                                <td className="py-1.5 pr-3 text-center text-gray-600 dark:text-gray-400">{s.count}</td>
                                                <td className="py-1.5 pr-3 text-gray-500 dark:text-gray-500">{s.symbols.slice(0, 5).join(', ')}{s.symbols.length > 5 ? '…' : ''}</td>
                                                <td className="py-1.5 pr-3 text-center">
                                                    <span className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${suitabilityBadge(s.suitability)}`}>
                                                        {s.suitability}
                                                    </span>
                                                </td>
                                                {briefing.sectorPerformance.length > 0 && (
                                                    <td className={`py-1.5 text-right font-semibold ${perf ? (perf.winRate >= 55 ? 'text-emerald-600 dark:text-emerald-400' : perf.winRate >= 40 ? 'text-yellow-600' : 'text-red-500') : 'text-gray-400'}`}>
                                                        {perf ? `${perf.winRate}%` : '—'}
                                                    </td>
                                                )}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                )}

                {activeTab === 'invest' && (
                    <InvestmentCalculator tickers={briefing.tickers} />
                )}
            </div>
        </div>
    );
}

const WELCOME = `Hello! I'm KiranRock AI — your personal trading assistant powered by Claude.

I have live access to:
• Your portfolio & P&L (Alpaca positions, stop status)
• Today's PANTHEON signals (entry / stop / target)
• System health (worker, bot cycles)
• Recent trade history
• Full analysis for any stock

Tap a suggestion below or ask anything in plain English.`;

export default function EnquiryPage() {
    const base  = getApiBaseUrl();
    const token = typeof window !== 'undefined' ? getAuthToken() : null;
    const hdrs  = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const [messages, setMessages] = useState<Message[]>([
        { id: '0', type: 'assistant', content: WELCOME, timestamp: new Date() }
    ]);
    const [input, setInput]       = useState('');
    const [loading, setLoading]   = useState(false);
    const [briefing, setBriefing] = useState<Briefing | null>(null);
    const [briefingError, setBriefingError] = useState(false);
    const [briefingOpen, setBriefingOpen]   = useState(true);
    const messagesEndRef = useRef<HTMLDivElement>(null);

    useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

    useEffect(() => {
        if (!token) return;
        fetch(`${base}/api/enquiry/briefing`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => { if (r.status === 401) handleAuthError(401); return r.ok ? r.json() : null; })
            .then(d => { if (d) setBriefing(d); else setBriefingError(true); })
            .catch(() => setBriefingError(true));
    }, [token]);

    const send = (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || loading) return;
        sendQuestion(input.trim());
    };

    const SUGGESTIONS = [
        {
            label: 'Portfolio',
            color: 'emerald',
            items: [
                "What's my portfolio right now?",
                "Which positions are losing today?",
                "Do I have stops on all positions?",
                "Show my last 10 trades",
            ]
        },
        {
            label: 'Signals',
            color: 'indigo',
            items: [
                "What are today's top PANTHEON picks?",
                "Show only STRONG BUY signals",
                "How should I invest $500 today?",
                "Best swing stocks today?",
            ]
        },
        {
            label: 'Analysis',
            color: 'violet',
            items: [
                "Analyse NVDA for me",
                "Analyse AAPL for me",
                "What is the current market regime?",
                "Sector split for swing vs intra?",
            ]
        },
        {
            label: 'System',
            color: 'rose',
            items: [
                "Is the bot running?",
                "How did today's bot cycles go?",
                "What was my last sell?",
            ]
        },
    ];

    const chipColors: Record<string, string> = {
        emerald: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/40',
        indigo:  'bg-indigo-50 dark:bg-indigo-900/20 border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-900/40',
        violet:  'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/40',
        rose:    'bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800 text-rose-700 dark:text-rose-300 hover:bg-rose-100 dark:hover:bg-rose-900/40',
    };

    const sendQuestion = async (question: string) => {
        if (loading) return;
        const userMsg: Message = { id: Date.now().toString(), type: 'user', content: question, timestamp: new Date() };
        setMessages(prev => [...prev, userMsg]);
        setInput('');
        setLoading(true);
        try {
            const r = await fetch(`${base}/api/enquiry`, {
                method: 'POST',
                headers: hdrs,
                body: JSON.stringify({ question })
            });
            if (r.status === 401) { handleAuthError(401); return; }
            const data = r.ok ? await r.json() : null;
            setMessages(prev => [...prev, {
                id: (Date.now() + 1).toString(),
                type: 'assistant',
                content: data?.answer || 'Sorry, could not process that.',
                timestamp: new Date()
            }]);
        } catch {
            setMessages(prev => [...prev, {
                id: (Date.now() + 1).toString(),
                type: 'assistant',
                content: 'Connection error. Please ensure the backend is running.',
                timestamp: new Date()
            }]);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-gray-50 dark:bg-gray-950 pt-16 sm:pt-20">
            <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">

                {/* Header */}
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Market Intelligence</h1>
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Live briefing from PANTHEON scan · Ask anything</p>
                    </div>
                    <button
                        onClick={() => setBriefingOpen(o => !o)}
                        className="text-xs px-3 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                    >
                        {briefingOpen ? 'Hide Briefing' : 'Show Briefing'}
                    </button>
                </div>

                {/* Briefing panel */}
                {briefingOpen && (
                    briefing
                        ? <BriefingPanel briefing={briefing} />
                        : briefingError
                            ? <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-xl p-4 text-sm text-amber-700 dark:text-amber-300">Briefing unavailable — no scan data yet or backend offline.</div>
                            : <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-6 flex items-center gap-3">
                                <div className="animate-spin w-5 h-5 border-4 border-indigo-600 border-t-transparent rounded-full" />
                                <span className="text-sm text-gray-500">Loading market briefing…</span>
                              </div>
                )}

                {/* Suggested prompts — grouped by category */}
                <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 p-4 space-y-3">
                    <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Quick questions — tap to ask</div>
                    {SUGGESTIONS.map(group => (
                        <div key={group.label} className="flex items-start gap-2 flex-wrap">
                            <span className="text-[10px] font-bold uppercase tracking-wide text-gray-400 dark:text-gray-500 w-14 shrink-0 pt-1.5">{group.label}</span>
                            <div className="flex flex-wrap gap-1.5 flex-1">
                                {group.items.map((q, i) => (
                                    <button
                                        key={i}
                                        disabled={loading}
                                        onClick={() => sendQuestion(q)}
                                        className={`text-xs px-3 py-1.5 border rounded-full transition-colors disabled:opacity-40 ${chipColors[group.color]}`}
                                    >
                                        {q}
                                    </button>
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                {/* Chat */}
                <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 flex flex-col" style={{ height: 'calc(100vh - 520px)', minHeight: '320px' }}>
                    <div className="flex-1 overflow-y-auto p-4 space-y-3">
                        {messages.map(m => (
                            <div key={m.id} className={`flex ${m.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                                <div className={`max-w-2xl rounded-xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed shadow-sm ${
                                    m.type === 'user'
                                        ? 'bg-indigo-600 text-white'
                                        : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-white'
                                }`}>
                                    {m.content}
                                    <div className={`text-[10px] mt-1.5 ${m.type === 'user' ? 'text-indigo-200' : 'text-gray-400'}`}>
                                        {m.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </div>
                                </div>
                            </div>
                        ))}
                        {loading && (
                            <div className="flex justify-start">
                                <div className="bg-gray-100 dark:bg-gray-800 rounded-xl px-4 py-3 flex items-center gap-2">
                                    <div className="animate-spin w-3.5 h-3.5 border-2 border-indigo-600 border-t-transparent rounded-full" />
                                    <span className="text-sm text-gray-500 dark:text-gray-400">Thinking…</span>
                                </div>
                            </div>
                        )}
                        <div ref={messagesEndRef} />
                    </div>

                    <div className="border-t border-gray-200 dark:border-gray-700 p-3">
                        <form onSubmit={send} className="flex gap-2">
                            <input
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                placeholder="Ask about stocks, investment ideas, market trend…"
                                disabled={loading}
                                className="flex-1 text-sm px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            />
                            <button
                                type="submit"
                                disabled={loading || !input.trim()}
                                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white text-sm rounded-lg transition-colors"
                            >
                                Send
                            </button>
                        </form>
                        <p className="text-[10px] text-gray-400 mt-1.5">Powered by Claude AI · Live portfolio, signals &amp; system data from KiranRock</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
