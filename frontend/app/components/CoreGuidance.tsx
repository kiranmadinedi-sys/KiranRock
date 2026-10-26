'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

/**
 * Core guidance (2026-10-26): rule-based alerts with suggested actions. Actionable ones arrive as
 * approval popups (one tap). The scorecard shows how each rule's suggestions turned out — that
 * record decides whether a rule ever acts on its own.
 */
const STATUS_STYLE: Record<string, string> = {
    open: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
    approved: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300',
    ignored: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
    expired: 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
    info: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300',
};
const LEVEL: Record<number, string> = { 0: 'Info only', 1: 'Alert + one-tap approval', 2: 'One-tap, tracked', 3: 'Automatic on paper', 4: 'Automatic on live (limited)' };

export default function CoreGuidance() {
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/core-holdings/guidance`, { headers: { 'Authorization': `Bearer ${localStorage.getItem('token')}` } });
                const d = await res.json();
                if (!res.ok) throw new Error(d.error || `Failed: ${res.status}`);
                setData(d);
            } catch (e: any) { setError(e.message); }
        })();
    }, []);

    const pct = (v: number | null | undefined) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}%`);

    return (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 mt-6">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">🧭 Guidance</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
                Checked every trading day at 10:20 AM ET. Suggestions that change core arrive as approval popups — nothing changes without your OK.
                A rule only becomes automatic after its record below shows its suggestions beat doing nothing (and, for real money, after your approval).
            </p>
            {error && <div className="text-red-600">Error: {error}</div>}
            {!data ? (!error && <div className="text-slate-500">Loading...</div>) : (<>
                {data.alerts.length === 0
                    ? <div className="text-slate-500 dark:text-slate-400 mb-4">No guidance yet — the first check runs on the next trading day.</div>
                    : (
                        <div className="space-y-3 mb-6">
                            {data.alerts.slice(0, 15).map((a: any) => (
                                <div key={a.id} className="border border-slate-100 dark:border-slate-700 rounded-xl p-3">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className={`px-2 py-0.5 rounded-full text-xs ${STATUS_STYLE[a.status] || STATUS_STYLE.info}`}>{a.status}</span>
                                        <span className="text-xs text-slate-500 dark:text-slate-400">{data.scorecard.rules[a.rule]?.label || a.rule} · {new Date(a.created_at).toLocaleDateString()}</span>
                                    </div>
                                    <div className="font-medium text-slate-900 dark:text-white mt-1">{a.title}</div>
                                    <div className="text-sm text-slate-700 dark:text-slate-300">{a.message}</div>
                                </div>
                            ))}
                        </div>
                    )}
                <h3 className="text-md font-semibold text-slate-900 dark:text-white mb-2">Rule scorecard</h3>
                <div className="overflow-x-auto"><table className="w-full text-sm">
                    <thead><tr>{['Rule', 'Autonomy level', 'Alerts (by decision)', '1 month: suggestion vs SPY', '3 months: suggestion vs SPY'].map(h =>
                        <th key={h} className="pb-2 text-left text-slate-500 dark:text-slate-400">{h}</th>)}</tr></thead>
                    <tbody>{Object.entries(data.scorecard.rules).map(([k, r]: [string, any]) => {
                        const counts = data.scorecard.counts.filter((c: any) => c.rule === k).map((c: any) => `${c.status} ${c.n}`).join(', ') || '—';
                        const out = (h: string) => data.scorecard.outcomes[h].filter((o: any) => o.rule === k)
                            .map((o: any) => `${o.status}: ${pct(o.avg_pct)} vs ${pct(o.spy_pct)} (${o.n})`).join(' · ') || 'not enough history yet';
                        return (
                            <tr key={k} className="border-t border-slate-100 dark:border-slate-700 align-top">
                                <td className="py-2 font-medium text-slate-900 dark:text-white">{r.label}</td>
                                <td className="py-2">{LEVEL[r.level] || r.level}</td>
                                <td className="py-2">{counts}</td>
                                <td className="py-2">{out('1m')}</td>
                                <td className="py-2">{out('3m')}</td>
                            </tr>);
                    })}</tbody>
                </table></div>
            </>)}
        </div>
    );
}
