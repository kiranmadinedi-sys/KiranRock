'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

/** Lab (2026-11-12, admin only): research ideas, ORACLE shadow test, news events, AI spend. Read-only. */

const TABS = ['Daily tips', 'Ideas', 'ORACLE shadow', 'News events', 'Options IV', 'Options lab', 'AI spend'] as const;
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

/** Beginner wording for one tested idea, from its stored result. */
function plainResult(i: any): string {
    const r = i.result || {};
    if (i.status === 'queued') return 'Waiting to be tested (next Saturday run).';
    if (i.status === 'error') return 'The test could not run; nothing was learned.';
    if (i.status === 'pass') return 'Beat the market in both the old and the recent test, after trading costs. Next step: a trial in the practice (paper) account. Never live without your approval.';
    if (i.status === 'promising') return 'Made money after costs in both tests, but the proof is not strong enough yet. Kept on the list and re-tested every Saturday. Not traded.';
    const tr = r.train?.netPp ?? r.train?.edgePp, ho = r.holdout?.netPp ?? r.holdout?.edgePp;
    if (tr == null) return 'Too few past examples to judge.';
    if (tr <= 0 && (ho == null || ho <= 0)) return 'Did worse than simply buying any stock that day. Not useful.';
    if (tr > 0 && ho != null && ho <= 0) return 'Looked good in older years, but stopped working recently. Probably luck.';
    if (tr > 0 && (r.train?.t ?? 0) < 2.5) return 'Slightly better than average, but too small to rule out luck.';
    return 'Close, but missed at least one check (recent months or too many losing years).';
}

/** Small IV line for one symbol; one dot per day until there's enough for a line. */
function IvChart({ history }: { history: { d: string; iv: number }[] }) {
    const pts = history.filter(h => h.iv != null);
    if (!pts.length) return null;
    const W = 560, H = 120, P = 24;
    const lo = Math.min(...pts.map(p => p.iv)), hi = Math.max(...pts.map(p => p.iv));
    const span = hi - lo || hi * 0.2 || 0.01;
    const x = (i: number) => pts.length === 1 ? W / 2 : P + i * (W - 2 * P) / (pts.length - 1);
    const y = (v: number) => H - P - (v - (lo - span * 0.1)) / (span * 1.2) * (H - 2 * P);
    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-xl h-32 text-blue-600 dark:text-blue-400">
            {pts.length > 1 && <polyline fill="none" stroke="currentColor" strokeWidth="2" points={pts.map((p, i) => `${x(i)},${y(p.iv)}`).join(' ')} />}
            {pts.map((p, i) => <circle key={p.d} cx={x(i)} cy={y(p.iv)} r="3" fill="currentColor"><title>{`${p.d}: ${(p.iv * 100).toFixed(1)}%`}</title></circle>)}
            <text x={P} y={H - 4} fontSize="11" className="fill-slate-500">{pts[0].d}</text>
            <text x={W - P} y={H - 4} fontSize="11" textAnchor="end" className="fill-slate-500">{pts[pts.length - 1].d}</text>
            <text x={4} y={14} fontSize="11" className="fill-slate-500">{`${(hi * 100).toFixed(0)}%`}</text>
            <text x={4} y={H - P} fontSize="11" className="fill-slate-500">{`${(lo * 100).toFixed(0)}%`}</text>
        </svg>
    );
}

export default function LabPage() {
    const [data, setData] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const [tab, setTab] = useState<Tab>('Daily tips');
    const [tipDay, setTipDay] = useState(0);
    const [open, setOpen] = useState<number | null>(null);
    const [ivOpen, setIvOpen] = useState<string | null>(null);

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
    const tested = ideas.filter(i => ['pass', 'promising', 'fail'].includes(i.status)).length;
    const promising = ideas.filter(i => i.status === 'promising').length;
    const net = (p: any) => (p?.netPp ?? p?.edgePp);
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

            <details open className={`${card} text-sm text-slate-700 dark:text-slate-300`}>
                <summary className="cursor-pointer font-semibold text-slate-900 dark:text-white">New here? How to read the Lab (2-minute guide)</summary>
                <div className="mt-3 space-y-3">
                    <p><b>What the Lab is:</b> a testing room for trading ideas. It does <b>not</b> predict which stock goes up tomorrow; the daily stock picks are on the Dashboard.
                        An &ldquo;idea&rdquo; is a shortcut such as <i>&ldquo;when a stock falls 5 days in a row, buy it&rdquo;</i>. The Lab replays about 3 years of real prices to see what would have happened if we had followed it every time.</p>
                    <p><b>How an idea passes:</b> it must beat simply buying <i>any</i> stock on the same days, first on older years (2023 to mid-2025),
                        and then again on recent months it was never tuned on. Doing well only once usually means luck, so both must agree.
                        Every result already has trading costs taken off (0.15% per trade), the recent months must also beat simply holding the S&amp;P 500 (SPY),
                        and because we test many ideas, a &ldquo;luck check&rdquo; makes sure a winner isn&apos;t just the lucky one out of many.</p>
                    <p><b>Three results:</b> <span className="text-green-700 dark:text-green-400 font-semibold">pass</span> (strong proof, goes to a practice-money trial),
                        <span className="text-amber-700 dark:text-amber-400 font-semibold"> promising</span> (made money in both tests but proof not strong enough yet; re-tested every Saturday, never traded),
                        <span className="text-red-700 dark:text-red-400 font-semibold"> fail</span> (no real advantage).</p>
                    <p><b>Why most ideas fail, and why that&apos;s good:</b> beating the market is hard, and most shortcuts that sound clever don&apos;t survive an honest test.
                        Every &ldquo;fail&rdquo; is a bad idea stopped before it cost real money. A &ldquo;pass&rdquo; only earns a trial with practice money (paper account); real accounts change only with your approval.</p>
                    <div>
                        <b>What happens every Saturday (Central time):</b>
                        <ul className="list-disc ml-5 mt-1 space-y-0.5">
                            <li>9 AM: checks which parts of the bot&apos;s stock score really predicted this week&apos;s moves</li>
                            <li>11 AM: Gemini (AI) reads the week&apos;s results and past Lab lessons, then writes new ideas</li>
                            <li>12 PM: every new idea is tested; results appear in the <b>Ideas</b> tab</li>
                        </ul>
                    </div>
                    <div>
                        <b>The tabs in one line each:</b>
                        <ul className="list-disc ml-5 mt-1 space-y-0.5">
                            <li><b>Daily tips:</b> a short evening note in plain English: market mood, top-scored stocks, news on our holdings, one lesson.</li>
                            <li><b>Ideas:</b> every idea tested, with the result in plain words.</li>
                            <li><b>ORACLE shadow:</b> a contest between our free local AI and Gemini, judging the same stocks. Only the local AI&apos;s answer is used to trade.</li>
                            <li><b>News events:</b> 3 years of headlines sorted by type (earnings, upgrades, lawsuits…), raw material for news-based ideas.</li>
                            <li><b>Options IV:</b> how big a price swing the options market expects for each stock (higher = more nervous), and whether that&apos;s more or less than the stock really moves.</li>
                            <li><b>Options lab:</b> replays real past option prices to test put-selling rules, and replays our own put trades with other exit rules. Research only.</li>
                            <li><b>AI spend:</b> what the paid AI (Gemini) has cost, by feature and by day.</li>
                        </ul>
                    </div>
                </div>
            </details>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                <Stat label="Lab ideas tested" value={`${tested}`} sub={`${passed} passed · ${promising} promising · ${ideas.length - tested} waiting`} />
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

            {tab === 'Daily tips' && (
                <div className="space-y-4">
                    <div className={card}>
                        <p className="text-sm text-slate-700 dark:text-slate-300">
                            <b>In plain words:</b> every evening (about 6:30 PM CT) the Lab writes a short note from our own data: the market&apos;s mood,
                            the bot&apos;s top-scored stocks, whether its score is still working, news on stocks we hold, the options market, and one lesson from past tests.
                            It&apos;s information to help you understand the day. <b>It doesn&apos;t place trades or change the bot.</b>
                        </p>
                        {(data.tips || []).length > 1 && (
                            <div className="flex flex-wrap gap-2 mt-3">
                                {(data.tips || []).map((t: any, i: number) => (
                                    <button key={t.day} onClick={() => setTipDay(i)}
                                        className={`px-3 py-1 rounded-lg text-xs ${tipDay === i ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}`}>{day(t.day)}</button>
                                ))}
                            </div>
                        )}
                    </div>
                    {!(data.tips || []).length && <div className={`${card} text-sm text-slate-500`}>No tips yet. The first note is written this evening.</div>}
                    {(data.tips?.[tipDay]?.tips || []).map((t: any, i: number) => (
                        <div key={i} className={card}>
                            <div className="font-semibold text-slate-900 dark:text-white">{t.icon} {t.title}</div>
                            <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">{t.text}</p>
                        </div>
                    ))}
                </div>
            )}

            {tab === 'Ideas' && (
                <div className={card}>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                        <b>In plain words</b> is the quick answer. For the numbers: <b>Old years</b> and <b>Recent months</b> show how much better (+) or worse (−) each trade did
                        than buying any stock that day, in percent, <b>after trading costs</b>; &ldquo;t&rdquo; is how sure we are it isn&apos;t luck (2.5 or more is convincing).
                        <b> vs S&amp;P 500</b> compares the recent months with simply holding SPY. <b>Luck check</b>: below 0.10 means it is very unlikely to be a lucky fluke among all the ideas we tried.
                        To pass: old years +0.3% with t 2.5+, recent months +0.2% with t 1.5+, beats SPY, luck check 0.10 or less. <b>From</b>: starter = first batch, agent = written by Gemini, manual = you or me.
                        Click a row for details.
                    </p>
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                        <thead><tr>{['Idea', 'Result', 'In plain words', 'Old years (to Jun 2025)', 'Recent months', 'vs S&P 500', 'Luck check', 'Times it fired', 'From', 'Tested'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                        <tbody>{[...ideas].sort((a, b) => ['pass', 'promising', 'queued'].indexOf(b.status) - ['pass', 'promising', 'queued'].indexOf(a.status)).map(i => {
                            const r = i.result || {};
                            return (
                                <React.Fragment key={i.id}>
                                    <tr className="border-t border-slate-100 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40" onClick={() => setOpen(open === i.id ? null : i.id)}>
                                        <td className={`${td} font-medium text-slate-900 dark:text-white whitespace-normal min-w-[14rem]`}>{i.name}</td>
                                        <td className={td}><span className={`px-2 py-0.5 rounded-full text-xs ${i.status === 'pass' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' : i.status === 'promising' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' : i.status === 'fail' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-300'}`}>{i.status}</span></td>
                                        <td className={`${td} whitespace-normal min-w-[16rem]`}>{plainResult(i)}</td>
                                        <td className={td}>{r.train ? `${pct(net(r.train))} (t ${r.train.t})` : '—'}</td>
                                        <td className={td}>{r.holdout ? `${pct(net(r.holdout))} (t ${r.holdout.t})` : '—'}</td>
                                        <td className={td}>{r.holdout?.vsSpyPp != null ? pct(r.holdout.vsSpyPp) : '—'}</td>
                                        <td className={td}>{r.fdrQ != null ? r.fdrQ.toFixed(2) : '—'}</td>
                                        <td className={td}>{num(r.trades)}</td>
                                        <td className={td}>{i.source || '—'}</td>
                                        <td className={td}>{day(i.tested_at)}</td>
                                    </tr>
                                    {open === i.id && (
                                        <tr><td colSpan={10} className="pb-3 text-sm text-slate-600 dark:text-slate-300 whitespace-normal">
                                            <div className="mt-1"><b>Idea:</b> {i.idea || '—'}</div>
                                            {i.family && <div className="mt-1"><b>Group:</b> {i.family}</div>}
                                            {r.winPct != null && <div className="mt-1"><b>Winning trades:</b> {r.winPct}% of {num(r.trades)}</div>}
                                            {r.profitFactor != null && <div className="mt-1"><b>Profit factor:</b> {r.profitFactor} (money won ÷ money lost; above 1 = more won than lost, before comparing with the market)
                                                {r.avgWinPct != null && <> · average win {pct(r.avgWinPct)}, average loss {pct(r.avgLossPct)}</>}</div>}
                                            {r.maxDrawdownPp != null && <div className="mt-1"><b>Worst losing stretch vs the market:</b> about −{r.maxDrawdownPp}% · longest run of losing days: {r.longestLosingDates}</div>}
                                            {r.regimes && <div className="mt-1"><b>When the market was rising / falling</b> (S&amp;P 500 above / below its 200-day average): {r.regimes.spyAbove200 ? pct(r.regimes.spyAbove200.netPp) : '—'} / {r.regimes.spyBelow200 ? pct(r.regimes.spyBelow200.netPp) : '—'}</div>}
                                            {r.robustness && <div className="mt-1"><b>Robustness:</b> {r.robustness.positiveBoth} of {r.robustness.tested} nearby settings still made money after costs in both tests
                                                {' '}({r.robustness.share >= 0.6 ? 'solid: a real pattern usually survives small changes' : 'fragile: it may only work with these exact numbers'}).
                                                <span className="text-slate-500"> {r.robustness.variants.map((v: any) => `${v.label}: ${pct(v.trainNetPp)} / ${pct(v.holdoutNetPp)}`).join(' · ')}</span></div>}
                                            {r.horizons && <div className="mt-1"><b>Holding longer or shorter</b> (recent months, after costs): {Object.entries(r.horizons).map(([h, v]: [string, any]) => `${h} days ${v.holdoutNetPp != null ? pct(v.holdoutNetPp) : '—'}`).join(' · ')}</div>}
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
                        <p className="text-sm text-slate-700 dark:text-slate-300 mb-2">
                            <b>In plain words:</b> before buying, the bot asks an AI &ldquo;should I trade this stock?&rdquo;. Today that&apos;s our free AI running on this PC.
                            As a test, Gemini (paid, fast) secretly answers the same question. After 5 trading days we check whose &ldquo;trade&rdquo; picks actually went up.
                            If Gemini proves clearly better, switching would need your approval.
                        </p>
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
                            <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                                What each stock did after each verdict (one count per stock per day). <b>vs S&amp;P</b> = better (+) or worse (−) than the S&amp;P 500 over the same days,
                                so a rising market doesn&apos;t make every answer look right. <b>Best move</b> / <b>Worst dip</b> = on average, how high it went and how far it fell within 10 days:
                                a good &ldquo;TRADE&rdquo; call should have a bigger best move and a smaller dip. Columns fill in as days pass (5, 10, then 20 trading days).
                            </p>
                            <table className="w-full text-sm">
                                <thead><tr>{['Model', 'Verdict', 'Stocks', 'With outcome', 'Avg 5-day', 'Went up', 'vs S&P 5 days', 'vs S&P 10 days', 'vs S&P 20 days', 'Best move (10 days)', 'Worst dip (10 days)'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                                <tbody>{(sh.byVerdict || []).map((r: any) => (
                                    <tr key={`${r.model}-${r.verdict}`} className="border-t border-slate-100 dark:border-slate-700">
                                        <td className={td}>{r.model}</td><td className={td}>{r.verdict}</td><td className={td}>{r.n}</td>
                                        <td className={td}>{r.n_with_outcome}</td><td className={td}>{pct(r.avg_5d_pct)}</td>
                                        <td className={td}>{r.up_pct == null ? '—' : `${r.up_pct}%`}</td>
                                        <td className={td}>{r.vs_spy_5d == null ? '—' : pct(r.vs_spy_5d)}</td>
                                        <td className={td}>{r.vs_spy_10d == null ? '—' : pct(r.vs_spy_10d)}</td>
                                        <td className={td}>{r.vs_spy_20d == null ? '—' : `${pct(r.vs_spy_20d)} (${r.n_20d})`}</td>
                                        <td className={td}>{r.best_10d == null ? '—' : pct(r.best_10d)}</td>
                                        <td className={td}>{r.worst_10d == null ? '—' : pct(r.worst_10d)}</td>
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
                    <p className="text-sm text-slate-700 dark:text-slate-300 mb-2">
                        <b>In plain words:</b> a library of past headlines, each labelled by type. It lets the Lab test ideas like
                        &ldquo;do stocks keep rising after an analyst upgrade?&rdquo;. On its own it doesn&apos;t make any trades.
                    </p>
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

            {tab === 'Options IV' && (
                <div className={card}>
                    <p className="text-sm text-slate-700 dark:text-slate-300 mb-2">
                        <b>In plain words:</b> how jumpy the options market thinks each stock will be over the next month. SPY at 14% means a normal month moves it about ±4%;
                        a stock at 80% could easily move ±23%. Selling options pays more on jumpy stocks, but they&apos;re riskier.
                        The useful signal comes later: when a stock is much jumpier than its <i>own</i> normal (high IV rank), option sellers are being paid extra.
                    </p>
                    <p className="text-sm text-slate-700 dark:text-slate-300 mb-2">
                        <b>IV ÷ actual</b> compares what options <i>expect</i> with how much the stock <i>really</i> swung over the last 20 days.
                        <span className="text-green-700 dark:text-green-400"> Green (1.2 or more)</span>: options pay for bigger swings than the stock is making, so selling is better paid.
                        <span className="text-red-700 dark:text-red-400"> Red (below 0.9)</span>: the stock is moving more than options pay for, so selling puts there is underpaid risk.
                        <b> IV percentile</b>: on what share of past days IV was lower than today (fills in after 20 days).
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-400 mb-3">
                        Implied volatility: the yearly price swing the options market is pricing in, from at-the-money options about 30 days out.
                        Recorded once a day near the close for the index ETFs, the biggest option names, open puts and the put candidates.
                        Divide by about 3.5 for the expected one-month move (SPY 14% ≈ ±4%). <b>IV rank</b> shows where today sits in that stock&apos;s own range
                        (0 = calmest seen, 100 = most nervous); it fills in after {data.iv?.rankMinDays ?? 20} days of history.
                        {' '}{data.iv?.days ? `${data.iv.days} day(s) so far, ${day(data.iv.first)} → ${day(data.iv.last)}.` : 'No snapshots yet.'} Click a row for its history.
                    </p>
                    <div className="overflow-x-auto"><table className="w-full text-sm">
                        <thead><tr>{['Symbol', 'Price', 'IV', '≈ 1-month move', 'Actual swings (20 days)', 'IV ÷ actual', 'Change vs prior day', 'IV rank', 'IV percentile', 'Range seen', 'Days'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                        <tbody>{(data.iv?.latest || []).map((r: any) => (
                            <React.Fragment key={r.symbol}>
                                <tr className="border-t border-slate-100 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40" onClick={() => setIvOpen(ivOpen === r.symbol ? null : r.symbol)}>
                                    <td className={`${td} font-medium text-slate-900 dark:text-white`}>{r.symbol}</td>
                                    <td className={td}>{r.price == null ? '—' : `$${Number(r.price).toFixed(2)}`}</td>
                                    <td className={td}>{r.iv == null ? '—' : `${(r.iv * 100).toFixed(1)}%`}</td>
                                    <td className={td}>{r.iv == null ? '—' : `±${(r.iv * 100 / Math.sqrt(12)).toFixed(1)}%`}</td>
                                    <td className={td}>{r.rv20 == null ? '—' : `${(r.rv20 * 100).toFixed(1)}%`}</td>
                                    <td className={`${td} ${r.ivVsRv >= 1.2 ? 'text-green-600 dark:text-green-400' : r.ivVsRv != null && r.ivVsRv < 0.9 ? 'text-red-600 dark:text-red-400' : ''}`}
                                        title={r.ivVsRv >= 1.2 ? 'Premium is rich: options price in bigger swings than the stock is making' : r.ivVsRv != null && r.ivVsRv < 0.9 ? 'Premium is cheap: the stock is swinging more than options price in' : ''}>
                                        {r.ivVsRv == null ? '—' : r.ivVsRv.toFixed(2)}</td>
                                    <td className={`${td} ${r.change > 0 ? 'text-red-600 dark:text-red-400' : r.change < 0 ? 'text-green-600 dark:text-green-400' : ''}`}>
                                        {r.change == null ? '—' : `${r.change >= 0 ? '+' : ''}${(r.change * 100).toFixed(1)} pts`}</td>
                                    <td className={td}>{r.rank == null ? `needs ${data.iv.rankMinDays} days` : r.rank}</td>
                                    <td className={td}>{r.percentile == null ? `needs ${data.iv.rankMinDays} days` : `${r.percentile}%`}</td>
                                    <td className={td}>{r.lo == null ? '—' : `${(r.lo * 100).toFixed(0)}–${(r.hi * 100).toFixed(0)}%`}</td>
                                    <td className={td}>{r.days}</td>
                                </tr>
                                {ivOpen === r.symbol && (
                                    <tr><td colSpan={11} className="pb-3"><IvChart history={r.history} /></td></tr>
                                )}
                            </React.Fragment>
                        ))}</tbody>
                    </table></div>
                </div>
            )}

            {tab === 'Options lab' && (() => {
                const own = data.optionsLab?.own_trades, csp = data.optionsLab?.csp_backtest;
                const exitLabel: Record<string, string> = { current: 'our rules (50% profit · 3× stop · close 7 days left)', tp50_hold: '50% profit, else hold', hold: 'hold to expiry', tp50_stop2: '50% profit · 2× stop', tp50_close14: '50% profit · close 14 days left' };
                const filterLabel: Record<string, string> = { none: 'all', uptrend: 'stock above 200-day', no_earnings: 'no earnings before expiry', iv_rich: 'IV ≥ 1.2× actual swings', liquid: 'busy contracts (20+ traded)' };
                return (
                    <div className="space-y-4">
                        <div className={card}>
                            <p className="text-sm text-slate-700 dark:text-slate-300">
                                <b>In plain words:</b> we sell &ldquo;cash-secured puts&rdquo;: we get paid now, and in return promise to buy the stock at a lower price (the strike) if it falls below it.
                                This tab replays <b>real past option prices</b> to see which rules would have made money, and replays our own trades with other exit rules.
                                <b> Research only:</b> it can&apos;t place orders, and options rules change only after the Nov 21 review with your approval.
                            </p>
                            <p className="text-xs text-slate-500 dark:text-slate-400 mt-2">
                                Honest limits: Alpaca only has option prices from Feb 2024, with daily trade prices but no bid/ask, so we add a 5% cost to every sale and buy-back.
                                Thinly traded contracts can go days without a trade, so some prices are stale. Nothing is invented: a day with no trade is simply not checked.
                            </p>
                        </div>

                        <div className={card}>
                            <h3 className="font-semibold text-slate-900 dark:text-white mb-1">Our own put trades, replayed {own?.at ? `(${day(own.at)})` : ''}</h3>
                            {!own ? <p className="text-sm text-slate-500">Runs every Saturday afternoon.</p> : (<>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                                    &ldquo;Actual&rdquo; is what the paper account really did. The other columns replay the same puts on real daily closing prices with a different exit rule
                                    (&ldquo;open&rdquo; = not finished yet). A big gap between actual and &ldquo;our rules&rdquo; means our real fills were worse than the market: usually wide, jumpy quotes on rarely traded contracts.
                                </p>
                                <div className="flex flex-wrap gap-3 mb-3">
                                    {Object.entries(own.totals || {}).map(([k, v]: [string, any]) => (
                                        <div key={k} className="rounded-lg bg-slate-50 dark:bg-slate-700/40 px-3 py-2 text-sm">
                                            <div className="text-xs text-slate-500">{k === 'actual' ? 'actual (paper account)' : k}</div>
                                            <div className={`font-semibold ${v.pnl >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>{usd(v.pnl)}</div>
                                            <div className="text-xs text-slate-500">{v.wins} wins of {v.settled} finished</div>
                                        </div>))}
                                </div>
                                <div className="overflow-x-auto"><table className="w-full text-sm">
                                    <thead><tr>{['Contract', 'Opened', 'Premium', 'IV at open', 'Actual swings', 'Biggest stock drop', 'Days it traded', 'Actual result', ...Object.keys(own.trades?.[0]?.policies || {})].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                                    <tbody>{(own.trades || []).map((t: any) => (
                                        <tr key={t.id} className="border-t border-slate-100 dark:border-slate-700">
                                            <td className={`${td} font-medium`}>{t.contract}</td><td className={td}>{t.opened}</td><td className={td}>{usd(t.premium * 100)}</td>
                                            <td className={td}>{t.ivAtOpen == null ? '—' : `${t.ivAtOpen}%`}</td><td className={td}>{t.rv20AtOpen == null ? '—' : `${t.rv20AtOpen}%`}</td>
                                            <td className={td}>{t.maxDropPct == null ? '—' : `${t.maxDropPct}%`}</td><td className={td}>{t.optionTradeDays}</td>
                                            <td className={td}>{t.actual.pnl == null ? 'open' : `${usd(t.actual.pnl)} (${t.actual.reason || t.actual.status})`}</td>
                                            {Object.values(t.policies).map((p: any, i) => <td key={i} className={td}>{p.open ? 'open' : `${usd(p.pnl)} · ${p.reason}`}</td>)}
                                        </tr>))}</tbody>
                                </table></div>
                            </>)}
                        </div>

                        <div className={card}>
                            <h3 className="font-semibold text-slate-900 dark:text-white mb-1">Which put-selling rules worked? {csp?.at ? `(${day(csp.at)})` : ''}</h3>
                            {!csp ? <p className="text-sm text-slate-500">The first run is in progress; it then refreshes on the first Saturday of each month.</p> : (<>
                                <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
                                    {csp.symbols} stocks, a new put every week from {csp.from} to {csp.to} ({num(csp.entries)} test trades). <b>Delta</b> = roughly the chance the put ends up in trouble
                                    (0.15 = safer and pays less, 0.30 = pays more and riskier). <b>Profit over cash</b> = return on the money set aside, minus what it would have earned in T-bills (4%/yr).
                                    To pass: 100+ trades, 40+ weeks, profit over cash in both old and recent data, profit factor above 1.15, Sharpe above 1, and the luck check.
                                    {' '}<b>{csp.passed} passed, {csp.promising} promising</b> of {csp.variants?.length} rule sets.
                                </p>
                                <div className="overflow-x-auto"><table className="w-full text-sm">
                                    <thead><tr>{['Result', 'Delta', 'Exit rule', 'Which stocks', 'Trades', 'Win rate', 'Profit factor', 'Yearly return on cash set aside', 'Profit over cash: old', 'Profit over cash: recent', 'Ended up owning shares', 'Worst trade', 'Luck check'].map(h => <th key={h} className={th}>{h}</th>)}</tr></thead>
                                    <tbody>{(csp.variants || []).slice(0, 40).map((v: any, i: number) => (
                                        <tr key={i} className="border-t border-slate-100 dark:border-slate-700" title={v.why}>
                                            <td className={td}><span className={`px-2 py-0.5 rounded-full text-xs ${v.verdict === 'pass' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300' : v.verdict === 'promising' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300' : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'}`}>{v.verdict}</span></td>
                                            <td className={td}>{v.delta}</td><td className={td}>{exitLabel[v.exit] || v.exit}</td><td className={td}>{filterLabel[v.filter] || v.filter}</td>
                                            <td className={td}>{num(v.trades)}</td><td className={td}>{v.winPct == null ? '—' : `${v.winPct}%`}</td><td className={td}>{v.profitFactor ?? '—'}</td>
                                            <td className={td}>{v.annualizedRocPct == null ? '—' : `${v.annualizedRocPct}%`}</td>
                                            <td className={td}>{pct(v.train.avgExRocPct)} <span className="text-slate-400">(t {v.train.t ?? '—'})</span></td>
                                            <td className={td}>{pct(v.holdout.avgExRocPct)} <span className="text-slate-400">(t {v.holdout.t ?? '—'})</span></td>
                                            <td className={td}>{v.assignedPct == null ? '—' : `${v.assignedPct}%`}</td>
                                            <td className={td}>{v.worstTradePnl == null ? '—' : usd(v.worstTradePnl)}</td><td className={td}>{v.fdrQ}</td>
                                        </tr>))}</tbody>
                                </table></div>
                                <p className="text-xs text-slate-500 mt-2">Sorted by recent results. Hover a row to see why it passed or failed. Showing the top 40.</p>
                            </>)}
                        </div>
                    </div>
                );
            })()}

            {tab === 'AI spend' && (
                <div className="space-y-4">
                    <p className="text-sm text-slate-700 dark:text-slate-300">
                        <b>In plain words:</b> what the paid AI (Gemini) has cost. &ldquo;pulse&rdquo; = reading news for held and candidate stocks,
                        &ldquo;news&rdquo; = the one-time sorting of 3 years of headlines, &ldquo;oracle_shadow&rdquo; = the AI contest, &ldquo;research_agent&rdquo; = Saturday idea writing,
                        &ldquo;mistake_review&rdquo; = the daily look at losing trades, &ldquo;enquiry_chat&rdquo; = the chat page.
                        The local AI on this PC is free and isn&apos;t listed.
                    </p>
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
