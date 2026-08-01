'use client';

import React, { useEffect, useState } from 'react';
import { getApiBaseUrl } from '../config';

function usd(v: number) {
    return '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signedUsd(v: number) {
    return (v >= 0 ? '+$' : '-$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface Status {
    enabled: boolean;
    config: { allocation_amount: string | number } | null;
    openPositions: number;
    positions: any[];
    todayPnl: string | number;
}

// Separate, clearly-labeled panel for Blitz (intraday) positions/P&L — deliberately
// not merged into the swing holdings list or portfolio totals above. Blitz keeps its
// own capital pool and its own tables (intraday_positions/intraday_trades); this panel
// just gives users one place to notice it exists without conflating the two strategies'
// numbers, since swing's headline Portfolio Value/P&L figures are computed purely from
// `holdings` and shouldn't silently start including Blitz's separate allocation.
export default function BlitzPortfolioSection() {
    const [status, setStatus] = useState<Status | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const token = localStorage.getItem('token');
                if (!token) return;
                const res = await fetch(`${getApiBaseUrl()}/api/intraday/status`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (res.ok && !cancelled) setStatus(await res.json());
            } catch {
                // silent — this is a secondary panel, not the primary portfolio view
            }
        };
        load();
        const interval = setInterval(load, 30000);
        return () => { cancelled = true; clearInterval(interval); };
    }, []);

    // Hide entirely for users who've never touched Blitz — no clutter for swing-only accounts.
    if (!status || (!status.enabled && status.openPositions === 0)) return null;

    const allocation = Number(status.config?.allocation_amount) || 0;
    const deployed = (status.positions || []).reduce((sum, p) => {
        const value = Number(p.market_value) || Number(p.quantity) * Number(p.average_price) || 0;
        return sum + value;
    }, 0);
    const todayPnl = Number(status.todayPnl) || 0;

    return (
        <div className="mx-4 mt-3 mb-2 rounded-xl border-2 border-amber-500/30 bg-amber-500/5 px-4 py-3">
            <div className="flex items-center justify-between mb-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                    ⚡ Blitz (Intraday) — separate from Swing above
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold ${status.enabled ? 'bg-green-500 text-white' : 'bg-gray-400 text-white'}`}>
                    {status.enabled ? 'ACTIVE' : 'PAUSED'}
                </span>
            </div>
            <div className="grid grid-cols-3 gap-3 mb-2">
                <div>
                    <div className="text-[9px] text-[var(--color-text-secondary)] uppercase tracking-wider">Today's P/L</div>
                    <div className={`text-xs font-bold tabular-nums ${todayPnl >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                        {signedUsd(todayPnl)}
                    </div>
                </div>
                <div>
                    <div className="text-[9px] text-[var(--color-text-secondary)] uppercase tracking-wider">Open Positions</div>
                    <div className="text-xs font-bold tabular-nums text-[var(--color-text-primary)]">{status.openPositions}</div>
                </div>
                <div>
                    <div className="text-[9px] text-[var(--color-text-secondary)] uppercase tracking-wider">Capital Used</div>
                    <div className="text-xs font-bold tabular-nums text-[var(--color-text-primary)]">
                        {usd(deployed)} / {usd(allocation)}
                    </div>
                </div>
            </div>
            <a href="/intraday" className="text-[11px] font-semibold text-amber-600 dark:text-amber-400 hover:underline">
                View full Blitz dashboard →
            </a>
        </div>
    );
}
