"use client";
import React, { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { getApiBaseUrl } from '../config';
import StockSearch from '../components/StockSearch';

interface ActiveStock {
    symbol: string;
    name: string;
    sector: string | null;
    aiScore: number | null;
    recommendation: string | null;
    price: number;
    changeAmount: number;
    changePercent: number;
    volume: number;
    marketCap: number | null;
    avgVolume3M: number | null;
    week52Low: number | null;
    week52High: number | null;
    week52ChangePercent: number | null;
    sparkline: number[];
}

interface Quote {
    symbol: string;
    regularMarketPrice: number;
    regularMarketChange: number;
    regularMarketChangePercent: number;
    regularMarketVolume: number;
}

interface NewsArticle {
    headline: string;
    source: string;
    url: string;
    thumbnail: string | null;
    published_at: string;
}

interface EarningsResult {
    symbol: string;
    name: string;
    date: string;
    quarter: number;
    year: number;
    epsActual: number;
    epsEstimate: number | null;
    epsSurprisePercent: number | null;
    revenueActual: number | null;
    revenueEstimate: number | null;
    beat: boolean | null;
}

type Tab = 'most-active' | 'top-gainers' | 'top-losers' | '52w-gainers' | '52w-losers';
const TABS: { key: Tab; label: string }[] = [
    { key: 'most-active', label: 'Most Active' },
    { key: 'top-gainers', label: 'Top Gainers' },
    { key: 'top-losers', label: 'Top Losers' },
    { key: '52w-gainers', label: '52W Gainers' },
    { key: '52w-losers', label: '52W Losers' },
];

type SortKey = 'symbol' | 'name' | 'sector' | 'price' | 'changeAmount' | 'changePercent' | 'volume'
    | 'avgVolume3M' | 'marketCap' | 'week52ChangePercent' | 'aiScore';
const TEXT_SORT_KEYS: SortKey[] = ['symbol', 'name', 'sector'];
const COLUMNS: { key: SortKey; label: string; align: 'left' | 'right' }[] = [
    { key: 'symbol', label: 'Symbol', align: 'left' },
    { key: 'name', label: 'Name', align: 'left' },
    { key: 'sector', label: 'Sector', align: 'left' },
    { key: 'price', label: 'Price', align: 'right' },
    { key: 'changeAmount', label: 'Change', align: 'right' },
    { key: 'changePercent', label: 'Change %', align: 'right' },
    { key: 'volume', label: 'Volume', align: 'right' },
    { key: 'avgVolume3M', label: 'Avg Vol (3M)', align: 'right' },
    { key: 'marketCap', label: 'Market Cap', align: 'right' },
    { key: 'week52ChangePercent', label: '52 Wk Change %', align: 'right' },
    { key: 'aiScore', label: 'AI Score', align: 'right' },
];

function usd(v: number) {
    return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function signed(v: number, suffix = '') {
    return (v >= 0 ? '+' : '') + v.toFixed(2) + suffix;
}
function fmtVolume(v: number) {
    if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
    if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
    return String(v);
}
function fmtMarketCap(v: number | null) {
    if (v == null) return '—';
    if (v >= 1_000_000_000_000) return '$' + (v / 1_000_000_000_000).toFixed(2) + 'T';
    if (v >= 1_000_000_000) return '$' + (v / 1_000_000_000).toFixed(2) + 'B';
    if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M';
    return '$' + v.toLocaleString();
}
function fmtRelativeTime(iso: string) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}
function fmtRevenue(v: number | null) {
    if (v == null) return '—';
    if (v >= 1_000_000_000) return '$' + (v / 1_000_000_000).toFixed(2) + 'B';
    if (v >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M';
    return '$' + v.toLocaleString();
}

function ScoreBadge({ score }: { score: number | null }) {
    if (score == null) return <span className="text-[var(--color-text-secondary)]">—</span>;
    return (
        <span className={`px-2 py-0.5 text-xs font-bold rounded-full ${
            score >= 80 ? 'bg-green-500/15 text-green-600' : score >= 60 ? 'bg-yellow-500/15 text-yellow-600' : 'bg-gray-500/15 text-[var(--color-text-secondary)]'
        }`}>
            {score}
        </span>
    );
}

const SECTOR_ICON: Record<string, string> = {
    'Technology': '💻',
    'Healthcare': '🏥',
    'Financial Services': '🏦',
    'Financials': '🏦',
    'Energy': '⚡',
    'Industrials': '🏭',
    'Communication Services': '📡',
    'Consumer Discretionary': '🛍️',
    'Consumer Cyclical': '🛍️',
    'Consumer Staples': '🛒',
    'Consumer Defensive': '🛒',
    'Real Estate': '🏠',
    'Materials': '⛏️',
    'Basic Materials': '⛏️',
    'Utilities': '💡',
};
function sectorIcon(sector: string | null) {
    if (!sector) return '📊';
    return SECTOR_ICON[sector] || '📊';
}
const RANK_MEDAL = ['🥇', '🥈', '🥉'];

function Sparkline({ points }: { points: number[] }) {
    if (points.length < 2) return <span className="text-[var(--color-text-secondary)]">—</span>;
    const w = 64, h = 24, pad = 2;
    const min = Math.min(...points), max = Math.max(...points);
    const range = max - min || 1;
    const step = (w - pad * 2) / (points.length - 1);
    const coords = points.map((p, i) => `${(pad + i * step).toFixed(1)},${(h - pad - ((p - min) / range) * (h - pad * 2)).toFixed(1)}`);
    const up = points[points.length - 1] >= points[0];
    return (
        <svg width={w} height={h} className="inline-block align-middle">
            <polyline points={coords.join(' ')} fill="none" stroke={up ? 'rgb(34 197 94)' : 'rgb(239 68 68)'} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
    );
}

function ChangePill({ amount, percent }: { amount: number; percent: number }) {
    const up = amount >= 0;
    return (
        <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold tabular-nums ${
            up ? 'bg-green-500/12 text-green-600' : 'bg-red-500/12 text-red-500'
        }`}>
            <span className="text-[10px] leading-none">{up ? '▲' : '▼'}</span>
            {signed(percent, '%')}
        </span>
    );
}

/** Auto-rotating single-item carousel — pauses on hover, always reachable via arrows/dots. */
function Carousel<T,>({ items, renderItem, intervalMs = 5000 }: { items: T[]; renderItem: (item: T) => React.ReactNode; intervalMs?: number }) {
    const [index, setIndex] = useState(0);
    const [paused, setPaused] = useState(false);

    useEffect(() => { setIndex(0); }, [items.length]);

    useEffect(() => {
        if (paused || items.length <= 1) return;
        const t = setInterval(() => setIndex(i => (i + 1) % items.length), intervalMs);
        return () => clearInterval(t);
    }, [paused, items.length, intervalMs]);

    if (items.length === 0) return null;

    return (
        <div onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}>
            {/* Arrows sit beside the card in normal flow, not overlaid on top of it — an
                absolutely-positioned arrow was covering card text on narrow mobile widths
                (e.g. clipping "EPS" down to "S" on the Earnings card) (2026-07-13). */}
            <div className="flex items-center gap-1.5">
                {items.length > 1 && (
                    <button
                        onClick={() => setIndex(i => (i - 1 + items.length) % items.length)}
                        aria-label="Previous"
                        className="flex-shrink-0 w-7 h-7 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] flex items-center justify-center text-sm hover:text-[var(--color-text-primary)]"
                    >‹</button>
                )}
                <div className="flex-1 min-w-0">{renderItem(items[index])}</div>
                {items.length > 1 && (
                    <button
                        onClick={() => setIndex(i => (i + 1) % items.length)}
                        aria-label="Next"
                        className="flex-shrink-0 w-7 h-7 rounded-full border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] flex items-center justify-center text-sm hover:text-[var(--color-text-primary)]"
                    >›</button>
                )}
            </div>
            {items.length > 1 && (
                <div className="flex justify-center gap-1.5 mt-2">
                    {items.map((_, i) => (
                        <button
                            key={i}
                            onClick={() => setIndex(i)}
                            aria-label={`Go to slide ${i + 1}`}
                            className={`h-1.5 rounded-full transition-all ${i === index ? 'w-5 bg-[var(--color-accent)]' : 'w-1.5 bg-[var(--color-border)]'}`}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

function EarningsCard({ e }: { e: EarningsResult }) {
    const beat = e.beat;
    const maxEps = Math.max(Math.abs(e.epsActual), Math.abs(e.epsEstimate || 0), 0.01);
    return (
        <div className={`rounded-xl border overflow-hidden ${beat === true ? 'border-green-500/30' : beat === false ? 'border-red-500/30' : 'border-[var(--color-border)]'}`}>
            <div className={`px-4 py-2.5 flex items-center justify-between ${beat === true ? 'bg-green-500/10' : beat === false ? 'bg-red-500/10' : 'bg-[var(--color-bg-secondary)]'}`}>
                <div>
                    <span className="font-bold text-[var(--color-text-primary)]">{e.symbol}</span>
                    <span className="text-xs text-[var(--color-text-secondary)] ml-2">Q{e.quarter} {e.year}</span>
                </div>
                {beat != null && (
                    <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${beat ? 'bg-green-500/20 text-green-600' : 'bg-red-500/20 text-red-500'}`}>
                        {beat ? '🚀 Beat' : '📉 Miss'} {e.epsSurprisePercent != null ? signed(e.epsSurprisePercent, '%') : ''}
                    </span>
                )}
            </div>
            <div className="p-4">
                <p className="text-sm text-[var(--color-text-secondary)] truncate mb-3">{e.name}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
                    <div>
                        <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)] mb-1">EPS Actual vs Estimate</p>
                        <div className="flex items-end gap-2 h-10">
                            <div className="flex-1 flex flex-col items-center gap-0.5">
                                <div className="w-full bg-[var(--color-bg-secondary)] rounded-t flex items-end" style={{ height: '28px' }}>
                                    <div className="w-full bg-gray-400/50 rounded-t" style={{ height: `${Math.min(100, (Math.abs(e.epsEstimate || 0) / maxEps) * 100)}%` }} />
                                </div>
                                <span className="text-[10px] text-[var(--color-text-secondary)]">Est {e.epsEstimate != null ? e.epsEstimate.toFixed(2) : '—'}</span>
                            </div>
                            <div className="flex-1 flex flex-col items-center gap-0.5">
                                <div className="w-full bg-[var(--color-bg-secondary)] rounded-t flex items-end" style={{ height: '28px' }}>
                                    <div className={`w-full rounded-t ${beat === true ? 'bg-green-500' : beat === false ? 'bg-red-500' : 'bg-gray-400'}`} style={{ height: `${Math.min(100, (Math.abs(e.epsActual) / maxEps) * 100)}%` }} />
                                </div>
                                <span className="text-[10px] font-semibold text-[var(--color-text-primary)]">Act {e.epsActual.toFixed(2)}</span>
                            </div>
                        </div>
                    </div>
                    <div>
                        <p className="text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)] mb-1">Revenue</p>
                        <p className="font-semibold text-[var(--color-text-primary)] tabular-nums">{fmtRevenue(e.revenueActual)}</p>
                        <p className="text-[11px] text-[var(--color-text-secondary)]">Est {fmtRevenue(e.revenueEstimate)}</p>
                    </div>
                </div>
                <p className="text-[11px] text-[var(--color-text-secondary)] mt-3">Reported {new Date(e.date).toLocaleDateString()}</p>
            </div>
        </div>
    );
}

function NewsCard({ n }: { n: NewsArticle }) {
    return (
        <a
            href={n.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block rounded-xl border border-[var(--color-border)] overflow-hidden hover:border-[var(--color-accent)] transition-colors bg-[var(--color-card)]"
        >
            <div className="relative">
                {n.thumbnail && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={n.thumbnail} alt="" className="w-full aspect-video object-cover" loading="lazy" />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent" />
                <div className="absolute bottom-0 left-0 right-0 p-3">
                    <p className="text-sm font-bold text-white line-clamp-2 leading-snug drop-shadow">{n.headline}</p>
                </div>
            </div>
            <div className="px-3 py-2">
                <p className="text-[11px] text-[var(--color-text-secondary)]">{n.source} · {fmtRelativeTime(n.published_at)}</p>
            </div>
        </a>
    );
}

export default function MostActivePage() {
    const router = useRouter();
    const [token, setToken] = useState<string | null>(null);
    const [activeTab, setActiveTab] = useState<Tab>('most-active');
    const [stocks, setStocks] = useState<ActiveStock[]>([]);
    const [scanDate, setScanDate] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [sortKey, setSortKey] = useState<SortKey | null>(null);
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

    const [news, setNews] = useState<NewsArticle[]>([]);
    const [newsLoading, setNewsLoading] = useState(true);

    const [earnings, setEarnings] = useState<EarningsResult[]>([]);
    const [earningsLoading, setEarningsLoading] = useState(true);

    const [searchedSymbol, setSearchedSymbol] = useState<string | null>(null);
    const [quote, setQuote] = useState<Quote | null>(null);
    const [quoteLoading, setQuoteLoading] = useState(false);
    const [quoteError, setQuoteError] = useState<string | null>(null);

    const pulse = useMemo(() => {
        if (activeTab !== 'most-active' || stocks.length === 0) return null;
        const gainers = stocks.filter(s => s.changePercent > 0).length;
        const losers = stocks.filter(s => s.changePercent < 0).length;
        const avgChange = stocks.reduce((sum, s) => sum + s.changePercent, 0) / stocks.length;
        return { gainers, losers, avgChange };
    }, [stocks, activeTab]);

    const displayedStocks = useMemo(() => {
        if (!sortKey) return stocks;
        const isText = TEXT_SORT_KEYS.includes(sortKey);
        const sorted = [...stocks].sort((a, b) => {
            const av = a[sortKey], bv = b[sortKey];
            if (isText) return String(av || '').localeCompare(String(bv || ''));
            return (Number(av) || 0) - (Number(bv) || 0);
        });
        if (sortDir === 'desc') sorted.reverse();
        return sorted;
    }, [stocks, sortKey, sortDir]);

    const handleSort = (key: SortKey) => {
        if (sortKey === key) {
            setSortDir(d => d === 'asc' ? 'desc' : 'asc');
        } else {
            setSortKey(key);
            setSortDir(TEXT_SORT_KEYS.includes(key) ? 'asc' : 'desc');
        }
    };

    useEffect(() => {
        const storedToken = localStorage.getItem('token');
        if (!storedToken) { router.push('/login'); return; }
        setToken(storedToken);
    }, [router]);

    useEffect(() => {
        if (!token) return;
        setLoading(true);
        setSortKey(null);
        (async () => {
            try {
                const url = activeTab === 'most-active'
                    ? `${getApiBaseUrl()}/api/screener/most-active?limit=100`
                    : `${getApiBaseUrl()}/api/screener/movers?type=${activeTab}&limit=50`;
                const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
                if (res.status === 401) { router.push('/login'); return; }
                if (!res.ok) throw new Error('Failed to load stocks');
                const data = await res.json();
                setStocks(data.stocks || []);
                setScanDate(data.scanDate);
            } catch (e: any) {
                setError(e.message || 'Failed to load data');
            } finally {
                setLoading(false);
            }
        })();
    }, [token, activeTab, router]);

    useEffect(() => {
        if (!token) return;
        (async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/news-aggregation/aggregate`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (!res.ok) return;
                const data = await res.json();
                const withThumb = (data.news || []).filter((n: NewsArticle) => n.thumbnail).slice(0, 6);
                setNews(withThumb);
            } catch {
                // Non-critical widget — fail silently rather than blocking the page
            } finally {
                setNewsLoading(false);
            }
        })();
    }, [token]);

    useEffect(() => {
        if (!token) return;
        (async () => {
            try {
                const res = await fetch(`${getApiBaseUrl()}/api/screener/recent-earnings`, {
                    headers: { Authorization: `Bearer ${token}` }
                });
                if (!res.ok) return;
                const data = await res.json();
                setEarnings(data.results || []);
            } catch {
                // Non-critical widget — fail silently rather than blocking the page
            } finally {
                setEarningsLoading(false);
            }
        })();
    }, [token]);

    const handleSelectStock = async (symbol: string) => {
        const ticker = symbol.toUpperCase();
        setSearchedSymbol(ticker);
        setQuote(null);
        setQuoteError(null);
        setQuoteLoading(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/api/stocks/quote/${encodeURIComponent(ticker)}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            if (!res.ok) throw new Error('Quote lookup failed');
            const data = await res.json();
            if (!data.regularMarketPrice) throw new Error(`No data found for "${ticker}"`);
            setQuote(data);
        } catch (e: any) {
            setQuoteError(e.message || 'Lookup failed');
        } finally {
            setQuoteLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-[var(--color-bg-primary)] safe-bottom">
            <div className="max-w-5xl mx-auto px-4 py-6 lg:py-8">
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--color-text-secondary)] mb-1">Markets</p>
                <h1 className="text-2xl font-bold text-[var(--color-text-primary)] mb-1">Most Active Stocks</h1>
                <p className="text-sm text-[var(--color-text-secondary)] mb-4">
                    From our tracked universe{scanDate ? ` · scan date ${new Date(scanDate).toLocaleDateString()}` : ''}
                </p>

                {/* ── Tabs — right-edge fade hints that "52W Gainers/Losers" scrolls into
                     view on narrow screens, since the row was getting cut off with no
                     visual cue that more tabs existed (2026-07-13) ── */}
                <div className="relative mb-5">
                    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                        {TABS.map(t => (
                            <button
                                key={t.key}
                                onClick={() => setActiveTab(t.key)}
                                className={`flex-shrink-0 px-3.5 py-1.5 rounded-full text-sm font-semibold whitespace-nowrap border transition-colors ${
                                    activeTab === t.key
                                        ? 'bg-[var(--color-accent)] text-white border-[var(--color-accent)]'
                                        : 'border-[var(--color-border)] text-[var(--color-text-secondary)]'
                                }`}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                    <div className="pointer-events-none absolute right-0 top-0 bottom-1 w-8 bg-gradient-to-l from-[var(--color-bg-primary)] to-transparent" />
                </div>

                {/* ── Market pulse strip (Most Active tab only) ── */}
                {pulse && (
                    <div className="grid grid-cols-3 gap-2 mb-6">
                        <div className="rounded-xl border border-[var(--color-border)] bg-green-500/8 p-3 text-center">
                            <div className="text-lg font-bold text-green-600 tabular-nums">{pulse.gainers}</div>
                            <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)] font-semibold">Gainers</div>
                        </div>
                        <div className="rounded-xl border border-[var(--color-border)] bg-red-500/8 p-3 text-center">
                            <div className="text-lg font-bold text-red-500 tabular-nums">{pulse.losers}</div>
                            <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)] font-semibold">Losers</div>
                        </div>
                        <div className="rounded-xl border border-[var(--color-border)] p-3 text-center">
                            <div className={`text-lg font-bold tabular-nums ${pulse.avgChange >= 0 ? 'text-green-600' : 'text-red-500'}`}>
                                {signed(pulse.avgChange, '%')}
                            </div>
                            <div className="text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)] font-semibold">Avg Move</div>
                        </div>
                    </div>
                )}

                {/* ── Recent earnings + market news — auto-rotating, always manually reachable via arrows/dots.
                     Each rotation only re-renders this small subtree (React state, no window.scrollTo, no
                     remount), and card heights are fixed (aspect-video images, line-clamp headlines) so
                     rotating never reflows content below and disrupts someone mid-scroll (2026-07-13). ── */}
                {(earningsLoading || earnings.length > 0 || newsLoading || news.length > 0) && (
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                        <div>
                            <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Recent Earnings</p>
                            {earningsLoading ? (
                                <div className="text-sm text-[var(--color-text-secondary)]">Loading…</div>
                            ) : earnings.length > 0 ? (
                                <Carousel items={earnings} renderItem={e => <EarningsCard e={e} />} />
                            ) : (
                                <div className="rounded-xl border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-secondary)]">
                                    No earnings reported by tracked tickers in the last 14 days
                                </div>
                            )}
                        </div>
                        <div>
                            <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Latest Market News</p>
                            {newsLoading ? (
                                <div className="text-sm text-[var(--color-text-secondary)]">Loading…</div>
                            ) : news.length > 0 ? (
                                <Carousel items={news} renderItem={n => <NewsCard n={n} />} />
                            ) : (
                                <div className="rounded-xl border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-secondary)]">
                                    No news available right now
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {/* ── Ticker lookup — searches by symbol OR company name ── */}
                <div className="rounded-xl border border-[var(--color-border)] p-4 mb-6">
                    <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">Quote Lookup</p>
                    <p className="text-[11px] text-[var(--color-text-secondary)] mb-2">Search by ticker or company name</p>
                    <StockSearch onSelectStock={handleSelectStock} />

                    {quoteLoading && <div className="text-sm text-[var(--color-text-secondary)] mt-3">Looking up {searchedSymbol}…</div>}
                    {quoteError && <div className="text-sm text-red-500 mt-3">{quoteError}</div>}
                    {quote && !quoteLoading && (
                        <div className="mt-4 flex items-center justify-between flex-wrap gap-2">
                            <div>
                                <div className="text-lg font-bold text-[var(--color-text-primary)]">{quote.symbol}</div>
                                <div className="text-2xl font-bold text-[var(--color-text-primary)] tabular-nums">{usd(quote.regularMarketPrice)}</div>
                            </div>
                            <div className={`text-right font-semibold tabular-nums ${quote.regularMarketChange >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                <div>{signed(quote.regularMarketChange)} ({signed(quote.regularMarketChangePercent, '%')})</div>
                                <div className="text-xs text-[var(--color-text-secondary)] font-normal">Vol {fmtVolume(quote.regularMarketVolume || 0)}</div>
                            </div>
                        </div>
                    )}
                </div>

                {error && (
                    <div className="mb-4 p-3 rounded-xl bg-red-500/10 border border-red-500 text-red-600 text-sm">{error}</div>
                )}

                {loading ? (
                    <div className="text-sm text-[var(--color-text-secondary)]">Loading…</div>
                ) : (
                    <>
                        {/* ── Mobile: sort control + card list ── */}
                        <div className="lg:hidden flex items-center gap-2 mb-2">
                            <select
                                value={sortKey || ''}
                                onChange={e => e.target.value ? handleSort(e.target.value as SortKey) : setSortKey(null)}
                                className="flex-1 text-sm rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] px-2 py-1.5"
                            >
                                <option value="">Default order</option>
                                {COLUMNS.map(c => <option key={c.key} value={c.key}>Sort by {c.label}</option>)}
                            </select>
                            {sortKey && (
                                <button
                                    onClick={() => setSortDir(d => d === 'asc' ? 'desc' : 'asc')}
                                    className="px-3 py-1.5 rounded-lg border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text-secondary)]"
                                >
                                    {sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
                                </button>
                            )}
                        </div>
                        <div className="lg:hidden rounded-xl border border-[var(--color-border)] overflow-hidden divide-y divide-[var(--color-border)] bg-[var(--color-card)]">
                            {displayedStocks.map((s, i) => (
                                <div
                                    key={s.symbol}
                                    className="p-3.5 flex items-center gap-3 border-l-4"
                                    style={{ borderLeftColor: s.changeAmount >= 0 ? 'rgb(34 197 94 / 0.5)' : 'rgb(239 68 68 / 0.5)' }}
                                >
                                    <span className="w-6 flex-shrink-0 text-center text-[13px]">
                                        {!sortKey && RANK_MEDAL[i] ? RANK_MEDAL[i] : <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">{i + 1}</span>}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-bold text-[15px] text-[var(--color-text-primary)]">{s.symbol}</span>
                                            <ScoreBadge score={s.aiScore} />
                                        </div>
                                        <div className="text-xs text-[var(--color-text-secondary)] truncate mt-0.5">{s.name}</div>
                                        <div className="flex items-center gap-1.5 mt-1">
                                            {s.sector && (
                                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] font-medium">
                                                    {sectorIcon(s.sector)} {s.sector}
                                                </span>
                                            )}
                                            <span className="text-[11px] text-[var(--color-text-secondary)]">Vol {fmtVolume(s.volume)}</span>
                                        </div>
                                        <div className="flex items-center gap-2.5 mt-1 text-[10px] text-[var(--color-text-secondary)]">
                                            <span>Mkt Cap {fmtMarketCap(s.marketCap)}</span>
                                            {s.week52ChangePercent != null && (
                                                <span className={s.week52ChangePercent >= 0 ? 'text-green-600 font-semibold' : 'text-red-500 font-semibold'}>
                                                    52W {signed(s.week52ChangePercent, '%')}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="text-right flex-shrink-0 space-y-1">
                                        <Sparkline points={s.sparkline} />
                                        <div className="font-bold text-[15px] text-[var(--color-text-primary)] tabular-nums">{usd(s.price)}</div>
                                        <ChangePill amount={s.changeAmount} percent={s.changePercent} />
                                    </div>
                                </div>
                            ))}
                        </div>

                        {/* ── Desktop: sortable table ── */}
                        <div className="hidden lg:block rounded-xl border border-[var(--color-border)] overflow-x-auto">
                            <table className="w-full text-sm">
                                <thead>
                                    <tr className="border-b border-[var(--color-border)] text-left text-[10px] uppercase tracking-wide text-[var(--color-text-secondary)]">
                                        {COLUMNS.slice(0, 2).map(c => (
                                            <th key={c.key} className="px-3 py-2.5 text-left">
                                                <button
                                                    onClick={() => handleSort(c.key)}
                                                    className={`inline-flex items-center gap-1 hover:text-[var(--color-text-primary)] ${sortKey === c.key ? 'text-[var(--color-text-primary)]' : ''}`}
                                                >
                                                    {c.label}
                                                    <span className="text-[9px]">{sortKey === c.key ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                                                </button>
                                            </th>
                                        ))}
                                        <th className="px-3 py-2.5 text-left">Chart</th>
                                        {COLUMNS.slice(2).map(c => (
                                            <th key={c.key} className={`px-3 py-2.5 ${c.align === 'right' ? 'text-right' : 'text-left'}`}>
                                                <button
                                                    onClick={() => handleSort(c.key)}
                                                    className={`inline-flex items-center gap-1 hover:text-[var(--color-text-primary)] ${sortKey === c.key ? 'text-[var(--color-text-primary)]' : ''}`}
                                                >
                                                    {c.label}
                                                    <span className="text-[9px]">{sortKey === c.key ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                                                </button>
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {displayedStocks.map((s, i) => (
                                        <tr key={s.symbol} className={i > 0 ? 'border-t border-[var(--color-border)]' : ''}>
                                            <td className="px-3 py-2.5 font-bold text-[var(--color-text-primary)]">{s.symbol}</td>
                                            <td className="px-3 py-2.5 text-[var(--color-text-secondary)] max-w-[220px] truncate">{s.name}</td>
                                            <td className="px-3 py-2.5"><Sparkline points={s.sparkline} /></td>
                                            <td className="px-3 py-2.5 text-[var(--color-text-secondary)] text-xs">{s.sector ? `${sectorIcon(s.sector)} ${s.sector}` : '—'}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums">{usd(s.price)}</td>
                                            <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${s.changeAmount >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                {signed(s.changeAmount)}
                                            </td>
                                            <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${s.changePercent >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                {signed(s.changePercent, '%')}
                                            </td>
                                            <td className="px-3 py-2.5 text-right tabular-nums">{fmtVolume(s.volume)}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums">{s.avgVolume3M != null ? fmtVolume(s.avgVolume3M) : '—'}</td>
                                            <td className="px-3 py-2.5 text-right tabular-nums">{fmtMarketCap(s.marketCap)}</td>
                                            <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${s.week52ChangePercent == null ? '' : s.week52ChangePercent >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                                                {s.week52ChangePercent != null ? signed(s.week52ChangePercent, '%') : '—'}
                                            </td>
                                            <td className="px-3 py-2.5 text-right"><ScoreBadge score={s.aiScore} /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
