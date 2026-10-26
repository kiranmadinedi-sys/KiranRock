'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

/** Core watchlist (2026-10-26): quality names with a daily entry status. Suggestions only — no orders. */

const GREEN = 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300';
const BLUE = 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';
const AMBER = 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300';
const ORANGE = 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300';
const RED = 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300';
const STATUS_STYLE: Record<string, string> = {
    'Dip — valuation OK': GREEN, 'Dip — review fundamentals': BLUE, 'Dip — but pricey': AMBER, 'No dip': BLUE,
    'Reassess': AMBER, 'Wait': AMBER, 'Review first': ORANGE, 'Avoid today': RED, 'Data unavailable': RED,
};
const pct = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(0)}%`);

export default function CoreWatchlist() {
    const [rows, setRows] = useState<any[] | null>(null);
    const [symbol, setSymbol] = useState('');
    const [error, setError] = useState<string | null>(null);
    const base = () => `${getApiBaseUrl()}/api/core-holdings/watchlist`;
    const headers = () => ({ 'Authorization': `Bearer ${localStorage.getItem('token')}`, 'Content-Type': 'application/json' });

    const call = async (url: string, init?: RequestInit) => {
        try {
            const res = await fetch(url, { ...init, headers: headers() });
            const d = await res.json();
            if (!res.ok) throw new Error(d.error || `Failed: ${res.status}`);
            setRows(d.rows); setError(null);
        } catch (e: any) { setError(e.message); }
    };
    useEffect(() => { call(base()); }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const money = (v: number | undefined) => (v == null ? '—' : `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);

    return (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 mt-6">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">👀 Watchlist — today&apos;s entry check</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                Suggestions only — nothing is bought automatically. Checked every trading day at 10:15 AM ET.
                A price drop is never treated as a buy signal: in our 2020–2026 test, buying these names on dips did no better than buying on any day.
                Each dip is checked against the company&apos;s own usual P/E (a rough valuation gauge, not a fair-value estimate), growth, news and earnings timing.
                Stale or unverifiable data shows <b>Data unavailable</b> instead of a suggestion.
            </p>
            <form className="flex gap-2 mb-4" onSubmit={e => { e.preventDefault(); if (symbol.trim()) { call(base(), { method: 'POST', body: JSON.stringify({ symbol }) }); setSymbol(''); } }}>
                <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())} placeholder="Add symbol, e.g. ORCL"
                    className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-900 dark:text-white w-48" />
                <button className="px-4 py-2 rounded-lg bg-blue-600 text-white">Add</button>
            </form>
            {error && <div className="text-red-600 mb-2">Error: {error}</div>}
            {!rows ? <div className="text-slate-500">Loading...</div> : (
                <div className="overflow-x-auto"><table className="w-full text-sm">
                    <thead><tr>{['Stock', 'Status', 'Why', 'Price', 'From 52w high', 'P/E vs usual', 'Growth (rev / EPS)', 'Earnings', 'Data as of', ''].map(h => <th key={h} className="pb-2 text-left text-slate-500 dark:text-slate-400">{h}</th>)}</tr></thead>
                    <tbody>{rows.map(r => (
                        <tr key={r.symbol} className="border-t border-slate-100 dark:border-slate-700 align-top">
                            <td className="py-2 font-medium text-slate-900 dark:text-white">{r.symbol}{r.inCore ? <span className="ml-1 text-xs text-slate-500">(in core)</span> : null}</td>
                            <td className="py-2"><span className={`px-2 py-0.5 rounded-full text-xs whitespace-nowrap ${STATUS_STYLE[r.status] || 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}`}>{r.status}</span></td>
                            <td className="py-2 text-slate-700 dark:text-slate-300">{(r.reasons || []).join(' · ')}</td>
                            <td className="py-2">{money(r.price)}</td>
                            <td className="py-2 whitespace-nowrap" title={r.hi52 ? `52w high ${money(r.hi52)} on ${r.hi52Date}` : ''}>{r.ddPct == null ? '—' : `−${Number(r.ddPct).toFixed(1)}%`}</td>
                            <td className="py-2 whitespace-nowrap" title={r.valuation?.pe ? `P/E ${r.valuation.pe.toFixed(1)} vs usual ${r.valuation.usualPe?.toFixed(1) ?? '?'} · forward P/E ${r.valuation.forwardPe?.toFixed(1) ?? '?'}` : ''}>{pct(r.valuation?.peVsUsualPct)}</td>
                            <td className="py-2 whitespace-nowrap">{pct(r.valuation?.revenueGrowthPct)} / {pct(r.valuation?.epsGrowthPct)}</td>
                            <td className="py-2 whitespace-nowrap">{r.earningsDate || (r.earningsKnown ? 'none soon' : '—')}</td>
                            <td className="py-2 whitespace-nowrap text-xs text-slate-500" title={r.sources || ''}>{r.asOf || '—'}</td>
                            <td className="py-2 text-right"><button className="text-xs text-red-600 hover:underline"
                                onClick={() => call(`${base()}/${r.symbol}`, { method: 'DELETE' })}>remove</button></td>
                        </tr>))}
                    </tbody>
                </table></div>
            )}
        </div>
    );
}
