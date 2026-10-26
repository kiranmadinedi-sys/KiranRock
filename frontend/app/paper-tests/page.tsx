'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

/** Paper Tests (2026-10-19): options income (cash-secured puts) and the momentum satellite. */
export default function PaperTestsPage() {
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const load = async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/paper-tests/status`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
                if (!res.ok) throw new Error(`Load failed: ${res.status}`);
                setData(await res.json()); setError(null);
            } catch (e: any) { setError(e.message); }
        };
        load();
        const t = setInterval(load, 60000);
        return () => clearInterval(t);
    }, []);

    const $ = (v: number | null | undefined) => v == null ? '—' : `$${v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const card = 'bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6';
    const th = 'pb-2 text-left text-slate-500 dark:text-slate-400';
    const stat = (label: string, value: string, cls = '') => (
        <div><div className="text-xs text-slate-500 dark:text-slate-400">{label}</div><div className={`text-xl font-semibold text-slate-900 dark:text-white ${cls}`}>{value}</div></div>
    );

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
            <main className="max-w-7xl mx-auto px-4 py-6 space-y-6">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-white">🧪 Paper Tests</h1>
                    <p className="text-gray-600 dark:text-gray-400 mt-2">Strategies running on the paper account only — judged on real results before any real money</p>
                </div>
                {error && <div className="text-red-600">Error: {error}</div>}
                {!data ? <div className="text-slate-500">Loading...</div> : (<>
                    <div className={card}>
                        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Options income — cash-secured puts</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">Sell 1 put ~1 month out on quality stocks; buy back at 50% profit, 7 days before expiry, or at 3× (stop). Max 2 per sector; no earnings before expiry; the stock is protected from the swing bot while the put is open and after assignment.</p>
                        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-4">
                            {stat('Open / pending', `${data.options.summary.open} / ${data.options.summary.pending}`)}
                            {stat('Collateral in use', $(data.options.summary.collateral))}
                            {stat('Premium collected', $(data.options.summary.premiumCollected))}
                            {stat('Closed (won)', `${data.options.summary.closed} (${data.options.summary.wins})`)}
                            {stat('Closed P&L', $(data.options.summary.pnl), data.options.summary.pnl >= 0 ? 'text-green-600' : 'text-red-600')}
                            {stat('Open P&L (today)', $(data.options.summary.unrealized), (data.options.summary.unrealized ?? 0) >= 0 ? 'text-green-600' : 'text-red-600')}
                            {stat(`T-bills instead (${data.options.summary.riskFreePct ?? 4}%/yr)`, $(data.options.summary.tbillBenchmark))}
                        </div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">The fair test: closed + open P&amp;L should clearly beat what the same collateral would have earned in T-bills (SGOV) with no risk.</p>
                        <div className="overflow-x-auto"><table className="w-full text-sm">
                            <thead><tr>{['Contract', 'Stock', 'Sector', 'Strike', 'Expiry', 'Premium', 'Delta', 'Collateral', 'Status', 'P&L'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                            <tbody>{data.options.trades.map((o: any) => (
                                <tr key={o.contract + o.opened_at} className="border-t border-slate-100 dark:border-slate-700">
                                    <td className="py-2 font-mono text-xs">{o.contract}</td><td>{o.underlying}</td><td className="text-xs">{o.sector || '—'}</td><td>{$(o.strike)}</td><td>{o.expiry}</td>
                                    <td>{$(o.premium * 100)}</td><td>{o.delta?.toFixed(2) ?? '—'}</td><td>{$(o.collateral)}</td>
                                    <td>{o.status.replace('_', ' ')}{o.close_reason ? ` — ${o.close_reason}` : ''}</td>
                                    <td className={(o.pnl ?? o.unrealized) > 0 ? 'text-green-600' : (o.pnl ?? o.unrealized) < 0 ? 'text-red-600' : ''}>{o.pnl != null ? $(o.pnl) : o.unrealized != null ? `${$(o.unrealized)} (open)` : '—'}</td>
                                </tr>))}
                            </tbody>
                        </table></div>
                    </div>

                    <div className={card}>
                        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Momentum satellite — 10% of paper</h2>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">The 10 strongest large companies of the past 12 months, refreshed on the first trading day of each month.</p>
                        {data.satellite.performance && (
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-4">
                                {stat('Since', data.satellite.performance.since)}
                                {stat('Basket', `${data.satellite.performance.basketPct.toFixed(2)}%`, data.satellite.performance.basketPct >= 0 ? 'text-green-600' : 'text-red-600')}
                                {stat('SPY (same period)', `${data.satellite.performance.spyPct.toFixed(2)}%`)}
                            </div>)}
                        <div className="overflow-x-auto"><table className="w-full text-sm">
                            <thead><tr>{['Stock', 'Shares', 'Avg price', 'Price', 'Value', 'P&L'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                            <tbody>{data.satellite.positions.map((p: any) => (
                                <tr key={p.symbol} className="border-t border-slate-100 dark:border-slate-700">
                                    <td className="py-2 font-medium">{p.symbol}</td><td>{p.qty}</td><td>{$(p.avg)}</td><td>{$(p.price)}</td><td>{$(p.value)}</td>
                                    <td className={p.pl >= 0 ? 'text-green-600' : 'text-red-600'}>{$(p.pl)}</td>
                                </tr>))}
                            </tbody>
                        </table></div>
                    </div>
                </>)}
            </main>
        </div>
    );
}
