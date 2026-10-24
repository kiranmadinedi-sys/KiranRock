'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { getApiBaseUrl } from '../config';

/** Reports (2026-10-24): history of every scheduled report — also sent to Telegram. */

type Row = { id: number; kind: string; title: string; created_at: string; personal: boolean };

// Bodies are Telegram text we generate: HTML (b/i/code only) or Markdown (*bold*).
// Render a safe subset only — never arbitrary HTML.
function toSafeHtml(body: string, format: string): string {
    if (format === 'html') return body.replace(/<(?!\/?(b|i|code|pre)>)[^>]*>/g, '');
    const esc = body.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return esc.replace(/\*([^*\n]+)\*/g, '<b>$1</b>');
}

export default function ReportsPage() {
    const [kinds, setKinds] = useState<Record<string, string>>({});
    const [rows, setRows] = useState<Row[]>([]);
    const [kind, setKind] = useState<string>('');
    const [selected, setSelected] = useState<any>(null);
    const [error, setError] = useState<string | null>(null);
    const headers = () => ({ 'Authorization': `Bearer ${localStorage.getItem('token')}` });

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/reports?limit=300${kind ? `&kind=${kind}` : ''}`, { headers: headers() });
                if (!res.ok) throw new Error(`Load failed: ${res.status}`);
                const d = await res.json();
                setKinds(d.kinds); setRows(d.reports); setError(null);
                if (d.reports.length && (!selected || !d.reports.some((r: Row) => r.id === selected.id))) open(d.reports[0].id);
                if (!d.reports.length) setSelected(null);
            } catch (e: any) { setError(e.message); }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [kind]);

    const open = async (id: number) => {
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/reports/${id}`, { headers: headers() });
            if (!res.ok) throw new Error(`Load failed: ${res.status}`);
            setSelected(await res.json());
        } catch (e: any) { setError(e.message); }
    };

    const fmt = (s: string) => new Date(s).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const chip = (active: boolean) => `px-3 py-1 rounded-full text-sm border ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700'}`;

    return (
        <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 dark:from-gray-900 dark:to-gray-800">
            <main className="max-w-7xl mx-auto px-4 py-6 space-y-4">
                <div>
                    <h1 className="text-3xl font-bold text-gray-800 dark:text-white">📚 Reports</h1>
                    <p className="text-gray-600 dark:text-gray-400 mt-2">
                        Every scheduled report, kept permanently — the Saturday study &amp; strategy review, weekly scoreboard, daily summaries, macro briefings.
                        Friday performance reports are on the <Link href="/performance" className="text-blue-600 underline">Performance</Link> page.
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <button className={chip(!kind)} onClick={() => setKind('')}>All</button>
                    {Object.entries(kinds).map(([k, label]) => <button key={k} className={chip(kind === k)} onClick={() => setKind(k)}>{label}</button>)}
                </div>
                {error && <div className="text-red-600">Error: {error}</div>}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 max-h-[75vh] overflow-y-auto">
                        {rows.length === 0 && <div className="p-4 text-slate-500">No reports yet — they appear here as they are sent.</div>}
                        {rows.map(r => (
                            <button key={r.id} onClick={() => open(r.id)}
                                className={`w-full text-left px-4 py-3 border-b border-slate-100 dark:border-slate-700 ${selected?.id === r.id ? 'bg-blue-50 dark:bg-slate-700' : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'}`}>
                                <div className="text-sm font-medium text-slate-900 dark:text-white">{r.title}</div>
                                <div className="text-xs text-slate-500 dark:text-slate-400">{fmt(r.created_at)} · {kinds[r.kind] || r.kind}{r.personal ? ' · yours' : ''}</div>
                            </button>
                        ))}
                    </div>
                    <div className="md:col-span-2 bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 min-h-[300px]">
                        {selected ? (<>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{selected.title}</h2>
                            <div className="text-xs text-slate-500 dark:text-slate-400 mb-4">{fmt(selected.created_at)}</div>
                            <div className="whitespace-pre-wrap break-words text-sm text-slate-800 dark:text-slate-200 leading-relaxed"
                                dangerouslySetInnerHTML={{ __html: toSafeHtml(selected.body, selected.format) }} />
                        </>) : <div className="text-slate-500">Select a report.</div>}
                    </div>
                </div>
            </main>
        </div>
    );
}
