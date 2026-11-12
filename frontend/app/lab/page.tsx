'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

/** Lab (2026-11-12, admin only): research ideas, ORACLE shadow test, news events, AI spend. Read-only. */

const TABS = ['Ideas', 'ORACLE shadow', 'News events', 'AI spend'] as const;
type Tab = typeof TABS[number];

const card = 'bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-5';
const th = 'pb-2 pr-4 text-left text-xs font-medium text-slate-500 dark:text-slate-400 whitespace-nowrap';
const td = 'py-1.5 pr-4 text-slate-700 dark:text-slate-300 whitespace-nowrap';
const day = (v: string) => (v ? String(v).slice(0, 10) : '—');
const usd = (v: number | null | undefined) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
const num = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString());
const pct = (v: number | null | undefined, d = 2) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(d)}%`);

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className={card}>
            <div className="text-xs text-slate-500 dark:text-slate-400">{label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900 dark:text-white">{value}</div>
            {sub && <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">{sub}</div>}
        </div>
    );
}

export default function LabPage() {
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>('Ideas');
    const [open, setOpen] = useState<number | null>(null);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/lab/summary`, { headers: { Authorization: `Bearer ${localStorage.getItem('token')}` } });
                const d = await res.json();
                if (!res.ok) throw new Error(d.error || `Load failed: ${res.status}`);
                setData(d);
            } catch (e: any) { setError(e.message); }
        })();
    }, []);

    if (error) return <div className="max-w-7xl mx-auto px-4 py-8 text-red-600">Error: {error}</div>;
    if (!data) return <div className="max-w-7xl mx-auto px-4 py-8 text-slate-500">Loading…</div>;

    const ideas: any[] = data.ideas || [];
    const passed = ideas.filter(i => i.status === 'pass').length;
    const tested = ideas.filter(i => i.status === 'pass' || i.status === 'fail').length;
    const sh = data.shadow || {};
    const shTot = (sh.daily || []).reduce((a: any, r: any) => ({
        checks: a.checks + r.checks, both: a.both + r.both, agree: a.agree + r.agree, usd: a.usd + r.gemini_usd, local: a.local + r.local_answered,
    }), { checks: 0, both: 0, agree: 0, usd: 0, local: 0 });
    const spendTotal = (data.spend?.byService || []).reduce((a: number, r: any) => a + Number(r.usd || 0), 0);
    const news = data.news || {};

    return (
        <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
            <div>
                <h1 className="text-2xl font-bold text-slate-900 dark:text-white">🔬 Lab</h1>
                <p className="text-sm text-slate-500 dark:text-slate-400">
                    Research and experiments. Display only: nothing here changes trading. Ideas reach the bot only after they pass the lab bar and you approve them.
                </p>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Stat label="Lab ideas tested" value={`${tested}`} sub={`${passed} passed · ${ideas.length - tested} waiting`} />
                <Stat label="ORACLE shadow checks" value={num(shTot.checks)} sub={shTot.both ? `agree ${Math.round(shTot.agree / shTot.both * 100)}% where both answered` : 'no paired answers yet'} />
                <Stat label="News headlines sorted" value={num(news.range?.n)} sub={`${day(news.range?.first)} → ${day(news.range?.last)}`} />
                <Stat label="Gemini spend (all time)" value={usd(spendTotal)} sub="metered calls, from the cost ledger" />
            </div>

            <div className="flex flex-wrap gap-2">
                {TABS.map(t => (
                    <button key={t} onClick={() => setTab(t)}
                        className={`px-4 py-2 rounded-lg text-sm ${tab === t ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>{t}</button>
                ))}
            </div>

            {tab === 'Ideas' && (
                <div className={card}>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                        Every idea, tested on about 3 years of prices with a hold-out period. The bar: train edge ≥ 0.3 pp with t ≥ 2.5, hold-out edge ≥ 0.2 pp with t ≥ 1.5.
                        Runs Saturdays at 1 PM ET; the research agent proposes new ideas the same morning. Click a row for details.
                    </p>
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                        <thead><tr>{['Idea', 'Family', 'From', 'Result', 'Train edge', 'Hold-out edge', 'Trades', 'Tested'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                        <tbody>{ideas.map(i => {
                            const r = i.result || {};
                            return (
                                <React.Fragment key={i.id}>
                                    <tr className="border-t border-slate-100 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40" onClick={() => setOpen(open === i.id ? null : i.id)}>
                                        <td className={`${td} font-medium text-slate-900 dark:text-white`}>{i.name}</td>
                                        <td className={td}>{i.family || '—'}</td>
                                        <td className={td}>{i.source || '—'}</td>
                                        <td className={td}><span className={`px-2 py-0.5 rounded-full text-xs ${i.status === 'pass' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' : i.status === 'fail' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}`}>{i.status}</span></td>
                                        <td className={td}>{r.train ? `${pct(r.train.edgePp)} (t ${r.train.t})` : '—'}</td>
                                        <td className={td}>{r.holdout ? `${pct(r.holdout.edgePp)} (t ${r.holdout.t})` : '—'}</td>
                                        <td className={td}>{num(r.trades)}</td>
                                        <td className={td}>{day(i.tested_at)}</td>
                                    </tr>
                                    {open === i.id && (
                                        <tr><td colSpan={8} className="pb-3 text-sm text-slate-600 dark:text-slate-300 whitespace-normal">
                                            <div className="mt-1"><b>Idea:</b> {i.idea || '—'}</div>
                                            {r.why && <div className="mt-1"><b>Why:</b> {r.why}</div>}
                                            {r.years && <div className="mt-1"><b>By year:</b> {Object.entries(r.years).map(([y, v]) => `${y} ${pct(Number(v))}`).join(' · ')}</div>}
                                        </td></tr>
                                    )}
                                </React.Fragment>
                            );
                        })}</tbody>
                    </table></div>
                </div>
            )}

            {tab === 'ORACLE shadow' && (
                <div className="space-y-4">
                    <div className={card}>
                        <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                            Gemini answers the same live candidate check as the local model, logged side by side. Gemini&apos;s answer is never used to trade.
                            &ldquo;No answer&rdquo; on the local side means the local model was busy or timed out. Local answered {num(shTot.local)} of {num(shTot.checks)}.
                        </p>
                        <div className="overflow-x-auto"><table className="w-full text-sm">
                            <thead><tr>{['Day', 'Checks', 'Local answered', 'Gemini answered', 'Both', 'Agree', 'Local time', 'Gemini time', 'Gemini cost'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                            <tbody>{(sh.daily || []).map((r: any) => (
                                <tr key={r.day} className="border-t border-slate-100 dark:border-slate-700">
                                    <td className={td}>{day(r.day)}</td><td className={td}>{r.checks}</td><td className={td}>{r.local_answered}</td>
                                    <td className={td}>{r.gemini_answered}</td><td className={td}>{r.both}</td>
                                    <td className={td}>{r.both ? `${r.agree} (${Math.round(r.agree / r.both * 100)}%)` : '—'}</td>
                                    <td className={td}>{r.local_ms ? `${(r.local_ms / 1000).toFixed(0)} s` : '—'}</td>
                                    <td className={td}>{r.gemini_ms ? `${(r.gemini_ms / 1000).toFixed(1)} s` : '—'}</td>
                                    <td className={td}>{usd(r.gemini_usd)}</td>
                                </tr>))}</tbody>
                        </table></div>
                    </div>
                    <div className="grid md:grid-cols-2 gap-4">
                        <div className={card}>
                            <h3 className="font-semibold text-slate-900 dark:text-white mb-1">Who was right?</h3>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Stock return over the 5 trading days after each check, by verdict. Needs 5 trading days to fill in.</p>
                            <table className="w-full text-sm">
                                <thead><tr>{['Model', 'Verdict', 'Checks', 'With outcome', 'Avg 5-day', 'Went up'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                                <tbody>{(sh.byVerdict || []).map((r: any) => (
                                    <tr key={`${r.model}-${r.verdict}`} className="border-t border-slate-100 dark:border-slate-700">
                                        <td className={td}>{r.model}</td><td className={td}>{r.verdict}</td><td className={td}>{r.n}</td>
                                        <td className={td}>{r.n_with_outcome}</td><td className={td}>{pct(r.avg_5d_pct)}</td>
                                        <td className={td}>{r.up_pct == null ? '—' : `${r.up_pct}%`}</td>
                                    </tr>))}</tbody>
                            </table>
                        </div>
                        <div className={card}>
                            <h3 className="font-semibold text-slate-900 dark:text-white mb-3">Local vs Gemini verdicts</h3>
                            <table className="w-full text-sm">
                                <thead><tr>{['Local said', 'Gemini said', 'Checks'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                                <tbody>{(sh.matrix || []).map((r: any) => (
                                    <tr key={`${r.local}-${r.gemini}`} className="border-t border-slate-100 dark:border-slate-700">
                                        <td className={td}>{r.local}</td><td className={td}>{r.gemini}</td><td className={td}>{r.n}</td>
                                    </tr>))}</tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {tab === 'News events' && (
                <div className={card}>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                        Headlines from {day(news.range?.first)} to {day(news.range?.last)}, sorted into event types so lab ideas can test them
                        (rules first, Gemini for the rest: {num(news.range?.by_gemini)} by Gemini). A one-time sort; about $24 of the Gemini spend.
                    </p>
                    <table className="w-full text-sm">
                        <thead><tr>{['Event type', 'Headlines', 'Stocks', 'Share'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                        <tbody>{(news.types || []).map((r: any) => (
                            <tr key={r.event_type} className="border-t border-slate-100 dark:border-slate-700">
                                <td className={td}>{r.event_type}</td><td className={td}>{num(r.n)}</td><td className={td}>{num(r.symbols)}</td>
                                <td className={td}>{news.range?.n ? `${(r.n / news.range.n * 100).toFixed(1)}%` : '—'}</td>
                            </tr>))}</tbody>
                    </table>
                </div>
            )}

            {tab === 'AI spend' && (
                <div className="space-y-4">
                    <div className={card}>
                        <h3 className="font-semibold text-slate-900 dark:text-white mb-3">By feature (all time)</h3>
                        <table className="w-full text-sm">
                            <thead><tr>{['Feature', 'Calls', 'Spend', 'Since'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                            <tbody>{(data.spend?.byService || []).map((r: any) => (
                                <tr key={r.service} className="border-t border-slate-100 dark:border-slate-700">
                                    <td className={td}>{r.service}</td><td className={td}>{num(r.calls)}</td><td className={td}>{usd(r.usd)}</td><td className={td}>{day(r.since)}</td>
                                </tr>))}</tbody>
                        </table>
                    </div>
                    <div className={card}>
                        <h3 className="font-semibold text-slate-900 dark:text-white mb-3">By day (last 60 days)</h3>
                        <div className="overflow-x-auto max-h-96"><table className="w-full text-sm">
                            <thead><tr>{['Day', 'Feature', 'Calls', 'Spend'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                            <tbody>{(data.spend?.daily || []).map((r: any) => (
                                <tr key={`${r.day}-${r.service}`} className="border-t border-slate-100 dark:border-slate-700">
                                    <td className={td}>{day(r.day)}</td><td className={td}>{r.service}</td><td className={td}>{num(r.calls)}</td><td className={td}>{usd(r.usd)}</td>
                                </tr>))}</tbody>
                        </table></div>
                    </div>
                    <div className={card}>
                        <h3 className="font-semibold text-slate-900 dark:text-white mb-1">Subscriptions</h3>
                        <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">Fixed monthly plans. A blank price means it hasn&apos;t been entered yet.</p>
                        <table className="w-full text-sm">
                            <thead><tr>{['Service', 'Monthly', 'Notes'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                            <tbody>{(data.spend?.subscriptions || []).map((r: any) => (
                                <tr key={r.service} className="border-t border-slate-100 dark:border-slate-700">
                                    <td className={td}>{r.service}</td><td className={td}>{r.monthly_usd == null ? '—' : usd(r.monthly_usd)}</td>
                                    <td className={`${td} whitespace-normal`}>{r.notes}</td>
                                </tr>))}</tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}
