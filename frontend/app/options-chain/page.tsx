'use client';

import React, { useState, useRef, useCallback } from 'react';
import AppHeader from '../components/AppHeader';
import { getApiBaseUrl } from '../config';

interface Contract {
    strike:            number;
    bid:               number;
    ask:               number;
    lastPrice:         number;
    volume:            number;
    openInterest:      number;
    impliedVolatility: number;
    inTheMoney:        boolean;
    change:            number;
    percentChange:     number;
    type:              'call' | 'put';
}

interface ExpirationDate {
    timestamp: number | null;
    date:      string;
}

interface ChainData {
    symbol:             string;
    stockPrice:         number | null;
    expirationDates:    ExpirationDate[];
    selectedExpiration: number | string | null;
    calls:              Contract[];
    puts:               Contract[];
    source:             string;
    warning?:           string;
    error?:             string;
    suggestion?:        string;
}

const API_BASE = getApiBaseUrl();

function fmt(n: number | null | undefined, decimals = 2): string {
    if (n == null || isNaN(n)) return '—';
    return `$${n.toFixed(decimals)}`;
}

function fmtPct(n: number | null | undefined): string {
    if (n == null || isNaN(n) || n === 0) return '—';
    return `${(n * 100).toFixed(1)}%`;
}

function fmtVol(n: number): string {
    if (!n) return '—';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
    return String(n);
}

export default function OptionsChainPage() {
    const [ticker, setTicker]           = useState('');
    const [inputVal, setInputVal]       = useState('');
    const [chainData, setChainData]     = useState<ChainData | null>(null);
    const [loading, setLoading]         = useState(false);
    const [error, setError]             = useState('');
    const [selectedExp, setSelectedExp] = useState<string | number | null>(null);
    const [loadingExp, setLoadingExp]   = useState(false);
    const [view, setView]               = useState<'combined' | 'calls' | 'puts'>('combined');
    const expTabsRef                    = useRef<HTMLDivElement>(null);

    const fetchChain = useCallback(async (symbol: string, expiration?: number | null) => {
        if (!symbol) return;
        const isInitial = !expiration;
        if (isInitial) setLoading(true); else setLoadingExp(true);
        setError('');

        try {
            let url = `${API_BASE}/api/options/chain?symbol=${symbol}`;
            if (expiration) url += `&expiration=${expiration}`;
            const resp = await fetch(url);
            const data: ChainData = await resp.json();

            if (!resp.ok || data.error) {
                setError(data.error || 'Failed to load options chain');
                if (isInitial) setChainData(null);
                return;
            }

            if (isInitial) {
                setChainData(data);
                setSelectedExp(data.selectedExpiration);
            } else {
                setChainData(prev => prev ? {
                    ...prev,
                    calls: data.calls,
                    puts:  data.puts,
                    selectedExpiration: data.selectedExpiration
                } : data);
                setSelectedExp(data.selectedExpiration);
            }
        } catch (e: any) {
            setError(e.message || 'Network error');
        } finally {
            if (isInitial) setLoading(false); else setLoadingExp(false);
        }
    }, []);

    const handleSearch = (e: React.FormEvent) => {
        e.preventDefault();
        const sym = inputVal.trim().toUpperCase();
        if (!sym) return;
        setTicker(sym);
        setChainData(null);
        setSelectedExp(null);
        fetchChain(sym);
    };

    const handleExpSelect = (exp: ExpirationDate) => {
        if (!ticker) return;
        setSelectedExp(exp.timestamp ?? exp.date);
        if (exp.timestamp) {
            fetchChain(ticker, exp.timestamp);
        }
    };

    // Merge calls and puts by strike for the combined table
    const buildRows = () => {
        if (!chainData) return [];
        const callMap = new Map<number, Contract>();
        const putMap  = new Map<number, Contract>();
        (chainData.calls || []).forEach(c => callMap.set(c.strike, c));
        (chainData.puts  || []).forEach(p => putMap.set(p.strike, p));

        const allStrikes = Array.from(new Set([
            ...Array.from(callMap.keys()),
            ...Array.from(putMap.keys())
        ])).sort((a, b) => b - a); // descending

        return allStrikes.map(strike => ({
            strike,
            call: callMap.get(strike) || null,
            put:  putMap.get(strike)  || null,
        }));
    };

    const rows = buildRows();
    const stockPrice = chainData?.stockPrice || 0;

    const callBidColor  = (c: Contract | null) => {
        if (!c) return 'text-gray-600';
        return c.inTheMoney ? 'text-orange-400' : 'text-gray-400';
    };
    const callAskColor  = (c: Contract | null) => {
        if (!c) return 'text-gray-600';
        return c.inTheMoney ? 'text-orange-300' : 'text-emerald-400';
    };
    const putBidColor   = (p: Contract | null) => {
        if (!p) return 'text-gray-600';
        return p.inTheMoney ? 'text-orange-400' : 'text-gray-400';
    };
    const putAskColor   = (p: Contract | null) => {
        if (!p) return 'text-gray-600';
        return p.inTheMoney ? 'text-orange-300' : 'text-emerald-400';
    };

    // Find the row where the stock price falls between strikes
    let priceSeparatorInserted = false;

    return (
        <div className="min-h-screen bg-gray-950 text-white">
            <AppHeader showSearch={false} />

            <div className="max-w-7xl mx-auto px-4 py-6">
                {/* Title + search */}
                <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mb-6">
                    <div>
                        <h1 className="text-2xl font-bold text-white">Options Chain</h1>
                        <p className="text-sm text-gray-400">Real-time calls &amp; puts by expiration date</p>
                    </div>
                    <form onSubmit={handleSearch} className="flex gap-2 sm:ml-auto">
                        <input
                            type="text"
                            value={inputVal}
                            onChange={e => setInputVal(e.target.value.toUpperCase())}
                            placeholder="Ticker (e.g. AAPL)"
                            className="px-4 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white placeholder-gray-500 text-sm w-40 focus:outline-none focus:border-blue-500"
                        />
                        <button
                            type="submit"
                            disabled={loading}
                            className="px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded-lg text-sm font-semibold transition-colors"
                        >
                            {loading ? 'Loading…' : 'Load'}
                        </button>
                    </form>
                </div>

                {/* Error */}
                {error && (
                    <div className="mb-4 p-4 rounded-lg bg-red-900/40 border border-red-700/50 text-red-300 text-sm">
                        <div className="font-semibold">Unable to load options chain</div>
                        <div className="mt-1 text-red-400">{error}</div>
                        {chainData?.suggestion && (
                            <div className="mt-2 text-yellow-400 text-xs">{chainData.suggestion}</div>
                        )}
                    </div>
                )}

                {/* Empty state */}
                {!loading && !chainData && !error && (
                    <div className="text-center py-24 text-gray-500">
                        <div className="text-5xl mb-4">📊</div>
                        <div className="text-lg font-medium text-gray-400">Enter a ticker to view its options chain</div>
                        <div className="text-sm mt-2">e.g. AAPL, MSFT, NVDA, SPY</div>
                    </div>
                )}

                {/* Loading spinner */}
                {loading && (
                    <div className="flex justify-center items-center py-24">
                        <div className="animate-spin rounded-full h-10 w-10 border-2 border-blue-500 border-t-transparent"></div>
                        <span className="ml-3 text-gray-400">Fetching options chain…</span>
                    </div>
                )}

                {/* Main chain UI */}
                {chainData && !loading && (
                    <>
                        {/* Header bar — ticker + price + source */}
                        <div className="flex flex-wrap items-center justify-between mb-4 gap-3">
                            <div className="flex items-center gap-4">
                                <span className="text-3xl font-bold text-white">{chainData.symbol}</span>
                                {chainData.stockPrice && (
                                    <span className="text-xl font-semibold text-emerald-400">
                                        ${chainData.stockPrice.toFixed(2)}
                                    </span>
                                )}
                                {chainData.warning && (
                                    <span className="text-xs px-2 py-1 rounded bg-amber-900/40 border border-amber-700/50 text-amber-400">
                                        {chainData.source === 'cache' ? 'Cached data' : chainData.warning}
                                    </span>
                                )}
                            </div>
                            {/* Calls / Puts / Combined toggle */}
                            <div className="flex rounded-lg overflow-hidden border border-gray-700 text-sm">
                                {(['combined', 'calls', 'puts'] as const).map(v => (
                                    <button
                                        key={v}
                                        onClick={() => setView(v)}
                                        className={`px-4 py-1.5 font-medium transition-colors capitalize ${
                                            view === v
                                                ? 'bg-gray-700 text-white'
                                                : 'bg-gray-800 text-gray-400 hover:text-white'
                                        }`}
                                    >
                                        {v === 'combined' ? 'Side-by-Side' : v.charAt(0).toUpperCase() + v.slice(1)}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Expiration date tabs */}
                        <div
                            ref={expTabsRef}
                            className="flex gap-2 overflow-x-auto pb-2 mb-4 scrollbar-hide"
                            style={{ scrollbarWidth: 'none' }}
                        >
                            {chainData.expirationDates.map(exp => {
                                const isSelected = selectedExp === exp.timestamp || selectedExp === exp.date;
                                const dateLabel = exp.date
                                    ? new Date(exp.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                                    : exp.date;
                                return (
                                    <button
                                        key={exp.date}
                                        onClick={() => handleExpSelect(exp)}
                                        className={`flex-none px-4 py-1.5 rounded-full text-sm font-semibold transition-colors whitespace-nowrap ${
                                            isSelected
                                                ? 'bg-emerald-600 text-white'
                                                : 'bg-gray-800 text-gray-300 hover:bg-gray-700 hover:text-white'
                                        }`}
                                    >
                                        {dateLabel}
                                        {loadingExp && isSelected && (
                                            <span className="ml-1 animate-spin inline-block">⟳</span>
                                        )}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Combined side-by-side table */}
                        {view === 'combined' && (
                            <div className="rounded-xl bg-gray-900 border border-gray-800 overflow-hidden">
                                <div className="overflow-x-auto">
                                    <table className="w-full text-sm">
                                        <thead>
                                            <tr className="border-b border-gray-700/50">
                                                <td colSpan={5} className="py-2 px-3 text-center text-emerald-400 font-semibold text-xs uppercase tracking-widest bg-emerald-950/30">
                                                    CALLS
                                                </td>
                                                <td className="py-2 px-2 text-center text-gray-400 font-semibold text-xs uppercase tracking-widest">
                                                    STRIKE
                                                </td>
                                                <td colSpan={5} className="py-2 px-3 text-center text-orange-400 font-semibold text-xs uppercase tracking-widest bg-red-950/20">
                                                    PUTS
                                                </td>
                                            </tr>
                                            <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
                                                <th className="py-2 px-2 text-right">OI</th>
                                                <th className="py-2 px-2 text-right">Vol</th>
                                                <th className="py-2 px-2 text-right">IV</th>
                                                <th className="py-2 px-2 text-right font-semibold text-orange-500">Bid</th>
                                                <th className="py-2 px-2 text-right font-semibold text-emerald-500">Ask</th>
                                                <th className="py-2 px-3 text-center text-white">Strike</th>
                                                <th className="py-2 px-2 text-left font-semibold text-orange-500">Bid</th>
                                                <th className="py-2 px-2 text-left font-semibold text-emerald-500">Ask</th>
                                                <th className="py-2 px-2 text-left">IV</th>
                                                <th className="py-2 px-2 text-left">Vol</th>
                                                <th className="py-2 px-2 text-left">OI</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {rows.map((row, idx) => {
                                                // Insert price separator
                                                let separator = null;
                                                const prevStrike = rows[idx - 1]?.strike;
                                                if (
                                                    stockPrice > 0 &&
                                                    !priceSeparatorInserted &&
                                                    prevStrike !== undefined &&
                                                    prevStrike >= stockPrice &&
                                                    row.strike < stockPrice
                                                ) {
                                                    priceSeparatorInserted = true;
                                                    separator = (
                                                        <tr key={`sep-${stockPrice}`} className="border-y border-dashed border-gray-600">
                                                            <td colSpan={5} className="py-1 bg-gray-800/40"></td>
                                                            <td className="py-1 px-3 text-center">
                                                                <span className="inline-block px-3 py-0.5 rounded-full bg-gray-700 text-white font-bold text-xs">
                                                                    ${stockPrice.toFixed(2)}
                                                                </span>
                                                            </td>
                                                            <td colSpan={5} className="py-1 bg-gray-800/40"></td>
                                                        </tr>
                                                    );
                                                }

                                                const isNearMoney = stockPrice > 0 &&
                                                    Math.abs(row.strike - stockPrice) / stockPrice < 0.02;

                                                return (
                                                    <React.Fragment key={row.strike}>
                                                        {separator}
                                                        <tr className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${
                                                            isNearMoney ? 'bg-gray-800/20' : ''
                                                        }`}>
                                                            {/* Call side */}
                                                            <td className={`py-2 px-2 text-right text-xs ${row.call?.inTheMoney ? 'bg-emerald-950/10' : ''}`}>
                                                                <span className="text-gray-400">{fmtVol(row.call?.openInterest || 0)}</span>
                                                            </td>
                                                            <td className={`py-2 px-2 text-right text-xs ${row.call?.inTheMoney ? 'bg-emerald-950/10' : ''}`}>
                                                                <span className="text-gray-400">{fmtVol(row.call?.volume || 0)}</span>
                                                            </td>
                                                            <td className={`py-2 px-2 text-right text-xs ${row.call?.inTheMoney ? 'bg-emerald-950/10' : ''}`}>
                                                                <span className="text-gray-500">{fmtPct(row.call?.impliedVolatility)}</span>
                                                            </td>
                                                            <td className={`py-2 px-2 text-right font-medium ${callBidColor(row.call)} ${row.call?.inTheMoney ? 'bg-emerald-950/10' : ''}`}>
                                                                {row.call ? fmt(row.call.bid) : '—'}
                                                            </td>
                                                            <td className={`py-2 px-2 text-right font-medium ${callAskColor(row.call)} ${row.call?.inTheMoney ? 'bg-emerald-950/10' : ''}`}>
                                                                {row.call ? fmt(row.call.ask) : '—'}
                                                            </td>
                                                            {/* Strike */}
                                                            <td className="py-2 px-3 text-center font-bold text-white tabular-nums">
                                                                ${row.strike.toLocaleString()}
                                                            </td>
                                                            {/* Put side */}
                                                            <td className={`py-2 px-2 text-left font-medium ${putBidColor(row.put)} ${row.put?.inTheMoney ? 'bg-red-950/10' : ''}`}>
                                                                {row.put ? fmt(row.put.bid) : '—'}
                                                            </td>
                                                            <td className={`py-2 px-2 text-left font-medium ${putAskColor(row.put)} ${row.put?.inTheMoney ? 'bg-red-950/10' : ''}`}>
                                                                {row.put ? fmt(row.put.ask) : '—'}
                                                            </td>
                                                            <td className={`py-2 px-2 text-left text-xs ${row.put?.inTheMoney ? 'bg-red-950/10' : ''}`}>
                                                                <span className="text-gray-500">{fmtPct(row.put?.impliedVolatility)}</span>
                                                            </td>
                                                            <td className={`py-2 px-2 text-left text-xs ${row.put?.inTheMoney ? 'bg-red-950/10' : ''}`}>
                                                                <span className="text-gray-400">{fmtVol(row.put?.volume || 0)}</span>
                                                            </td>
                                                            <td className={`py-2 px-2 text-left text-xs ${row.put?.inTheMoney ? 'bg-red-950/10' : ''}`}>
                                                                <span className="text-gray-400">{fmtVol(row.put?.openInterest || 0)}</span>
                                                            </td>
                                                        </tr>
                                                    </React.Fragment>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                    {rows.length === 0 && (
                                        <div className="text-center py-12 text-gray-500">No contracts for this expiration</div>
                                    )}
                                </div>
                            </div>
                        )}

                        {/* Calls-only table */}
                        {view === 'calls' && (
                            <SingleSideTable contracts={chainData.calls} stockPrice={stockPrice} label="Calls" />
                        )}

                        {/* Puts-only table */}
                        {view === 'puts' && (
                            <SingleSideTable contracts={chainData.puts} stockPrice={stockPrice} label="Puts" />
                        )}

                        {/* Summary bar */}
                        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <StatCard label="Calls" value={String(chainData.calls.length)} />
                            <StatCard label="Puts" value={String(chainData.puts.length)} />
                            <StatCard
                                label="Put/Call OI Ratio"
                                value={(() => {
                                    const cOI = chainData.calls.reduce((s, c) => s + c.openInterest, 0);
                                    const pOI = chainData.puts.reduce((s, p) => s + p.openInterest, 0);
                                    return cOI > 0 ? (pOI / cOI).toFixed(2) : '—';
                                })()}
                            />
                            <StatCard
                                label="Avg IV (Calls)"
                                value={(() => {
                                    const ivs = chainData.calls.filter(c => c.impliedVolatility > 0);
                                    if (!ivs.length) return '—';
                                    return `${(ivs.reduce((s, c) => s + c.impliedVolatility, 0) / ivs.length * 100).toFixed(1)}%`;
                                })()}
                            />
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}

function SingleSideTable({ contracts, stockPrice, label }: { contracts: Contract[]; stockPrice: number; label: string }) {
    const sorted = [...contracts].sort((a, b) => b.strike - a.strike);
    const isCall = label === 'Calls';
    let inserted = false;

    return (
        <div className="rounded-xl bg-gray-900 border border-gray-800 overflow-hidden">
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="border-b border-gray-800 text-xs text-gray-500 uppercase tracking-wide">
                            <th className="py-2 px-3 text-left">Strike</th>
                            <th className="py-2 px-3 text-right text-orange-400">Bid</th>
                            <th className="py-2 px-3 text-right text-emerald-400">Ask</th>
                            <th className="py-2 px-3 text-right">Last</th>
                            <th className="py-2 px-3 text-right">IV</th>
                            <th className="py-2 px-3 text-right">Volume</th>
                            <th className="py-2 px-3 text-right">OI</th>
                            <th className="py-2 px-3 text-right">Chg%</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((c, idx) => {
                            const prev = sorted[idx - 1];
                            let sep = null;
                            if (
                                stockPrice > 0 && !inserted &&
                                prev && prev.strike >= stockPrice && c.strike < stockPrice
                            ) {
                                inserted = true;
                                sep = (
                                    <tr key="sep" className="border-y border-dashed border-gray-600">
                                        <td colSpan={8} className="py-1 text-center">
                                            <span className="inline-block px-3 py-0.5 rounded-full bg-gray-700 text-white font-bold text-xs">
                                                Current Price: ${stockPrice.toFixed(2)}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            }

                            const itm = isCall ? c.strike < stockPrice : c.strike > stockPrice;
                            return (
                                <React.Fragment key={c.strike}>
                                    {sep}
                                    <tr className={`border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors ${itm ? 'bg-gray-800/20' : ''}`}>
                                        <td className={`py-2 px-3 font-bold tabular-nums ${itm ? 'text-white' : 'text-gray-400'}`}>
                                            ${c.strike.toLocaleString()}
                                        </td>
                                        <td className="py-2 px-3 text-right text-orange-400 font-medium tabular-nums">
                                            {c.bid > 0 ? `$${c.bid.toFixed(2)}` : '—'}
                                        </td>
                                        <td className="py-2 px-3 text-right text-emerald-400 font-medium tabular-nums">
                                            {c.ask > 0 ? `$${c.ask.toFixed(2)}` : '—'}
                                        </td>
                                        <td className="py-2 px-3 text-right text-gray-300 tabular-nums">
                                            {c.lastPrice > 0 ? `$${c.lastPrice.toFixed(2)}` : '—'}
                                        </td>
                                        <td className="py-2 px-3 text-right text-gray-400 text-xs">
                                            {c.impliedVolatility > 0 ? `${(c.impliedVolatility * 100).toFixed(1)}%` : '—'}
                                        </td>
                                        <td className="py-2 px-3 text-right text-gray-400 text-xs tabular-nums">
                                            {c.volume > 0 ? c.volume.toLocaleString() : '—'}
                                        </td>
                                        <td className="py-2 px-3 text-right text-gray-400 text-xs tabular-nums">
                                            {c.openInterest > 0 ? c.openInterest.toLocaleString() : '—'}
                                        </td>
                                        <td className={`py-2 px-3 text-right text-xs ${c.percentChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                            {c.percentChange !== 0 ? `${c.percentChange >= 0 ? '+' : ''}${c.percentChange.toFixed(1)}%` : '—'}
                                        </td>
                                    </tr>
                                </React.Fragment>
                            );
                        })}
                    </tbody>
                </table>
                {sorted.length === 0 && (
                    <div className="text-center py-12 text-gray-500">No {label.toLowerCase()} contracts for this expiration</div>
                )}
            </div>
        </div>
    );
}

function StatCard({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-lg bg-gray-900 border border-gray-800 px-4 py-3">
            <div className="text-xs text-gray-500 mb-1">{label}</div>
            <div className="text-lg font-bold text-white">{value}</div>
        </div>
    );
}
