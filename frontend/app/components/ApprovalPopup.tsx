'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

interface ApprovalRequest {
    id: number;
    kind: string;
    title: string;
    message: string;
    created_at: string;
}

/**
 * Real-money approvals (2026-10-17): whenever the platform wants to change how a LIVE
 * account trades (a proven stock-picking method, enabling core holdings), it asks first.
 * This popup shows on every page until the user approves or rejects. "Later" hides it
 * for this browser session only; the request stays pending and Telegram reminds daily.
 */
export default function ApprovalPopup() {
    const [requests, setRequests] = useState<ApprovalRequest[]>([]);
    const [dismissed, setDismissed] = useState<number[]>([]);
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

    const load = async () => {
        const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
        if (!token) return;
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/approvals/pending`, { headers: { 'Authorization': `Bearer ${token}` } });
            if (!res.ok) return;
            const data = await res.json();
            setRequests(data.requests || []);
        } catch (_) { /* popup is best-effort; Telegram still reminds */ }
    };

    useEffect(() => {
        try { setDismissed(JSON.parse(sessionStorage.getItem('approvalsDismissed') || '[]')); } catch (_) { /* ignore */ }
        load();
        const t = setInterval(load, 60000);
        return () => clearInterval(t);
    }, []);

    const visible = requests.filter(r => !dismissed.includes(r.id));
    const current = visible[0];

    const decide = async (approve: boolean) => {
        if (!current) return;
        setBusy(true);
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`${getApiBaseUrl()}/api/approvals/${current.id}/${approve ? 'approve' : 'reject'}`, {
                method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Failed');
            setResult({
                ok: data.status !== 'failed',
                text: data.status === 'approved' ? `Approved — ${data.result}` : data.status === 'rejected' ? 'Rejected — nothing was changed.' : `Could not apply: ${data.result}`,
            });
            await load();
        } catch (e: any) {
            setResult({ ok: false, text: e.message || 'Failed' });
        } finally {
            setBusy(false);
        }
    };

    const later = () => {
        if (!current) return;
        const next = [...dismissed, current.id];
        setDismissed(next);
        try { sessionStorage.setItem('approvalsDismissed', JSON.stringify(next)); } catch (_) { /* ignore */ }
    };

    if (result) {
        return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4">
                <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-800 p-6 shadow-xl">
                    <p className={`text-sm ${result.ok ? 'text-green-700 dark:text-green-300' : 'text-red-700 dark:text-red-300'}`}>{result.text}</p>
                    <button onClick={() => setResult(null)} className="mt-5 px-5 py-2.5 rounded-xl font-medium bg-blue-600 text-white hover:bg-blue-700">OK</button>
                </div>
            </div>
        );
    }

    if (!current) return null;

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 px-4">
            <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-slate-800 p-6 shadow-xl">
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    🔔 Your approval is needed — real money{visible.length > 1 ? ` · 1 of ${visible.length}` : ''}
                </div>
                <h2 className="mt-2 text-lg font-semibold text-slate-900 dark:text-white">{current.title}</h2>
                <p className="mt-3 text-sm text-slate-600 dark:text-slate-300 whitespace-pre-line">{current.message}</p>
                <p className="mt-3 text-xs text-slate-400">Requested {new Date(current.created_at).toLocaleString()}</p>
                <div className="mt-5 flex flex-wrap gap-3">
                    <button disabled={busy} onClick={() => decide(true)} className="px-5 py-2.5 rounded-xl font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
                        {busy ? 'Working...' : 'Approve'}
                    </button>
                    <button disabled={busy} onClick={() => decide(false)} className="px-5 py-2.5 rounded-xl font-medium bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/40 dark:text-red-300 disabled:opacity-50">
                        Reject
                    </button>
                    <button disabled={busy} onClick={later} className="px-5 py-2.5 rounded-xl font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-300">
                        Later
                    </button>
                </div>
            </div>
        </div>
    );
}
