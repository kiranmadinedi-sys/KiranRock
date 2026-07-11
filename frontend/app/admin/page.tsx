"use client";
import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl } from '../config';

interface AdminUser {
    id: string;
    username: string;
    email: string | null;
    fullName: string | null;
    isActive: boolean;
    isAdmin: boolean;
    aiTradingEnabled: boolean;
    createdAt: string;
    lastLogin: string | null;
    hasOwnAlpacaCreds: boolean;
    broker: string;
    tradeCount: number;
    lastTradeDate: string | null;
    loginCountTotal: number;
    loginCount30d: number;
    loginCount7d: number;
    mostRecentIp: string | null;
    location: { city: string | null; region: string | null; country: string | null; isp: string | null; note?: string } | null;
    portfolio: {
        totalPortfolioValue: number;
        totalInvested: number;
        totalDeposited: number;
        totalWithdrawn: number;
        cashBalance: number;
        totalHoldingsValue: number;
        overallPL: number;
        overallReturn: number;
        totalRealizedPL: number;
        totalUnrealizedPL: number;
        numberOfPositions: number;
    } | null;
    readiness: {
        ready: boolean;
        reason: string;
        blockers: Record<string, number>;
        advisory: Record<string, number>;
    } | null;
}

function usd(v: number | null | undefined) {
    if (v == null || Number.isNaN(v)) return '—';
    return (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(v: number | null | undefined) {
    if (v == null || Number.isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}
function fmtDate(v: string | null) {
    if (!v) return 'Never';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function AdminPage() {
    const router = useRouter();
    const [token, setToken] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [accessDenied, setAccessDenied] = useState(false);
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [statusActionLoading, setStatusActionLoading] = useState(false);
    const [statusActionMsg, setStatusActionMsg] = useState<string | null>(null);

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        if (!storedToken) { router.push('/login'); return; }
        setToken(storedToken);
    }, [router]);

    useEffect(() => {
        if (!token) return;
        (async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } });
                if (res.status === 401) { router.push('/login'); return; }
                if (res.status === 403) { setAccessDenied(true); setLoading(false); return; }
                if (!res.ok) throw new Error('Failed to load users');
                const data = await res.json();
                setUsers(data.users || []);
                if (data.users?.length > 0) setSelectedId(data.users[0].id);
            } catch (e: any) {
                setError(e.message || 'Failed to load admin data');
            } finally {
                setLoading(false);
            }
        })();
    }, [token, router]);

    const selected = users.find(u => u.id === selectedId) || null;

    const handleToggleActive = async (user: AdminUser) => {
        const action = user.isActive ? 'deactivate' : 'reactivate';
        if (user.isActive) {
            const ok = window.confirm(
                `Deactivate ${user.fullName || user.username}?\n\nThis blocks their login and stops the AI bot from trading for them. All their data (trades, portfolio history) stays intact and this is fully reversible.`
            );
            if (!ok) return;
        }
        setStatusActionLoading(true);
        setStatusActionMsg(null);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/admin/users/${user.id}/${action}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || `Failed to ${action}`);
            setUsers(prev => prev.map(u => u.id === user.id ? { ...u, isActive: action === 'reactivate' } : u));
            setStatusActionMsg(`${user.username} ${action}d.`);
        } catch (e: any) {
            setStatusActionMsg(e.message || `Failed to ${action}`);
        } finally {
            setStatusActionLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-primary)]">
                <div className="text-[var(--color-text-secondary)] text-sm">Loading admin overview…</div>
            </div>
        );
    }

    if (accessDenied) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg-primary)] px-4">
                <div className="text-center">
                    <div className="text-4xl mb-3">🔒</div>
                    <div className="text-lg font-bold text-[var(--color-text-primary)]">Access Denied</div>
                    <p className="text-sm text-[var(--color-text-secondary)] mt-1">This page is restricted to the account owner.</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[var(--color-bg-primary)] safe-bottom">
            <div className="max-w-5xl mx-auto px-4 py-6 lg:py-8">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--color-text-secondary)] mb-1">Admin</p>
                <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mb-1">All Users</h1>
                <p className="text-sm text-[var(--color-text-secondary)] mb-6">{users.length} account{users.length !== 1 ? 's' : ''} — select one to see their portfolio</p>

                {error && (
                    <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500 text-red-600 text-sm">{error}</div>
                )}

                {/* ── User list — tap/click to select ── */}
                <div className="rounded-xl border border-[var(--color-border)] overflow-hidden mb-6">
                    {users.map((u, i) => {
                        const isSelected = u.id === selectedId;
                        return (
                            <button
                                key={u.id}
                                onClick={() => setSelectedId(u.id)}
                                className={`w-full text-left px-4 py-3 flex items-center justify-between gap-3 transition-colors ${
                                    i > 0 ? 'border-t border-[var(--color-border)]' : ''
                                } ${isSelected ? 'bg-[var(--color-accent)]/10' : 'hover:bg-[var(--color-bg-tertiary)]'}`}
                            >
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-semibold text-[var(--color-text-primary)] truncate">
                                            {u.fullName || u.username}
                                        </span>
                                        {u.isAdmin && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-[var(--color-accent)] text-white flex-shrink-0">ADMIN</span>}
                                        {!u.isActive && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-gray-500/20 text-[var(--color-text-secondary)] flex-shrink-0">INACTIVE</span>}
                                        {u.readiness && !u.readiness.ready && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-red-500/15 text-red-600 flex-shrink-0">⚠ SENTINEL</span>}
                                    </div>
                                    <div className="text-xs text-[var(--color-text-secondary)] truncate mt-0.5">
                                        {u.username} · {u.broker} · last login {fmtDate(u.lastLogin)}
                                    </div>
                                </div>
                                <div className="text-right flex-shrink-0">
                                    <div className="font-bold text-sm text-[var(--color-text-primary)] tabular-nums">
                                        {usd(u.portfolio?.totalPortfolioValue)}
                                    </div>
                                    <div className={`text-xs font-semibold tabular-nums ${(u.portfolio?.overallPL ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                        {pct(u.portfolio?.overallReturn)}
                                    </div>
                                </div>
                            </button>
                        );
                    })}
                </div>

                {/* ── Selected user's full detail ── */}
                {selected && (
                    <div className="rounded-xl border border-[var(--color-border)] p-4 lg:p-6">
                        <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
                            <div>
                                <h2 className="text-lg font-bold text-[var(--color-text-primary)]">{selected.fullName || selected.username}</h2>
                                <p className="text-xs text-[var(--color-text-secondary)]">{selected.email || 'no email on file'}</p>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold px-2 py-1 rounded-full bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]">
                                    {selected.broker}
                                </span>
                                {!selected.isAdmin && (
                                    <button
                                        onClick={() => handleToggleActive(selected)}
                                        disabled={statusActionLoading}
                                        className={`text-xs font-bold px-3 py-1.5 rounded-full transition-opacity disabled:opacity-40 ${
                                            selected.isActive ? 'bg-red-500 text-white' : 'bg-green-500 text-white'
                                        }`}
                                    >
                                        {selected.isActive ? 'Deactivate' : 'Reactivate'}
                                    </button>
                                )}
                            </div>
                        </div>
                        {!selected.isActive && (
                            <div className="mb-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500 text-red-600 text-xs font-semibold">
                                This account is deactivated — login and bot trading are blocked.
                            </div>
                        )}
                        {statusActionMsg && (
                            <div className="mb-4 text-xs text-[var(--color-text-secondary)]">{statusActionMsg}</div>
                        )}

                        {/* Portfolio */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-5">
                            <Stat label="Portfolio Value" value={usd(selected.portfolio?.totalPortfolioValue)} />
                            <Stat label="Cash" value={usd(selected.portfolio?.cashBalance)} />
                            <Stat label="Holdings Value" value={usd(selected.portfolio?.totalHoldingsValue)} />
                            <Stat label="Deposited" value={usd(selected.portfolio?.totalDeposited)} />
                            <Stat label="Withdrawn" value={usd(selected.portfolio?.totalWithdrawn)} />
                            <Stat label="Open Positions" value={String(selected.portfolio?.numberOfPositions ?? '—')} />
                            <Stat label="Overall P/L" value={usd(selected.portfolio?.overallPL)} color={(selected.portfolio?.overallPL ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'} />
                            <Stat label="Overall Return" value={pct(selected.portfolio?.overallReturn)} color={(selected.portfolio?.overallReturn ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'} />
                            <Stat label="Realized P/L" value={usd(selected.portfolio?.totalRealizedPL)} color={(selected.portfolio?.totalRealizedPL ?? 0) >= 0 ? 'text-green-500' : 'text-red-500'} />
                        </div>

                        {/* Usage */}
                        <div className="border-t border-[var(--color-border)] pt-4">
                            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Usage</p>
                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                <Stat label="Trades Placed" value={String(selected.tradeCount)} />
                                <Stat label="Last Trade" value={fmtDate(selected.lastTradeDate)} small />
                                <Stat label="Logins (7d)" value={String(selected.loginCount7d)} />
                                <Stat label="Logins (30d)" value={String(selected.loginCount30d)} />
                                <Stat label="Logins (all-time)" value={String(selected.loginCountTotal)} />
                                <Stat label="Last Login" value={fmtDate(selected.lastLogin)} small />
                            </div>
                        </div>

                        {/* SENTINEL — read-only, same check their own live-readiness page runs */}
                        <div className="border-t border-[var(--color-border)] pt-4 mt-4">
                            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">SENTINEL — Live Readiness</p>
                            {selected.readiness ? (
                                <div>
                                    <div className={`inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full mb-2 ${
                                        selected.readiness.ready ? 'bg-green-500/15 text-green-600' : 'bg-red-500/15 text-red-600'
                                    }`}>
                                        {selected.readiness.ready ? '✓ Ready' : '⚠ Blocked'}
                                    </div>
                                    <div className="text-xs text-[var(--color-text-secondary)] mb-2">{selected.readiness.reason}</div>
                                    {!selected.readiness.ready && (
                                        <div className="flex flex-wrap gap-1.5">
                                            {Object.entries(selected.readiness.blockers).filter(([, v]) => v > 0).map(([k, v]) => (
                                                <span key={k} className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500/10 text-red-600">
                                                    {k}: {v}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="text-sm text-[var(--color-text-secondary)]">Readiness check unavailable.</div>
                            )}
                        </div>

                        {/* Location */}
                        <div className="border-t border-[var(--color-border)] pt-4 mt-4">
                            <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Last Known Location</p>
                            {selected.mostRecentIp ? (
                                <div className="text-sm text-[var(--color-text-primary)]">
                                    <div>{[selected.location?.city, selected.location?.region, selected.location?.country].filter(Boolean).join(', ') || selected.location?.note || 'Unknown'}</div>
                                    <div className="text-xs text-[var(--color-text-secondary)] mt-0.5">IP: {selected.mostRecentIp}{selected.location?.isp ? ` · ${selected.location.isp}` : ''}</div>
                                    <div className="text-[10px] text-[var(--color-text-secondary)] mt-1">Approximate, from IP registration — not a precise address.</div>
                                </div>
                            ) : (
                                <div className="text-sm text-[var(--color-text-secondary)]">No login recorded since tracking began.</div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

function Stat({ label, value, color, small }: { label: string; value: string; color?: string; small?: boolean }) {
    return (
        <div>
            <div className="text-[10px] text-[var(--color-text-secondary)] uppercase tracking-wide mb-0.5">{label}</div>
            <div className={`font-bold tabular-nums ${small ? 'text-xs' : 'text-sm'} ${color || 'text-[var(--color-text-primary)]'}`}>{value}</div>
        </div>
    );
}
